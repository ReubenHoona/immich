import { JobName, JobStatus, PanoramaGroupStatus } from 'src/enum';
import {
  collapseTwins,
  isSameSeries,
  normalizeStem,
  PanoramaService,
  PanoramaStreamRow,
} from 'src/services/panorama.service';
import { systemConfigStub } from 'test/fixtures/system-config.stub';
import { makeStream, newTestService, ServiceMocks } from 'test/utils';

const panoramaEnabled = { machineLearning: { panorama: { enabled: true } } };

const row = (overrides: Partial<PanoramaStreamRow>): PanoramaStreamRow => ({
  id: 'asset-1',
  ownerId: 'user-1',
  originalFileName: 'IMG_0001.jpg',
  make: 'Google',
  model: 'Pixel 8 Pro',
  dateTimeOriginal: new Date('2026-08-08T10:00:00Z'),
  panoramaAt: null,
  ...overrides,
});

describe('panorama helpers', () => {
  describe('normalizeStem', () => {
    it('strips extension and lowercases', () => {
      expect(normalizeStem('IMG_0001.JPG')).toBe('img_0001');
    });

    it('normalizes Pixel RAW twin suffixes to a shared stem', () => {
      expect(normalizeStem('PXL_20260808_024651473.RAW-01.jpg')).toBe('pxl_20260808_024651473');
      expect(normalizeStem('PXL_20260808_024651473.RAW-02.ORIGINAL.dng')).toBe('pxl_20260808_024651473');
    });

    it('keeps distinct stems distinct', () => {
      expect(normalizeStem('PXL_1.PORTRAIT.jpg')).not.toBe(normalizeStem('PXL_2.PORTRAIT.jpg'));
    });
  });

  describe('collapseTwins', () => {
    it('keeps the jpeg of a RAW+JPEG pair', () => {
      const jpg = row({ id: 'jpg', originalFileName: 'PXL_1.RAW-01.jpg' });
      const dng = row({
        id: 'dng',
        originalFileName: 'PXL_1.RAW-02.ORIGINAL.dng',
        dateTimeOriginal: new Date('2026-08-08T10:00:00.5Z'),
      });
      expect(collapseTwins([jpg, dng]).map((r) => r.id)).toEqual(['jpg']);
      expect(collapseTwins([dng, jpg]).map((r) => r.id)).toEqual(['jpg']);
    });

    it('keeps separate shots', () => {
      const a = row({ id: 'a', originalFileName: 'PXL_1.jpg' });
      const b = row({ id: 'b', originalFileName: 'PXL_2.jpg', dateTimeOriginal: new Date('2026-08-08T10:00:03Z') });
      expect(collapseTwins([a, b]).map((r) => r.id)).toEqual(['a', 'b']);
    });
  });

  describe('isSameSeries', () => {
    it('requires same owner and camera', () => {
      expect(isSameSeries(row({}), row({}))).toBe(true);
      expect(isSameSeries(row({}), row({ model: 'Pixel 3' }))).toBe(false);
      expect(isSameSeries(row({}), row({ ownerId: 'user-2' }))).toBe(false);
    });
  });
});

describe(PanoramaService.name, () => {
  let sut: PanoramaService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(PanoramaService));
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('handleQueueAll', () => {
    it('skips when panorama is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.machineLearningDisabled);

      await expect(sut.handleQueueAll({ force: false })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.assetJob.streamForPanoramaJob).not.toHaveBeenCalled();
    });

    it('clusters by time gap and queues detect jobs', async () => {
      mocks.systemMetadata.get.mockResolvedValue(panoramaEnabled);
      mocks.assetJob.streamForPanoramaJob.mockReturnValue(
        makeStream([
          row({ id: 'a1', dateTimeOriginal: new Date('2026-08-08T10:00:00Z') }),
          row({ id: 'a2', originalFileName: 'IMG_0002.jpg', dateTimeOriginal: new Date('2026-08-08T10:00:04Z') }),
          // 60s gap -> new cluster, but singletons are dropped
          row({ id: 'b1', originalFileName: 'IMG_0003.jpg', dateTimeOriginal: new Date('2026-08-08T10:01:04Z') }),
        ]),
      );

      await expect(sut.handleQueueAll({ force: false })).resolves.toBe(JobStatus.Success);

      const queued = mocks.job.queueAll.mock.calls.flatMap(([jobs]) => jobs);
      expect(queued).toEqual([{ name: JobName.PanoramaDetect, data: { ids: ['a1', 'a2'] } }]);
    });

    it('skips fully processed clusters unless forced', async () => {
      mocks.systemMetadata.get.mockResolvedValue(panoramaEnabled);
      const processed = new Date('2026-08-01T00:00:00Z');
      mocks.assetJob.streamForPanoramaJob.mockReturnValue(
        makeStream([
          row({ id: 'a1', panoramaAt: processed }),
          row({
            id: 'a2',
            originalFileName: 'IMG_0002.jpg',
            panoramaAt: processed,
            dateTimeOriginal: new Date('2026-08-08T10:00:04Z'),
          }),
        ]),
      );

      await expect(sut.handleQueueAll({ force: false })).resolves.toBe(JobStatus.Success);
      expect(mocks.job.queueAll.mock.calls.flatMap(([jobs]) => jobs)).toEqual([]);
    });

    it('wipes pending groups on force', async () => {
      mocks.systemMetadata.get.mockResolvedValue(panoramaEnabled);
      mocks.assetJob.streamForPanoramaJob.mockReturnValue(makeStream([]));

      await sut.handleQueueAll({ force: true });
      expect(mocks.panorama.deletePending).toHaveBeenCalled();
    });
  });

  describe('handleDetect', () => {
    const preview = (id: string) => ({
      id,
      ownerId: 'user-1',
      visibility: 'timeline',
      previewFile: `/thumbs/${id}.webp`,
    });

    it('creates a candidate group for a detected chain', async () => {
      mocks.systemMetadata.get.mockResolvedValue(panoramaEnabled);
      mocks.assetJob.getForPanoramaDetect.mockResolvedValue([preview('a'), preview('b'), preview('c')] as never);
      mocks.machineLearning.panoramaDetect.mockResolvedValue({
        frames: 3,
        links: [],
        classification: 'panorama',
        chainStart: 0,
        chainEnd: 1,
        score: 6.2,
        mixedDirections: false,
      });
      mocks.panorama.getSettledMemberSets.mockResolvedValue([]);
      mocks.panorama.create.mockResolvedValue({ id: 'group-1' } as never);

      await expect(sut.handleDetect({ ids: ['a', 'b', 'c'] })).resolves.toBe(JobStatus.Success);

      expect(mocks.panorama.create).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'user-1', status: PanoramaGroupStatus.Candidate, score: 6.2 }),
        ['a', 'b'],
      );
      expect(mocks.asset.upsertJobStatus).toHaveBeenCalledWith(
        expect.objectContaining({ assetId: 'a' }),
        expect.objectContaining({ assetId: 'b' }),
        expect.objectContaining({ assetId: 'c' }),
      );
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('does not create groups for bursts but still stamps assets', async () => {
      mocks.systemMetadata.get.mockResolvedValue(panoramaEnabled);
      mocks.assetJob.getForPanoramaDetect.mockResolvedValue([preview('a'), preview('b')] as never);
      mocks.machineLearning.panoramaDetect.mockResolvedValue({
        frames: 2,
        links: [],
        classification: 'burst',
        chainStart: null,
        chainEnd: null,
        score: 0,
        mixedDirections: false,
      });

      await expect(sut.handleDetect({ ids: ['a', 'b'] })).resolves.toBe(JobStatus.Success);
      expect(mocks.panorama.create).not.toHaveBeenCalled();
      expect(mocks.asset.upsertJobStatus).toHaveBeenCalled();
    });

    it('skips chains identical to a dismissed group', async () => {
      mocks.systemMetadata.get.mockResolvedValue(panoramaEnabled);
      mocks.assetJob.getForPanoramaDetect.mockResolvedValue([preview('a'), preview('b')] as never);
      mocks.machineLearning.panoramaDetect.mockResolvedValue({
        frames: 2,
        links: [],
        classification: 'panorama',
        chainStart: 0,
        chainEnd: 1,
        score: 5,
        mixedDirections: false,
      });
      mocks.panorama.getSettledMemberSets.mockResolvedValue([['a', 'b']]);

      await expect(sut.handleDetect({ ids: ['a', 'b'] })).resolves.toBe(JobStatus.Success);
      expect(mocks.panorama.create).not.toHaveBeenCalled();
    });

    it('queues a stitch when autoStitch is on', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { panorama: { enabled: true, autoStitch: true } },
      });
      mocks.assetJob.getForPanoramaDetect.mockResolvedValue([preview('a'), preview('b')] as never);
      mocks.machineLearning.panoramaDetect.mockResolvedValue({
        frames: 2,
        links: [],
        classification: 'panorama',
        chainStart: 0,
        chainEnd: 1,
        score: 5,
        mixedDirections: false,
      });
      mocks.panorama.getSettledMemberSets.mockResolvedValue([]);
      mocks.panorama.create.mockResolvedValue({ id: 'group-1' } as never);

      await sut.handleDetect({ ids: ['a', 'b'] });
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.PanoramaStitch, data: { id: 'group-1' } });
    });
  });

  describe('handleStitch', () => {
    const group = {
      id: 'group-1',
      ownerId: 'user-1',
      status: PanoramaGroupStatus.Candidate,
      score: 6,
      linkStats: null,
      resultAssetId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      updateId: 'u',
      members: [
        { assetId: 'a', sortOrder: 0 },
        { assetId: 'b', sortOrder: 1 },
      ],
    };

    const stitchAsset = (id: string, originalPath: string) => ({
      id,
      ownerId: 'user-1',
      libraryId: null,
      originalPath,
      originalFileName: originalPath.split('/').pop() as string,
      fileCreatedAt: new Date('2026-08-08T10:00:00Z'),
      fileModifiedAt: new Date('2026-08-08T10:00:00Z'),
      localDateTime: new Date('2026-08-08T22:00:00Z'),
      dateTimeOriginal: new Date('2026-08-08T10:00:00Z'),
      timeZone: 'Pacific/Auckland',
      previewFile: `/thumbs/${id}.webp`,
    });

    beforeEach(() => {
      mocks.systemMetadata.get.mockResolvedValue(panoramaEnabled);
      mocks.panorama.getById.mockResolvedValue(group as never);
      mocks.panorama.update.mockResolvedValue(group as never);
      mocks.assetJob.getForPanoramaStitch.mockResolvedValue([
        stitchAsset('a', '/data/a.jpg'),
        stitchAsset('b', '/data/b.dng'),
      ] as never);
      mocks.machineLearning.panoramaStitch.mockResolvedValue({ data: Buffer.from('jpeg'), width: 100, height: 50 });
      mocks.crypto.randomUUID.mockReturnValue('pano-uuid');
      mocks.crypto.hashFile.mockResolvedValue(Buffer.from('checksum'));
      mocks.storage.stat.mockResolvedValue({ size: 1234, mtime: new Date() } as never);
      mocks.asset.getByChecksum.mockResolvedValue(void 0 as never);
      mocks.asset.create.mockImplementation((asset) => Promise.resolve(asset as never));
    });

    it('uses originals for jpegs and previews for raw frames', async () => {
      await expect(sut.handleStitch({ id: 'group-1' })).resolves.toBe(JobStatus.Success);

      expect(mocks.machineLearning.panoramaStitch).toHaveBeenCalledWith(
        ['/data/a.jpg', '/thumbs/b.webp'],
        expect.objectContaining({ quality: 97 }),
      );
    });

    it('creates the asset, stacks sources, and completes the group', async () => {
      await sut.handleStitch({ id: 'group-1' });

      expect(mocks.storage.createFile).toHaveBeenCalled();
      expect(mocks.media.writeExif).toHaveBeenCalled();
      expect(mocks.asset.create).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'user-1' }));
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.AssetExtractMetadata,
        data: { id: 'pano-uuid', source: 'upload' },
      });
      expect(mocks.stack.create).toHaveBeenCalledWith({ ownerId: 'user-1' }, ['pano-uuid', 'a', 'b']);
      expect(mocks.panorama.update).toHaveBeenCalledWith('group-1', {
        status: PanoramaGroupStatus.Completed,
        resultAssetId: 'pano-uuid',
      });
    });

    it('marks the group failed when stitching fails', async () => {
      mocks.machineLearning.panoramaStitch.mockRejectedValue(new Error('stitch failed'));

      await expect(sut.handleStitch({ id: 'group-1' })).resolves.toBe(JobStatus.Failed);
      expect(mocks.panorama.update).toHaveBeenCalledWith('group-1', { status: PanoramaGroupStatus.Failed });
      expect(mocks.asset.create).not.toHaveBeenCalled();
    });

    it('skips settled groups', async () => {
      mocks.panorama.getById.mockResolvedValue({ ...group, status: PanoramaGroupStatus.Completed } as never);

      await expect(sut.handleStitch({ id: 'group-1' })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.machineLearning.panoramaStitch).not.toHaveBeenCalled();
    });
  });
});
