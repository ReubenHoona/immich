import { getConfig, LoginResponseDto, QueueCommand, QueueName, searchStacks, updateConfig } from '@immich/sdk';
import { asBearerAuth, utils } from 'src/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const setRawJpegStacking = async (accessToken: string, enabled: boolean) => {
  const config = await getConfig({ headers: asBearerAuth(accessToken) });
  await updateConfig(
    { systemConfigDto: { ...config, image: { ...config.image, stackRawJpeg: enabled } } },
    { headers: asBearerAuth(accessToken) },
  );
};

const settle = async (accessToken: string) => {
  await utils.waitForQueueFinish(accessToken, 'metadataExtraction');
  await utils.waitForQueueFinish(accessToken, 'thumbnailGeneration');
  await utils.waitForQueueFinish(accessToken, 'autoStack');
};

const backfill = async (accessToken: string) => {
  await utils.queueCommand(accessToken, QueueName.AutoStack, { command: QueueCommand.Start, force: false });
  await utils.waitForQueueFinish(accessToken, 'autoStack');
};

/**
 * A camera saving RAW+JPEG writes a shared base name with a variant suffix, and timestamps the two
 * files a fraction of a second apart. The generated images carry no EXIF, so `dateTimeOriginal`
 * falls back to `fileCreatedAt` and the capture gap can be set exactly.
 */
const uploadPair = async (accessToken: string, stem: string, gapMs = 900) => {
  const base = new Date('2026-08-08T00:44:02.536Z');
  const at = (offset: number) => new Date(base.getTime() + offset).toISOString();

  const jpg = await utils.createAsset(accessToken, {
    assetData: { filename: `${stem}.RAW-01.jpg` },
    fileCreatedAt: at(0),
    fileModifiedAt: at(0),
  });
  const dng = await utils.createAsset(accessToken, {
    assetData: { filename: `${stem}.RAW-02.ORIGINAL.dng` },
    fileCreatedAt: at(gapMs),
    fileModifiedAt: at(gapMs),
  });

  return { jpg, dng };
};

const stacksFor = (accessToken: string, primaryAssetId: string) =>
  searchStacks({ primaryAssetId }, { headers: asBearerAuth(accessToken) });

describe('auto stacking (RAW + JPEG)', () => {
  let admin: LoginResponseDto;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
  });

  afterAll(async () => {
    await utils.resetAdminConfig(admin.accessToken);
  });

  it('is disabled by default', async () => {
    const config = await getConfig({ headers: asBearerAuth(admin.accessToken) });
    expect(config.image.stackRawJpeg).toBe(false);
  });

  it('leaves a RAW+JPEG pair unstacked while disabled', async () => {
    await setRawJpegStacking(admin.accessToken, false);

    const { jpg } = await uploadPair(admin.accessToken, 'PXL_20260808_100000000');
    await settle(admin.accessToken);

    expect(await stacksFor(admin.accessToken, jpg.id)).toHaveLength(0);
  });

  it('stacks a newly uploaded RAW+JPEG pair with the JPEG as the primary', async () => {
    await setRawJpegStacking(admin.accessToken, true);

    const { jpg, dng } = await uploadPair(admin.accessToken, 'PXL_20260808_110000000');
    await settle(admin.accessToken);

    const stacks = await stacksFor(admin.accessToken, jpg.id);
    expect(stacks).toHaveLength(1);
    expect(stacks[0].primaryAssetId).toBe(jpg.id);
    expect(stacks[0].assets.map(({ id }) => id).sort()).toEqual([jpg.id, dng.id].sort());
  });

  it('does not stack two files that share a stem but not a moment', async () => {
    await setRawJpegStacking(admin.accessToken, true);

    const { jpg } = await uploadPair(admin.accessToken, 'PXL_20260808_120000000', 60_000);
    await settle(admin.accessToken);

    expect(await stacksFor(admin.accessToken, jpg.id)).toHaveLength(0);
  });

  it('backfills assets that were uploaded before the feature was switched on', async () => {
    await setRawJpegStacking(admin.accessToken, false);

    const { jpg, dng } = await uploadPair(admin.accessToken, 'PXL_20260808_130000000');
    await settle(admin.accessToken);
    expect(await stacksFor(admin.accessToken, jpg.id)).toHaveLength(0);

    await setRawJpegStacking(admin.accessToken, true);
    await backfill(admin.accessToken);

    const stacks = await stacksFor(admin.accessToken, jpg.id);
    expect(stacks).toHaveLength(1);
    expect(stacks[0].assets.map(({ id }) => id).sort()).toEqual([jpg.id, dng.id].sort());
  });

  it('leaves an existing manual stack alone', async () => {
    await setRawJpegStacking(admin.accessToken, false);

    const { jpg, dng } = await uploadPair(admin.accessToken, 'PXL_20260808_140000000');
    await settle(admin.accessToken);

    // the user deliberately made the RAW the primary — auto stacking must not undo that
    const manual = await utils.createStack(admin.accessToken, [dng.id, jpg.id]);

    await setRawJpegStacking(admin.accessToken, true);
    await backfill(admin.accessToken);

    const stacks = await stacksFor(admin.accessToken, dng.id);
    expect(stacks).toHaveLength(1);
    expect(stacks[0].id).toBe(manual.id);
    expect(stacks[0].primaryAssetId).toBe(dng.id);
  });

  it('does not pair a JPEG with another JPEG of the same stem', async () => {
    await setRawJpegStacking(admin.accessToken, true);

    const base = new Date('2026-08-08T02:00:00.000Z');
    const first = await utils.createAsset(admin.accessToken, {
      assetData: { filename: 'PXL_20260808_150000000.RAW-01.jpg' },
      fileCreatedAt: base.toISOString(),
      fileModifiedAt: base.toISOString(),
    });
    await utils.createAsset(admin.accessToken, {
      assetData: { filename: 'PXL_20260808_150000000.COVER.jpg' },
      fileCreatedAt: new Date(base.getTime() + 500).toISOString(),
      fileModifiedAt: new Date(base.getTime() + 500).toISOString(),
    });
    await settle(admin.accessToken);

    expect(await stacksFor(admin.accessToken, first.id)).toHaveLength(0);
  });
});
