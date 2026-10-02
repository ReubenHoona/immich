import 'dart:async';
import 'dart:io';

import 'package:drift/drift.dart' hide isNotNull, isNull;
import 'package:drift/native.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/data/db/main/database.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/domain/services/store.service.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/infrastructure/repositories/settings.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/store.repository.dart';
import 'package:immich_mobile/repositories/upload.repository.dart';
import 'package:immich_mobile/services/foreground_upload.service.dart';
import 'package:immich_mobile/utils/upload_eta_gate.dart';
import 'package:mocktail/mocktail.dart';

import '../api.mocks.dart';
import '../fixtures/asset.stub.dart';
import '../infrastructure/repository.mock.dart';
import '../mocks/asset_entity.mock.dart';
import '../repository.mocks.dart';

void main() {
  late ForegroundUploadService sut;
  late MockUploadRepository mockUploadRepository;
  late MockStorageRepository mockStorageRepository;
  late MockBackupRepository mockBackupRepository;
  late MockConnectivityApi mockConnectivityApi;
  late MockAssetMediaRepository mockAssetMediaRepository;
  late Drift db;

  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (MethodCall methodCall) async => 'test',
    );
    db = Drift(DatabaseConnection(NativeDatabase.memory(), closeStreamsSynchronously: true));
    await StoreService.init(storeRepository: StoreRepository(db));
    await SettingsRepository.ensureInitialized(db);

    await Store.put(StoreKey.serverEndpoint, 'http://demo.immich.app');
    await Store.put(StoreKey.deviceId, 'device-id');

    registerFallbackValue(File('file'));
    registerFallbackValue(<String, String>{});
    registerFallbackValue(LocalAssetStub.image1);
  });

  setUp(() {
    mockUploadRepository = MockUploadRepository();
    mockStorageRepository = MockStorageRepository();
    mockBackupRepository = MockBackupRepository();
    mockConnectivityApi = MockConnectivityApi();
    mockAssetMediaRepository = MockAssetMediaRepository();

    sut = ForegroundUploadService(
      mockUploadRepository,
      mockStorageRepository,
      mockBackupRepository,
      mockConnectivityApi,
      mockAssetMediaRepository,
    );
  });

  List<Map<String, String>> captureFields() {
    final captured = <Map<String, String>>[];
    when(
      () => mockUploadRepository.uploadFile(
        file: any(named: 'file'),
        originalFileName: any(named: 'originalFileName'),
        fields: any(named: 'fields'),
        cancelToken: any(named: 'cancelToken'),
        onProgress: any(named: 'onProgress'),
        logContext: any(named: 'logContext'),
      ),
    ).thenAnswer((invocation) async {
      final fields = invocation.namedArguments[#fields] as Map<String, String>;
      captured.add(Map.of(fields));
      return UploadResult.success(remoteAssetId: 'remote-${captured.length}');
    });
    return captured;
  }

  List<String> captureOriginalFileNames() {
    final captured = <String>[];
    when(
      () => mockUploadRepository.uploadFile(
        file: any(named: 'file'),
        originalFileName: any(named: 'originalFileName'),
        fields: any(named: 'fields'),
        cancelToken: any(named: 'cancelToken'),
        onProgress: any(named: 'onProgress'),
        logContext: any(named: 'logContext'),
      ),
    ).thenAnswer((invocation) async {
      captured.add(invocation.namedArguments[#originalFileName] as String);
      return UploadResult.success(remoteAssetId: 'remote-${captured.length}');
    });
    return captured;
  }

  group('uploadSingleAsset', () {
    test('should upload the motion part hidden and keep the still image visible', () async {
      final asset = LocalAssetStub.image1;
      final mockEntity = MockAssetEntity();
      final stillFile = File('/path/to/still.heic');
      final videoFile = File('/path/to/motion.mov');

      when(() => mockEntity.isLivePhoto).thenReturn(true);
      when(() => mockStorageRepository.getAssetEntityForAsset(asset)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.isAssetAvailableLocally(asset.id)).thenAnswer((_) async => true);
      when(() => mockStorageRepository.getFileForAsset(asset.id)).thenAnswer((_) async => stillFile);
      when(() => mockStorageRepository.getMotionFileForAsset(asset)).thenAnswer((_) async => videoFile);
      when(() => mockAssetMediaRepository.getOriginalFilename(asset.id)).thenAnswer((_) async => 'live.heic');

      final captured = captureFields();

      await sut.uploadSingleAsset(asset, null, callbacks: const UploadCallbacks());

      expect(captured, hasLength(2));
      expect(captured[0]['visibility'], equals('hidden'));
      expect(captured[0].containsKey('livePhotoVideoId'), isFalse);
      expect(captured[1].containsKey('visibility'), isFalse);
      expect(captured[1]['livePhotoVideoId'], equals('remote-1'));
    });

    test('should not set visibility for a regular photo', () async {
      final asset = LocalAssetStub.image1;
      final mockEntity = MockAssetEntity();
      final stillFile = File('/path/to/photo.jpg');

      when(() => mockEntity.isLivePhoto).thenReturn(false);
      when(() => mockStorageRepository.getAssetEntityForAsset(asset)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.isAssetAvailableLocally(asset.id)).thenAnswer((_) async => true);
      when(() => mockStorageRepository.getFileForAsset(asset.id)).thenAnswer((_) async => stillFile);
      when(() => mockAssetMediaRepository.getOriginalFilename(asset.id)).thenAnswer((_) async => 'photo.jpg');

      final captured = captureFields();

      await sut.uploadSingleAsset(asset, null, callbacks: const UploadCallbacks());

      expect(captured, hasLength(1));
      expect(captured[0].containsKey('visibility'), isFalse);
    });

    test('corrects the extension when iOS returns a rendered file for a .dng asset', () async {
      final asset = LocalAssetStub.image1;
      final mockEntity = MockAssetEntity();
      final stillFile = File('/path/to/IMG_6499.jpg');

      when(() => mockEntity.isLivePhoto).thenReturn(false);
      when(() => mockStorageRepository.getAssetEntityForAsset(asset)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.isAssetAvailableLocally(asset.id)).thenAnswer((_) async => true);
      when(() => mockStorageRepository.getFileForAsset(asset.id)).thenAnswer((_) async => stillFile);
      when(() => mockAssetMediaRepository.getOriginalFilename(asset.id)).thenAnswer((_) async => 'IMG_6499.dng');

      final names = captureOriginalFileNames();

      await sut.uploadSingleAsset(asset, null, callbacks: const UploadCallbacks());

      expect(names, equals(['IMG_6499.jpg']));
    });

    test('keeps the .dng extension for a genuine RAW original', () async {
      final asset = LocalAssetStub.image1;
      final mockEntity = MockAssetEntity();
      final stillFile = File('/path/to/IMG_5210.dng');

      when(() => mockEntity.isLivePhoto).thenReturn(false);
      when(() => mockStorageRepository.getAssetEntityForAsset(asset)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.isAssetAvailableLocally(asset.id)).thenAnswer((_) async => true);
      when(() => mockStorageRepository.getFileForAsset(asset.id)).thenAnswer((_) async => stillFile);
      when(() => mockAssetMediaRepository.getOriginalFilename(asset.id)).thenAnswer((_) async => 'IMG_5210.dng');

      final names = captureOriginalFileNames();

      await sut.uploadSingleAsset(asset, null, callbacks: const UploadCallbacks());

      expect(names, equals(['IMG_5210.dng']));
    });

    test('borrows the extension from the asset name for an extensionless name (DJI/Fusion)', () async {
      final asset = LocalAssetStub.image1;
      final mockEntity = MockAssetEntity();
      final stillFile = File('/path/to/DJI_0001');

      when(() => mockEntity.isLivePhoto).thenReturn(false);
      when(() => mockStorageRepository.getAssetEntityForAsset(asset)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.isAssetAvailableLocally(asset.id)).thenAnswer((_) async => true);
      when(() => mockStorageRepository.getFileForAsset(asset.id)).thenAnswer((_) async => stillFile);
      when(() => mockAssetMediaRepository.getOriginalFilename(asset.id)).thenAnswer((_) async => 'DJI_0001');

      final names = captureOriginalFileNames();

      await sut.uploadSingleAsset(asset, null, callbacks: const UploadCallbacks());

      expect(names, equals(['DJI_0001.jpg']));
    });
  });

  group('worker pool ETA admission', () {
    const mb = 1024 * 1024;
    late DateTime clock;
    late UploadEtaGate gate;

    /// One controllable in-flight upload: the test decides its progress and when it finishes.
    final started = <String>[];
    final completers = <String, Completer<UploadResult>>{};
    final progressHooks = <String, void Function(int bytes, int totalBytes)>{};

    LocalAsset asset(String id) => LocalAsset(
      id: id,
      name: '$id.mp4',
      type: AssetType.video,
      createdAt: DateTime(2026),
      updatedAt: DateTime(2026),
      playbackStyle: AssetPlaybackStyle.video,
      isEdited: false,
    );

    Future<void> settle() => Future<void>.delayed(const Duration(milliseconds: 20));

    setUp(() {
      started.clear();
      completers.clear();
      progressHooks.clear();
      clock = DateTime(2026, 10, 2, 12);
      gate = UploadEtaGate(
        maxEta: const Duration(minutes: 5),
        minSampleTime: const Duration(seconds: 3),
        pollInterval: const Duration(milliseconds: 2),
        now: () => clock,
      );
      sut = ForegroundUploadService(
        mockUploadRepository,
        mockStorageRepository,
        mockBackupRepository,
        mockConnectivityApi,
        mockAssetMediaRepository,
        etaGate: gate,
      );

      final mockEntity = MockAssetEntity();
      when(() => mockEntity.isLivePhoto).thenReturn(false);
      when(() => mockStorageRepository.clearCache()).thenAnswer((_) async {});
      when(() => mockStorageRepository.getAssetEntityForAsset(any())).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.isAssetAvailableLocally(any())).thenAnswer((_) async => true);
      when(
        () => mockStorageRepository.getFileForAsset(any()),
      ).thenAnswer((i) async => File('/path/${i.positionalArguments[0]}.mp4'));
      when(
        () => mockAssetMediaRepository.getOriginalFilename(any()),
      ).thenAnswer((i) async => '${i.positionalArguments[0]}.mp4');

      when(
        () => mockUploadRepository.uploadFile(
          file: any(named: 'file'),
          originalFileName: any(named: 'originalFileName'),
          fields: any(named: 'fields'),
          cancelToken: any(named: 'cancelToken'),
          onProgress: any(named: 'onProgress'),
          logContext: any(named: 'logContext'),
        ),
      ).thenAnswer((invocation) {
        final id = (invocation.namedArguments[#fields] as Map<String, String>)['deviceAssetId']!;
        started.add(id);
        progressHooks[id] = invocation.namedArguments[#onProgress] as void Function(int, int);
        return (completers[id] = Completer<UploadResult>()).future;
      });
    });

    /// Advances the fake clock and reports [seconds] one-second progress samples for [id].
    void report(String id, {required int bytesPerSecond, required int totalBytes, int seconds = 5}) {
      var bytes = 0;
      for (var i = 0; i < seconds; i++) {
        clock = clock.add(const Duration(seconds: 1));
        bytes += bytesPerSecond;
        progressHooks[id]!(bytes, totalBytes);
      }
    }

    void finish(String id) => completers[id]!.complete(UploadResult.success(remoteAssetId: 'remote-$id'));

    test('starts one upload and holds the rest until its ETA is known and under the limit', () async {
      final run = sut.uploadManual([asset('a'), asset('b'), asset('c')]);
      await settle();
      expect(started, ['a']);

      // Slow link, 9 GB to go: the other two stay queued.
      report('a', bytesPerSecond: mb, totalBytes: 9 * 1024 * mb);
      await settle();
      expect(started, ['a']);

      // The upload nears completion: ETA under 5 minutes lets the next one start.
      report('a', bytesPerSecond: 100 * mb, totalBytes: 9 * 1024 * mb, seconds: 12);
      await settle();
      expect(started, ['a', 'b']);

      // b has not reported anything yet, so c still waits even though a is nearly done.
      expect(started.length, 2);

      report('b', bytesPerSecond: 10 * mb, totalBytes: 60 * mb);
      await settle();
      expect(started, ['a', 'b', 'c']);

      finish('a');
      finish('b');
      finish('c');
      await run;
      expect(gate.inFlightCount, 0);
    });

    test('a finished upload frees its slot even when it never reported progress', () async {
      final run = sut.uploadManual([asset('a'), asset('b')]);
      await settle();
      expect(started, ['a']);

      finish('a');
      await settle();
      expect(started, ['a', 'b']);

      finish('b');
      await run;
      expect(gate.inFlightCount, 0);
    });

    test('cancellation stops queued uploads from starting', () async {
      final cancelToken = Completer<void>();
      final run = sut.uploadManual([asset('a'), asset('b')], cancelToken: cancelToken);
      await settle();
      expect(started, ['a']);

      cancelToken.complete();
      completers['a']!.complete(UploadResult.cancelled());
      await run;
      expect(started, ['a']);
      expect(gate.inFlightCount, 0);
    });
  });
}
