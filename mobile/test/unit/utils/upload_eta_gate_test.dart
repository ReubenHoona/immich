import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/utils/upload_eta_gate.dart';

void main() {
  late DateTime clock;
  late UploadEtaGate gate;

  const mb = 1024 * 1024;

  void tick(Duration by) => clock = clock.add(by);

  /// Feeds [count] evenly spaced progress samples at [bytesPerSecond] for [id].
  void stream(String id, {required int bytesPerSecond, required int totalBytes, int seconds = 5, int startBytes = 0}) {
    var bytes = startBytes;
    for (var i = 0; i < seconds; i++) {
      tick(const Duration(seconds: 1));
      bytes += bytesPerSecond;
      gate.progress(id, bytes, totalBytes);
    }
  }

  setUp(() {
    clock = DateTime(2026, 10, 2, 12);
    gate = UploadEtaGate(
      maxEta: const Duration(minutes: 5),
      maxConcurrent: 3,
      minSampleTime: const Duration(seconds: 3),
      rateWindow: const Duration(seconds: 10),
      pollInterval: const Duration(milliseconds: 1),
      now: () => clock,
    );
  });

  group('UploadEtaGate', () {
    test('admits the first upload immediately', () async {
      expect(gate.canAdmit, isTrue);
      expect(await gate.acquire('a'), isTrue);
      expect(gate.inFlightCount, 1);
    });

    test('blocks a second upload while the first has no ETA yet', () async {
      await gate.acquire('a');
      expect(gate.etaOf('a'), isNull);
      expect(gate.canAdmit, isFalse);

      // Progress for less than minSampleTime is not enough to trust an ETA.
      stream('a', bytesPerSecond: 10 * mb, totalBytes: 100 * mb, seconds: 2);
      expect(gate.etaOf('a'), isNull);
      expect(gate.canAdmit, isFalse);
    });

    test('admits a second upload once the first has an ETA under the limit', () async {
      await gate.acquire('a');
      stream('a', bytesPerSecond: 10 * mb, totalBytes: 100 * mb, seconds: 5);

      // 50 MB left at 10 MB/s = 5 s
      expect(gate.etaOf('a'), const Duration(seconds: 5));
      expect(gate.canAdmit, isTrue);
      expect(await gate.acquire('b'), isTrue);
      expect(gate.inFlightCount, 2);
    });

    test('keeps a large upload alone while its ETA is at or above the limit', () async {
      await gate.acquire('big');
      // 1 MB/s with 9 GB to go: hours of ETA
      stream('big', bytesPerSecond: mb, totalBytes: 9 * 1024 * mb, seconds: 5);
      expect(gate.etaOf('big'), greaterThan(const Duration(minutes: 5)));
      expect(gate.canAdmit, isFalse);

      // Exactly the limit is still not admitted.
      gate.release('big');
      await gate.acquire('edge');
      // 300 MB left at 1 MB/s = 300 s = 5 min
      stream('edge', bytesPerSecond: mb, totalBytes: 305 * mb, seconds: 5);
      expect(gate.etaOf('edge'), const Duration(minutes: 5));
      expect(gate.canAdmit, isFalse);
    });

    test('re-admits when a slow upload speeds up (sliding window)', () async {
      await gate.acquire('a');
      stream('a', bytesPerSecond: mb, totalBytes: 2000 * mb, seconds: 5);
      expect(gate.canAdmit, isFalse);

      // The link clears: 20x faster for longer than the rate window.
      stream('a', bytesPerSecond: 20 * mb, totalBytes: 2000 * mb, seconds: 12, startBytes: 5 * mb);
      final eta = gate.etaOf('a')!;
      // ~1755 MB left at 20 MB/s ≈ 88 s
      expect(eta, lessThan(const Duration(minutes: 5)));
      expect(gate.canAdmit, isTrue);
    });

    test('an upload that stalls loses its ETA and blocks admission', () async {
      await gate.acquire('a');
      stream('a', bytesPerSecond: 10 * mb, totalBytes: 100 * mb, seconds: 5);
      expect(gate.canAdmit, isTrue);

      // Same byte count reported again after the window has moved on: zero rate.
      tick(const Duration(seconds: 15));
      gate.progress('a', 50 * mb, 100 * mb);
      tick(const Duration(seconds: 1));
      gate.progress('a', 50 * mb, 100 * mb);
      expect(gate.etaOf('a'), isNull);
      expect(gate.canAdmit, isFalse);
    });

    test('bytes going backwards restarts measurement for a new file under the same id', () async {
      await gate.acquire('live');
      stream('live', bytesPerSecond: 10 * mb, totalBytes: 50 * mb, seconds: 5);
      expect(gate.etaOf('live'), Duration.zero);

      // Still image starts after the motion part: progress restarts from zero.
      tick(const Duration(seconds: 1));
      gate.progress('live', mb, 400 * mb);
      expect(gate.etaOf('live'), isNull);
      expect(gate.canAdmit, isFalse);
    });

    test('release frees the slot and clear empties the gate', () async {
      await gate.acquire('a');
      expect(gate.canAdmit, isFalse);
      gate.release('a');
      expect(gate.inFlightCount, 0);
      expect(gate.canAdmit, isTrue);

      await gate.acquire('b');
      gate.clear();
      expect(gate.inFlightCount, 0);
    });

    test('never exceeds maxConcurrent even when every ETA is tiny', () async {
      for (final id in ['a', 'b', 'c']) {
        expect(await gate.acquire(id), isTrue);
        stream(id, bytesPerSecond: 10 * mb, totalBytes: 60 * mb, seconds: 5);
      }
      expect(gate.inFlightCount, 3);
      expect(gate.canAdmit, isFalse);
    });

    test('acquire waits and then proceeds once the gate opens', () async {
      await gate.acquire('a');
      var admitted = false;
      final pending = gate.acquire('b').then((ok) => admitted = ok);

      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(admitted, isFalse);

      stream('a', bytesPerSecond: 10 * mb, totalBytes: 100 * mb, seconds: 5);
      await pending;
      expect(admitted, isTrue);
      expect(gate.inFlightIds, containsAll(['a', 'b']));
    });

    test('acquire gives up without registering when cancelled', () async {
      await gate.acquire('a');
      var cancelled = false;
      final pending = gate.acquire('b', isCancelled: () => cancelled);
      await Future<void>.delayed(const Duration(milliseconds: 5));
      cancelled = true;
      expect(await pending, isFalse);
      expect(gate.inFlightIds, ['a']);
    });

    test('a reservation blocks admission until begin or cancelReservation', () {
      expect(gate.tryReserve(), isTrue);
      expect(gate.canAdmit, isFalse);
      expect(gate.tryReserve(), isFalse);

      gate.begin('a');
      expect(gate.inFlightIds, ['a']);
      // The reservation was consumed; 'a' now blocks because its ETA is unknown.
      expect(gate.canAdmit, isFalse);
      gate.release('a');
      expect(gate.canAdmit, isTrue);

      expect(gate.tryReserve(), isTrue);
      gate.cancelReservation();
      expect(gate.canAdmit, isTrue);
    });

    test('progress for an unknown id is ignored', () {
      gate.progress('ghost', 10, 100);
      expect(gate.inFlightCount, 0);
      expect(gate.etaOf('ghost'), isNull);
    });

    test('describe lists in-flight uploads with their ETA state', () async {
      expect(gate.describe(), 'none in flight');
      await gate.acquire('a');
      expect(gate.describe(), 'a: eta unknown');
      stream('a', bytesPerSecond: 10 * mb, totalBytes: 100 * mb, seconds: 5);
      expect(gate.describe(), 'a: eta 5s');
    });
  });
}
