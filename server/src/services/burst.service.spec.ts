import { BadRequestException } from '@nestjs/common';
import { AssetVisibility, BurstGroupStatus, JobStatus } from 'src/enum';
import { BurstCandidate, BurstService, collapseTwins, isSameRun, normalizeStem } from 'src/services/burst.service';
import { AssetFactory } from 'test/factories/asset.factory';
import { authStub } from 'test/fixtures/auth.stub';
import { makeStream, newTestService, ServiceMocks } from 'test/utils';

const T0 = new Date('2026-08-08T02:13:30.313Z');
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);
const WINDOW = 2000;

const frame = (overrides: Partial<BurstCandidate> = {}): BurstCandidate => ({
  id: 'asset-1',
  ownerId: 'owner-1',
  originalFileName: 'PXL_20260808_021330313.RAW-01.jpg',
  dateTimeOriginal: T0,
  make: 'Google',
  model: 'Pixel 8 Pro',
  ...overrides,
});

/** n shots `gapMs` apart, each written as the Pixel does: a JPEG and a RAW of the same stem. */
const burst = (n: number, gapMs = 1500) =>
  Array.from({ length: n }, (_, i) => [
    frame({ id: `shot${i}-jpg`, originalFileName: `PXL_${i}.RAW-01.jpg`, dateTimeOriginal: at(i * gapMs) }),
    frame({
      id: `shot${i}-dng`,
      originalFileName: `PXL_${i}.RAW-02.ORIGINAL.dng`,
      dateTimeOriginal: at(i * gapMs + 400),
    }),
  ]).flat();

describe('normalizeStem', () => {
  it('collapses Pixel RAW variants onto the base name', () => {
    expect(normalizeStem('PXL_1.RAW-01.jpg')).toBe('pxl_1');
    expect(normalizeStem('PXL_1.RAW-02.ORIGINAL.dng')).toBe('pxl_1');
    expect(normalizeStem('PXL_1.RAW-01.MP.COVER.jpg')).toBe('pxl_1');
  });

  it('leaves unrelated names distinct', () => {
    expect(normalizeStem('PXL_1.PORTRAIT.jpg')).toBe('pxl_1.portrait');
    expect(normalizeStem('PXL_2.jpg')).toBe('pxl_2');
  });
});

describe('isSameRun', () => {
  it('joins frames inside the window', () => {
    expect(isSameRun(frame(), frame({ id: 'b', dateTimeOriginal: at(1500) }), WINDOW)).toBe(true);
  });

  it('accepts the window boundary and rejects beyond it', () => {
    expect(isSameRun(frame(), frame({ id: 'b', dateTimeOriginal: at(2000) }), WINDOW)).toBe(true);
    expect(isSameRun(frame(), frame({ id: 'b', dateTimeOriginal: at(2001) }), WINDOW)).toBe(false);
  });

  it('breaks the run when the camera changes mid-sequence', () => {
    expect(isSameRun(frame(), frame({ id: 'b', dateTimeOriginal: at(500), model: 'Pixel 7' }), WINDOW)).toBe(false);
    expect(isSameRun(frame(), frame({ id: 'b', dateTimeOriginal: at(500), make: 'samsung' }), WINDOW)).toBe(false);
  });

  it('breaks the run at an owner boundary', () => {
    expect(isSameRun(frame(), frame({ id: 'b', dateTimeOriginal: at(500), ownerId: 'owner-2' }), WINDOW)).toBe(false);
  });

  it('rejects frames with no capture time', () => {
    expect(isSameRun(frame(), frame({ id: 'b', dateTimeOriginal: null }), WINDOW)).toBe(false);
  });
});

describe('collapseTwins', () => {
  it('counts a RAW+JPEG press once', () => {
    const collapsed = collapseTwins(burst(3));
    expect(collapsed).toHaveLength(3);
    expect(collapsed.map(({ id }) => id)).toEqual(['shot0-jpg', 'shot1-jpg', 'shot2-jpg']);
  });

  it('leaves distinct shots alone', () => {
    const frames = [frame({ id: 'a', originalFileName: 'A.jpg' }), frame({ id: 'b', originalFileName: 'B.jpg' })];
    expect(collapseTwins(frames)).toHaveLength(2);
  });
});

const burstGroup = (overrides: Record<string, unknown> = {}) => ({
  id: 'burst-1',
  status: BurstGroupStatus.Candidate,
  createdAt: T0,
  members: [
    { assetId: 'shot0-jpg', distance: 0 },
    { assetId: 'shot1-jpg', distance: 0.01 },
    { assetId: 'shot2-jpg', distance: 0.02 },
  ],
  ...overrides,
});

const stackableMembers = (ids: string[]) => ids.map((assetId, i) => ({ assetId, distance: i * 0.01 }));

describe(BurstService.name, () => {
  let sut: BurstService;
  let mocks: ServiceMocks;

  const configure = (overrides: Record<string, unknown> = {}) =>
    mocks.systemMetadata.get.mockResolvedValue({
      machineLearning: {
        enabled: true,
        clip: { enabled: true },
        burstDetection: { enabled: true, timeWindowSeconds: 2, maxDistance: 0.05, minAssets: 3, ...overrides },
      },
    });

  /** every frame identical to the reference */
  const allSimilar = (ids: string[]) =>
    mocks.burst.getEmbeddingDistances.mockResolvedValue(ids.map((assetId, i) => ({ assetId, distance: i * 0.01 })));

  beforeEach(() => {
    ({ sut, mocks } = newTestService(BurstService));
    configure();
    mocks.burst.getGroupedAssetNames.mockResolvedValue([]);
    mocks.burst.create.mockResolvedValue({ id: 'burst-1' } as never);
    mocks.burst.setStatus.mockResolvedValue(void 0);
  });

  it('should be defined', () => {
    expect(sut).toBeDefined();
  });

  describe('accept', () => {
    beforeEach(() => {
      mocks.access.burstGroup.checkOwnerAccess.mockResolvedValue(new Set(['burst-1']));
      mocks.burst.getById.mockResolvedValue(burstGroup() as never);
      mocks.burst.getStackableMembers.mockResolvedValue(stackableMembers(['shot0-jpg', 'shot1-jpg', 'shot2-jpg']));
      mocks.asset.getByIdsWithAllRelationsButStacks.mockResolvedValue([]);
      mocks.burst.getUnstackedInRange.mockResolvedValue([]);
      mocks.stack.create.mockResolvedValue({ id: 'stack-1' } as never);
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['shot0-jpg', 'shot1-jpg', 'shot2-jpg']));
    });

    it('requires access to the group', async () => {
      mocks.access.burstGroup.checkOwnerAccess.mockResolvedValue(new Set());
      await expect(sut.accept(authStub.admin, 'burst-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.stack.create).not.toHaveBeenCalled();
    });

    it('refuses a group that is not a candidate', async () => {
      mocks.burst.getById.mockResolvedValue(burstGroup({ status: BurstGroupStatus.Accepted }) as never);
      await expect(sut.accept(authStub.admin, 'burst-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.stack.create).not.toHaveBeenCalled();
    });

    it('stacks the members that are still stackable, not the frozen list', async () => {
      await sut.accept(authStub.admin, 'burst-1');

      expect(mocks.burst.getStackableMembers).toHaveBeenCalledWith('burst-1');
      expect(mocks.stack.create).toHaveBeenCalledWith({ ownerId: authStub.admin.user.id }, [
        'shot0-jpg',
        'shot1-jpg',
        'shot2-jpg',
      ]);
      expect(mocks.burst.setStatus).toHaveBeenCalledWith('burst-1', BurstGroupStatus.Accepted);
    });

    it('refuses when too few members survive re-validation', async () => {
      // the other two were trashed or stacked by hand since detection
      mocks.burst.getStackableMembers.mockResolvedValue(stackableMembers(['shot0-jpg']));

      await expect(sut.accept(authStub.admin, 'burst-1')).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.stack.create).not.toHaveBeenCalled();
      expect(mocks.burst.setStatus).not.toHaveBeenCalled();
    });

    it('refuses when every member has gone', async () => {
      mocks.burst.getStackableMembers.mockResolvedValue([]);
      await expect(sut.accept(authStub.admin, 'burst-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.stack.create).not.toHaveBeenCalled();
    });

    it('requires update access to the assets, not just the group', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
      await expect(sut.accept(authStub.admin, 'burst-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.stack.create).not.toHaveBeenCalled();
    });

    it("pulls each frame's RAW twin into the stack", async () => {
      mocks.asset.getByIdsWithAllRelationsButStacks.mockResolvedValue([
        { id: 'shot0-jpg', originalFileName: 'PXL_0.RAW-01.jpg', exifInfo: { dateTimeOriginal: T0 } },
      ] as never);
      mocks.burst.getUnstackedInRange.mockResolvedValue([
        { id: 'shot0-dng', originalFileName: 'PXL_0.RAW-02.ORIGINAL.dng' },
        { id: 'unrelated', originalFileName: 'PXL_9.RAW-01.jpg' },
      ]);
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(
        new Set(['shot0-jpg', 'shot1-jpg', 'shot2-jpg', 'shot0-dng']),
      );

      await sut.accept(authStub.admin, 'burst-1');

      const [, assetIds] = mocks.stack.create.mock.calls[0];
      expect(assetIds).toContain('shot0-dng');
      expect(assetIds).not.toContain('unrelated');
    });
  });

  describe('dismiss', () => {
    beforeEach(() => {
      mocks.access.burstGroup.checkOwnerAccess.mockResolvedValue(new Set(['burst-1']));
      mocks.asset.getByIdsWithAllRelationsButStacks.mockResolvedValue([]);
    });

    it('requires access to the group', async () => {
      mocks.access.burstGroup.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.burst.getById.mockResolvedValue({
        id: 'burst-1',
        status: BurstGroupStatus.Candidate,
        createdAt: T0,
        members: [],
      } as never);
      await expect(sut.dismiss(authStub.admin, 'burst-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.burst.setStatus).not.toHaveBeenCalled();
    });

    it('marks a candidate dismissed', async () => {
      mocks.burst.getById.mockResolvedValue({
        id: 'burst-1',
        status: BurstGroupStatus.Candidate,
        createdAt: T0,
        members: [],
      } as never);
      await sut.dismiss(authStub.admin, 'burst-1');
      expect(mocks.burst.setStatus).toHaveBeenCalledWith('burst-1', BurstGroupStatus.Dismissed);
    });

    it('refuses to dismiss an accepted group', async () => {
      mocks.burst.getById.mockResolvedValue({
        id: 'burst-1',
        status: BurstGroupStatus.Accepted,
        createdAt: T0,
        members: [],
      } as never);
      await expect(sut.dismiss(authStub.admin, 'burst-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.burst.setStatus).not.toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('hides members the caller should not see', async () => {
      mocks.access.burstGroup.checkOwnerAccess.mockResolvedValue(new Set(['burst-1']));
      mocks.burst.getById.mockResolvedValue({
        id: 'burst-1',
        status: BurstGroupStatus.Candidate,
        createdAt: T0,
        members: [
          { assetId: 'visible', distance: 0 },
          { assetId: 'locked', distance: 0.01 },
          { assetId: 'trashed', distance: 0.02 },
        ],
      } as never);
      mocks.asset.getByIdsWithAllRelationsButStacks.mockResolvedValue([
        AssetFactory.from({ id: 'visible', visibility: AssetVisibility.Timeline, deletedAt: null }).exif().build(),
        AssetFactory.from({ id: 'locked', visibility: AssetVisibility.Locked, deletedAt: null }).exif().build(),
        AssetFactory.from({ id: 'trashed', visibility: AssetVisibility.Timeline, deletedAt: T0 }).exif().build(),
      ] as never);

      const result = await sut.get(authStub.admin, 'burst-1');

      expect(result.assets.map(({ id }) => id)).toEqual(['visible']);
    });
  });

  describe('handleQueueDetectBursts', () => {
    it('skips when burst detection is disabled', async () => {
      configure({ enabled: false });
      await expect(sut.handleQueueDetectBursts()).resolves.toBe(JobStatus.Skipped);
      expect(mocks.burst.create).not.toHaveBeenCalled();
    });

    it('skips when smart search is off, since there would be no embeddings', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: {
          enabled: true,
          clip: { enabled: false },
          burstDetection: { enabled: true, timeWindowSeconds: 2, maxDistance: 0.05, minAssets: 3 },
        },
      });
      await expect(sut.handleQueueDetectBursts()).resolves.toBe(JobStatus.Skipped);
    });

    it('groups a burst, counting RAW+JPEG twins as one frame each', async () => {
      const frames = burst(4);
      mocks.burst.streamForBurstDetection.mockReturnValue(makeStream(frames));
      allSimilar(['shot0-jpg', 'shot1-jpg', 'shot2-jpg', 'shot3-jpg']);

      await expect(sut.handleQueueDetectBursts()).resolves.toBe(JobStatus.Success);

      expect(mocks.burst.create).toHaveBeenCalledTimes(1);
      const [ownerId, members] = mocks.burst.create.mock.calls[0];
      expect(ownerId).toBe('owner-1');
      expect(members.map(({ assetId }: { assetId: string }) => assetId)).toEqual([
        'shot0-jpg',
        'shot1-jpg',
        'shot2-jpg',
        'shot3-jpg',
      ]);
    });

    it('ignores a run shorter than minAssets', async () => {
      mocks.burst.streamForBurstDetection.mockReturnValue(makeStream(burst(2)));
      allSimilar(['shot0-jpg', 'shot1-jpg']);

      await sut.handleQueueDetectBursts();

      expect(mocks.burst.create).not.toHaveBeenCalled();
    });

    it('does not group a run of five files that is really two shots', async () => {
      // one press saved as jpg+dng, then another press: 4 files, 2 shots
      mocks.burst.streamForBurstDetection.mockReturnValue(makeStream(burst(2)));

      await sut.handleQueueDetectBursts();

      expect(mocks.burst.getEmbeddingDistances).not.toHaveBeenCalled();
      expect(mocks.burst.create).not.toHaveBeenCalled();
    });

    it('drops frames that do not look like the reference', async () => {
      mocks.burst.streamForBurstDetection.mockReturnValue(makeStream(burst(4)));
      mocks.burst.getEmbeddingDistances.mockResolvedValue([
        { assetId: 'shot0-jpg', distance: 0 },
        { assetId: 'shot1-jpg', distance: 0.01 },
        { assetId: 'shot2-jpg', distance: 0.02 },
        // panned away to something else
        { assetId: 'shot3-jpg', distance: 0.9 },
      ]);

      await sut.handleQueueDetectBursts();

      const [, members] = mocks.burst.create.mock.calls[0];
      expect(members.map(({ assetId }: { assetId: string }) => assetId)).toEqual([
        'shot0-jpg',
        'shot1-jpg',
        'shot2-jpg',
      ]);
    });

    it('rejects the whole run when too few frames survive the similarity gate', async () => {
      mocks.burst.streamForBurstDetection.mockReturnValue(makeStream(burst(3)));
      mocks.burst.getEmbeddingDistances.mockResolvedValue([
        { assetId: 'shot0-jpg', distance: 0 },
        { assetId: 'shot1-jpg', distance: 0.8 },
        { assetId: 'shot2-jpg', distance: 0.9 },
      ]);

      await sut.handleQueueDetectBursts();

      expect(mocks.burst.create).not.toHaveBeenCalled();
    });

    it('skips a run whose frames have no embeddings yet rather than grouping blind', async () => {
      mocks.burst.streamForBurstDetection.mockReturnValue(makeStream(burst(3)));
      mocks.burst.getEmbeddingDistances.mockResolvedValue([{ assetId: 'shot0-jpg', distance: 0 }]);

      await expect(sut.handleQueueDetectBursts()).resolves.toBe(JobStatus.Success);

      expect(mocks.burst.create).not.toHaveBeenCalled();
    });

    it('does not re-offer a group the user already handled', async () => {
      mocks.burst.streamForBurstDetection.mockReturnValue(makeStream(burst(3)));
      allSimilar(['shot0-jpg', 'shot1-jpg', 'shot2-jpg']);
      mocks.burst.getGroupedAssetNames.mockResolvedValue([
        {
          id: 'shot1-jpg',
          originalFileName: 'PXL_1.RAW-01.jpg',
          dateTimeOriginal: at(1500),
          make: 'Google',
          model: 'Pixel 8 Pro',
        },
      ]);

      await sut.handleQueueDetectBursts();

      expect(mocks.burst.create).not.toHaveBeenCalled();
    });

    it('does not offer the RAW twins of a shot that was already handled', async () => {
      // the JPEGs of these shots were grouped and then dismissed; only the RAWs are left loose
      const raws = burst(3).filter(({ originalFileName }) => originalFileName.endsWith('.dng'));
      mocks.burst.streamForBurstDetection.mockReturnValue(makeStream(raws));
      allSimilar(raws.map(({ id }) => id));
      mocks.burst.getGroupedAssetNames.mockResolvedValue(
        [0, 1, 2].map((i) => ({
          id: `shot${i}-jpg`,
          originalFileName: `PXL_${i}.RAW-01.jpg`,
          dateTimeOriginal: at(i * 1500),
          make: 'Google',
          model: 'Pixel 8 Pro',
        })),
      );

      await sut.handleQueueDetectBursts();

      expect(mocks.burst.create).not.toHaveBeenCalled();
    });

    it('splits two bursts separated by a gap', async () => {
      const first = burst(3);
      const second = burst(3).map((f) => ({
        ...f,
        id: `late-${f.id}`,
        originalFileName: `LATE_${f.originalFileName}`,
        dateTimeOriginal: new Date(f.dateTimeOriginal!.getTime() + 600_000),
      }));
      mocks.burst.streamForBurstDetection.mockReturnValue(makeStream([...first, ...second]));
      mocks.burst.getEmbeddingDistances.mockImplementation(({ assetIds }: { assetIds: string[] }) =>
        Promise.resolve(assetIds.map((assetId) => ({ assetId, distance: 0.01 }))),
      );

      await sut.handleQueueDetectBursts();

      expect(mocks.burst.create).toHaveBeenCalledTimes(2);
    });

    it('does not merge runs across owners', async () => {
      const mine = burst(3);
      const theirs = burst(3).map((f) => ({ ...f, id: `other-${f.id}`, ownerId: 'owner-2' }));
      mocks.burst.streamForBurstDetection.mockReturnValue(makeStream([...mine, ...theirs]));
      mocks.burst.getEmbeddingDistances.mockImplementation(({ assetIds }: { assetIds: string[] }) =>
        Promise.resolve(assetIds.map((assetId) => ({ assetId, distance: 0.01 }))),
      );

      await sut.handleQueueDetectBursts();

      expect(mocks.burst.create).toHaveBeenCalledTimes(2);
      expect(mocks.burst.create.mock.calls.map((call) => call[0])).toEqual(['owner-1', 'owner-2']);
    });
  });
});
