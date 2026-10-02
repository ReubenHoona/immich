import 'dart:async';

/// Limits how many uploads run at the same time based on the estimated time
/// remaining (ETA) of the uploads that are already in flight.
///
/// Concurrent uploads share the link, so a few multi-GB videos running side by
/// side each crawl and none of them finishes inside the time the OS gives a
/// backup run (immich-app/immich#30747). This gate keeps the link to a single
/// upload until that upload is provably close to done:
///
///  * the first upload always starts immediately;
///  * a further upload may start only when every in-flight upload has a
///    measured ETA below [maxEta];
///  * an in-flight upload has no ETA until it has reported progress for at
///    least [minSampleTime], so a freshly started upload blocks admission until
///    its throughput is known;
///  * [maxConcurrent] is a hard cap regardless of ETAs.
///
/// Throughput is measured over a sliding [rateWindow] of progress samples, so
/// the ETA follows the current link speed rather than the whole-file average.
class UploadEtaGate {
  UploadEtaGate({
    this.maxEta = const Duration(minutes: 5),
    this.maxConcurrent = 3,
    this.minSampleTime = const Duration(seconds: 3),
    this.rateWindow = const Duration(seconds: 10),
    this.pollInterval = const Duration(milliseconds: 500),
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now;

  /// A new upload is admitted only while every in-flight upload's ETA is below this.
  final Duration maxEta;

  /// Hard cap on uploads in flight, whatever their ETAs.
  final int maxConcurrent;

  /// How long an upload must have been reporting progress before its ETA counts.
  final Duration minSampleTime;

  /// Length of the sliding window the throughput is measured over.
  final Duration rateWindow;

  /// How often [acquire] re-checks the gate while waiting.
  final Duration pollInterval;

  final DateTime Function() _now;
  final Map<String, _InFlightUpload> _inFlight = {};

  /// Slots claimed by [tryReserve] whose upload has not called [begin] yet.
  /// They count as in flight with an unknown ETA, so nothing else is admitted
  /// while a worker is between waking up and starting its upload.
  int _reserved = 0;

  int get inFlightCount => _inFlight.length;

  Iterable<String> get inFlightIds => _inFlight.keys;

  /// The ETA of upload [id], or null when it is not in flight or not yet measurable.
  Duration? etaOf(String id) => _inFlight[id]?.eta(_now(), minSampleTime);

  /// Whether a new upload may start right now.
  bool get canAdmit {
    if (_reserved > 0 || _inFlight.length + _reserved >= maxConcurrent) {
      return false;
    }
    final now = _now();
    for (final upload in _inFlight.values) {
      final eta = upload.eta(now, minSampleTime);
      if (eta == null || eta >= maxEta) {
        return false;
      }
    }
    return true;
  }

  /// Waits until a new upload may start.
  ///
  /// Returns false once [isCancelled] reports true. A true result can be stale
  /// by the time the caller resumes (another waiter may have taken the
  /// opening), so the caller must claim the slot with [tryReserve] and wait
  /// again when that fails.
  Future<bool> waitForAdmission({bool Function()? isCancelled}) async {
    while (!canAdmit) {
      if (isCancelled?.call() ?? false) {
        return false;
      }
      await Future<void>.delayed(pollInterval);
    }
    return !(isCancelled?.call() ?? false);
  }

  /// Synchronously claims a slot if one is available. The claim blocks other
  /// admissions until [begin] turns it into a tracked upload or
  /// [cancelReservation] gives it back.
  bool tryReserve() {
    if (!canAdmit) {
      return false;
    }
    _reserved++;
    return true;
  }

  void cancelReservation() {
    if (_reserved > 0) {
      _reserved--;
    }
  }

  /// Registers [id] as in flight, consuming a reservation when one is held.
  /// Every [begin] must be paired with a [release].
  void begin(String id) {
    cancelReservation();
    _inFlight[id] = _InFlightUpload(rateWindow: rateWindow);
  }

  /// Waits for a slot, claims it and registers [id]; false if cancelled while waiting.
  Future<bool> acquire(String id, {bool Function()? isCancelled}) async {
    while (true) {
      if (!await waitForAdmission(isCancelled: isCancelled)) {
        return false;
      }
      if (tryReserve()) {
        begin(id);
        return true;
      }
    }
  }

  /// Records a progress sample for upload [id]. Unknown ids are ignored, so the
  /// same hook can serve code paths that never went through [acquire].
  void progress(String id, int bytes, int totalBytes) {
    _inFlight[id]?.record(_now(), bytes, totalBytes);
  }

  /// Marks upload [id] as finished (successfully or not).
  void release(String id) {
    _inFlight.remove(id);
  }

  void clear() {
    _inFlight.clear();
    _reserved = 0;
  }

  /// Human readable summary of the in-flight uploads, for logs.
  String describe() {
    if (_inFlight.isEmpty) {
      return 'none in flight';
    }
    final now = _now();
    return _inFlight.entries
        .map((e) {
          final eta = e.value.eta(now, minSampleTime);
          return '${e.key}: ${eta == null ? 'eta unknown' : 'eta ${eta.inSeconds}s'}';
        })
        .join(', ');
  }
}

class _InFlightUpload {
  _InFlightUpload({required this.rateWindow});

  final Duration rateWindow;
  final List<({DateTime at, int bytes})> _samples = [];
  int _totalBytes = 0;
  DateTime? _firstProgressAt;

  void record(DateTime now, int bytes, int totalBytes) {
    // Bytes going backwards means a new file started under the same id
    // (e.g. the still image after the motion part of a live photo).
    if (_samples.isNotEmpty && bytes < _samples.last.bytes) {
      _samples.clear();
      _firstProgressAt = null;
    }
    _firstProgressAt ??= now;
    _totalBytes = totalBytes;
    _samples.add((at: now, bytes: bytes));
    // Keep one sample at or before the window boundary as the rate baseline.
    while (_samples.length > 2 && now.difference(_samples[1].at) >= rateWindow) {
      _samples.removeAt(0);
    }
  }

  Duration? eta(DateTime now, Duration minSampleTime) {
    final firstProgressAt = _firstProgressAt;
    if (firstProgressAt == null || _samples.length < 2) {
      return null;
    }
    if (now.difference(firstProgressAt) < minSampleTime) {
      return null;
    }
    final first = _samples.first;
    final last = _samples.last;
    final elapsedMicros = last.at.difference(first.at).inMicroseconds;
    if (elapsedMicros <= 0) {
      return null;
    }
    final bytesPerSecond = (last.bytes - first.bytes) * 1e6 / elapsedMicros;
    if (bytesPerSecond <= 0) {
      return null;
    }
    final remaining = _totalBytes - last.bytes;
    if (remaining <= 0) {
      return Duration.zero;
    }
    return Duration(microseconds: (remaining / bytesPerSecond * 1e6).round());
  }
}
