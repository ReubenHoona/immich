import { AssetVisibility, JobName, JobStatus } from 'src/enum';
import {
  AutoStackCandidate,
  AutoStackService,
  isRawJpegPair,
  normalizeStem,
  orderPair,
} from 'src/services/auto-stack.service';
import { makeStream, newTestService, ServiceMocks } from 'test/utils';

const T0 = new Date('2026-08-08T00:44:02.536Z');
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

const candidate = (overrides: Partial<AutoStackCandidate> = {}): AutoStackCandidate => ({
  id: 'asset-1',
  ownerId: 'owner-1',
  originalFileName: 'PXL_20260808_004402536.RAW-01.jpg',
  stackId: null,
  visibility: AssetVisibility.Timeline,
  dateTimeOriginal: T0,
  make: 'Google',
  model: 'Pixel 8 Pro',
  ...overrides,
});

/** The two files a Pixel writes for one shot, timed as the real camera does (~0.9s apart). */
const pixelPair = (stem = 'PXL_20260808_004402536', gapMs = 887) => ({
  jpg: candidate({ id: `${stem}-jpg`, originalFileName: `${stem}.RAW-01.jpg` }),
  dng: candidate({
    id: `${stem}-dng`,
    originalFileName: `${stem}.RAW-02.ORIGINAL.dng`,
    dateTimeOriginal: at(gapMs),
  }),
});

describe('normalizeStem', () => {
  it.each([
    ['PXL_20260808_004402536.RAW-01.jpg', 'pxl_20260808_004402536'],
    ['PXL_20260808_004402536.RAW-02.ORIGINAL.dng', 'pxl_20260808_004402536'],
    ['PXL_20260808_004402536.RAW-01.MP.COVER.jpg', 'pxl_20260808_004402536'],
    ['IMG_1234.JPG', 'img_1234'],
    ['IMG_1234.DNG', 'img_1234'],
    ['DSC_0001.NEF', 'dsc_0001'],
    ['holiday.jpg', 'holiday'],
  ])('normalizes %s to %s', (fileName, expected) => {
    expect(normalizeStem(fileName)).toBe(expected);
  });

  it('leaves unknown dotted suffixes alone so unrelated files cannot collapse together', () => {
    // stripping `.PORTRAIT` would be wrong: it is a distinct shot, not a variant of another file
    expect(normalizeStem('PXL_20260808_031700236.PORTRAIT.jpg')).toBe('pxl_20260808_031700236.portrait');
    expect(normalizeStem('2026.08.08-shot1.jpg')).toBe('2026.08.08-shot1');
    expect(normalizeStem('2026.08.08-shot2.dng')).toBe('2026.08.08-shot2');
  });
});

describe('isRawJpegPair', () => {
  it('pairs a Pixel RAW-01 jpg with its RAW-02 dng', () => {
    const { jpg, dng } = pixelPair();
    expect(isRawJpegPair(jpg, dng)).toBe(true);
    expect(isRawJpegPair(dng, jpg)).toBe(true);
  });

  it('pairs Apple ProRAW (same stem, different extension)', () => {
    const heic = candidate({ id: 'a', originalFileName: 'IMG_1234.HEIC' });
    const dng = candidate({ id: 'b', originalFileName: 'IMG_1234.DNG', dateTimeOriginal: at(120) });
    expect(isRawJpegPair(heic, dng)).toBe(true);
  });

  it('pairs a Nikon NEF with its jpg', () => {
    const jpg = candidate({ id: 'a', originalFileName: 'DSC_0001.JPG', make: 'NIKON', model: 'Z 6' });
    const nef = candidate({ id: 'b', originalFileName: 'DSC_0001.NEF', make: 'NIKON', model: 'Z 6' });
    expect(isRawJpegPair(jpg, nef)).toBe(true);
  });

  it('rejects two JPEGs', () => {
    const a = candidate({ id: 'a', originalFileName: 'IMG_1234.JPG' });
    const b = candidate({ id: 'b', originalFileName: 'IMG_1234.JPG' });
    expect(isRawJpegPair(a, b)).toBe(false);
  });

  it('rejects two RAWs', () => {
    const a = candidate({ id: 'a', originalFileName: 'IMG_1234.DNG' });
    const b = candidate({ id: 'b', originalFileName: 'IMG_1234.NEF' });
    expect(isRawJpegPair(a, b)).toBe(false);
  });

  it('rejects a different stem', () => {
    const jpg = candidate({ id: 'a', originalFileName: 'PXL_1.RAW-01.jpg' });
    const dng = candidate({ id: 'b', originalFileName: 'PXL_2.RAW-02.ORIGINAL.dng' });
    expect(isRawJpegPair(jpg, dng)).toBe(false);
  });

  it('rejects the same stem captured more than the tolerance apart', () => {
    const { jpg, dng } = pixelPair('PXL_1', 30_000);
    expect(isRawJpegPair(jpg, dng)).toBe(false);
  });

  it('accepts right up to the tolerance and rejects just past it', () => {
    expect(isRawJpegPair(pixelPair('PXL_1', 2000).jpg, pixelPair('PXL_1', 2000).dng)).toBe(true);
    expect(isRawJpegPair(pixelPair('PXL_1', 2001).jpg, pixelPair('PXL_1', 2001).dng)).toBe(false);
  });

  it('rejects assets belonging to different owners', () => {
    const { jpg, dng } = pixelPair();
    expect(isRawJpegPair(jpg, { ...dng, ownerId: 'owner-2' })).toBe(false);
  });

  it('rejects when either asset is already stacked', () => {
    const { jpg, dng } = pixelPair();
    expect(isRawJpegPair({ ...jpg, stackId: 'stack-1' }, dng)).toBe(false);
    expect(isRawJpegPair(jpg, { ...dng, stackId: 'stack-1' })).toBe(false);
  });

  it('rejects different camera bodies', () => {
    const { jpg, dng } = pixelPair();
    expect(isRawJpegPair(jpg, { ...dng, model: 'Pixel 7' })).toBe(false);
    expect(isRawJpegPair(jpg, { ...dng, make: 'samsung' })).toBe(false);
  });

  it('allows a missing make/model on one side rather than guessing', () => {
    const { jpg, dng } = pixelPair();
    expect(isRawJpegPair(jpg, { ...dng, make: null, model: null })).toBe(true);
  });

  it('rejects when a capture time is missing', () => {
    const { jpg, dng } = pixelPair();
    expect(isRawJpegPair(jpg, { ...dng, dateTimeOriginal: null })).toBe(false);
  });

  it('rejects an asset against itself', () => {
    const { jpg } = pixelPair();
    expect(isRawJpegPair(jpg, jpg)).toBe(false);
  });
});

describe('orderPair', () => {
  it('always puts the non-RAW file first, whichever way round it is given', () => {
    const { jpg, dng } = pixelPair();
    expect(orderPair(jpg, dng)).toEqual([jpg.id, dng.id]);
    expect(orderPair(dng, jpg)).toEqual([jpg.id, dng.id]);
  });
});

describe(AutoStackService.name, () => {
  let sut: AutoStackService;
  let mocks: ServiceMocks;

  const enable = (enabled: boolean) => mocks.systemMetadata.get.mockResolvedValue({ image: { stackRawJpeg: enabled } });

  beforeEach(() => {
    ({ sut, mocks } = newTestService(AutoStackService));
    enable(true);
    mocks.stack.create.mockResolvedValue({ id: 'stack-1' } as never);
  });

  it('should be defined', () => {
    expect(sut).toBeDefined();
  });

  describe('handleQueueAutoStack', () => {
    it('skips when the feature is disabled', async () => {
      enable(false);
      await expect(sut.handleQueueAutoStack()).resolves.toBe(JobStatus.Skipped);
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('queues one job per candidate rather than pairing inline', async () => {
      const { jpg, dng } = pixelPair();
      mocks.assetJob.streamForAutoStack.mockReturnValue(makeStream([{ id: jpg.id }, { id: dng.id }]));

      await expect(sut.handleQueueAutoStack()).resolves.toBe(JobStatus.Success);

      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.AssetAutoStack, data: { id: jpg.id } },
        { name: JobName.AssetAutoStack, data: { id: dng.id } },
      ]);
      // the sweep itself must never touch the database
      expect(mocks.stack.create).not.toHaveBeenCalled();
    });

    it('queues nothing when the stream is empty', async () => {
      mocks.assetJob.streamForAutoStack.mockReturnValue(makeStream([]));

      await expect(sut.handleQueueAutoStack()).resolves.toBe(JobStatus.Success);

      // batched() yields nothing for an empty stream, so no batch is ever enqueued
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });
  });

  describe('handleAutoStack', () => {
    it('skips when the feature is disabled', async () => {
      enable(false);
      await expect(sut.handleAutoStack({ id: 'asset-1' })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.assetJob.getForAutoStackJob).not.toHaveBeenCalled();
    });

    it('fails when the asset is gone', async () => {
      mocks.assetJob.getForAutoStackJob.mockResolvedValue(void 0);
      await expect(sut.handleAutoStack({ id: 'asset-1' })).resolves.toBe(JobStatus.Failed);
    });

    it('skips an asset that is already stacked', async () => {
      mocks.assetJob.getForAutoStackJob.mockResolvedValue(candidate({ stackId: 'stack-9' }));
      await expect(sut.handleAutoStack({ id: 'asset-1' })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.assetJob.getAutoStackCandidates).not.toHaveBeenCalled();
    });

    it.each([
      ['hidden', AssetVisibility.Hidden],
      ['locked', AssetVisibility.Locked],
    ])('skips a %s asset so it cannot hide a visible sibling behind it', async (_label, visibility) => {
      mocks.assetJob.getForAutoStackJob.mockResolvedValue(candidate({ visibility }));
      await expect(sut.handleAutoStack({ id: 'asset-1' })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.assetJob.getAutoStackCandidates).not.toHaveBeenCalled();
    });

    it('skips an asset with no capture time', async () => {
      mocks.assetJob.getForAutoStackJob.mockResolvedValue(candidate({ dateTimeOriginal: null }));
      await expect(sut.handleAutoStack({ id: 'asset-1' })).resolves.toBe(JobStatus.Skipped);
    });

    it('searches only the tolerance window around the asset', async () => {
      const { jpg } = pixelPair();
      mocks.assetJob.getForAutoStackJob.mockResolvedValue(jpg);
      mocks.assetJob.getAutoStackCandidates.mockResolvedValue([]);

      await sut.handleAutoStack({ id: jpg.id });

      expect(mocks.assetJob.getAutoStackCandidates).toHaveBeenCalledWith({
        ownerId: 'owner-1',
        from: at(-2000),
        to: at(2000),
        excludeId: jpg.id,
      });
      expect(mocks.stack.create).not.toHaveBeenCalled();
    });

    it('stacks the newly uploaded RAW onto its already-present JPEG', async () => {
      const { jpg, dng } = pixelPair();
      mocks.assetJob.getForAutoStackJob.mockResolvedValue(dng);
      mocks.assetJob.getAutoStackCandidates.mockResolvedValue([jpg]);

      await expect(sut.handleAutoStack({ id: dng.id })).resolves.toBe(JobStatus.Success);

      expect(mocks.stack.create).toHaveBeenCalledWith({ ownerId: 'owner-1' }, [jpg.id, dng.id]);
    });

    it('ignores near-in-time assets that are not the twin', async () => {
      const { dng } = pixelPair();
      const unrelated = candidate({ id: 'other', originalFileName: 'PXL_9.RAW-01.jpg', dateTimeOriginal: at(100) });
      mocks.assetJob.getForAutoStackJob.mockResolvedValue(dng);
      mocks.assetJob.getAutoStackCandidates.mockResolvedValue([unrelated]);

      await expect(sut.handleAutoStack({ id: dng.id })).resolves.toBe(JobStatus.Success);

      expect(mocks.stack.create).not.toHaveBeenCalled();
    });
  });
});
