import { Injectable } from '@nestjs/common';
import { OnJob } from 'src/decorators';
import { AssetVisibility, JobName, JobStatus, QueueName } from 'src/enum';
import { BaseService } from 'src/services/base.service';
import { JobOf } from 'src/types';
import { mimeTypes } from 'src/utils/mime-types';
import { batched, isRawJpegStackingEnabled } from 'src/utils/misc';

/**
 * A camera that saves RAW+JPEG writes the two files a fraction of a second apart rather than at
 * the same instant — a Pixel 8 Pro is off by up to ~0.9s — so the rule needs a tolerance.
 */
export const RAW_JPEG_MAX_GAP_MS = 2000;

/**
 * Variant markers cameras append to the shared base name, e.g. the Pixel's
 * `X.RAW-01.jpg` / `X.RAW-02.ORIGINAL.dng` and `X.RAW-01.MP.COVER.jpg` for a motion photo.
 * Only these exact tokens are stripped: anything else (`.PORTRAIT`, `.PANO`, a user's own
 * dotted filename) is left alone so unrelated files can never collapse onto the same stem.
 */
const VARIANT_TOKEN = /\.(raw-\d+|raw|original|cover|mp)$/i;

/** `PXL_1234.RAW-02.ORIGINAL.dng` -> `pxl_1234`; `IMG_0001.DNG` -> `img_0001`. */
export const normalizeStem = (fileName: string): string => {
  let stem = fileName.replace(/\.[^.]+$/, '');
  let stripped = stem.replace(VARIANT_TOKEN, '');
  while (stripped !== stem) {
    stem = stripped;
    stripped = stem.replace(VARIANT_TOKEN, '');
  }
  return stem.toLowerCase();
};

export interface AutoStackCandidate {
  id: string;
  ownerId: string;
  originalFileName: string;
  stackId: string | null;
  visibility: AssetVisibility;
  dateTimeOriginal: Date | null;
  make: string | null;
  model: string | null;
}

/**
 * True when `a` and `b` are the RAW and the JPEG of one press of the shutter.
 *
 * Deliberately conservative — every condition has to hold, because a wrong pair hides a photo
 * behind another one in the timeline.
 */
export const isRawJpegPair = (a: AutoStackCandidate, b: AutoStackCandidate): boolean => {
  if (a.id === b.id || a.ownerId !== b.ownerId) {
    return false;
  }

  // never touch an asset that is already in a stack — that stack may be the user's own
  if (a.stackId || b.stackId) {
    return false;
  }

  // exactly one side is RAW: two JPEGs are not a RAW+JPEG pair, and neither are two RAWs
  if (mimeTypes.isRaw(a.originalFileName) === mimeTypes.isRaw(b.originalFileName)) {
    return false;
  }

  if (normalizeStem(a.originalFileName) !== normalizeStem(b.originalFileName)) {
    return false;
  }

  if (!a.dateTimeOriginal || !b.dateTimeOriginal) {
    return false;
  }

  if (Math.abs(a.dateTimeOriginal.getTime() - b.dateTimeOriginal.getTime()) > RAW_JPEG_MAX_GAP_MS) {
    return false;
  }

  // a camera body only writes one pair at a time; differing bodies mean two different shots
  return (!a.make || !b.make || a.make === b.make) && (!a.model || !b.model || a.model === b.model);
};

/**
 * The JPEG leads the stack: it is the file the timeline can render straight away, and it is what
 * the phone's own gallery shows for the same shot.
 */
export const orderPair = (a: AutoStackCandidate, b: AutoStackCandidate): [string, string] =>
  mimeTypes.isRaw(a.originalFileName) ? [b.id, a.id] : [a.id, b.id];

@Injectable()
export class AutoStackService extends BaseService {
  @OnJob({ name: JobName.AssetAutoStackQueueAll, queue: QueueName.AutoStack })
  async handleQueueAutoStack(): Promise<JobStatus> {
    const { image } = await this.getConfig({ withCache: false });
    if (!isRawJpegStackingEnabled(image)) {
      return JobStatus.Skipped;
    }

    // Fan out one job per candidate rather than pairing inline: the pass then holds nothing in
    // memory, reports progress through the queue, survives a restart, and each pair is matched
    // against the database as it stands at that moment instead of a cursor snapshot.
    for await (const assets of batched(this.assetJobRepository.streamForAutoStack())) {
      await this.jobRepository.queueAll(
        assets.map((asset) => ({ name: JobName.AssetAutoStack, data: { id: asset.id } })),
      );
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetAutoStack, queue: QueueName.AutoStack })
  async handleAutoStack({ id }: JobOf<JobName.AssetAutoStack>): Promise<JobStatus> {
    const { image } = await this.getConfig({ withCache: true });
    if (!isRawJpegStackingEnabled(image)) {
      return JobStatus.Skipped;
    }

    const asset = await this.assetJobRepository.getForAutoStackJob(id);
    if (!asset) {
      this.logger.error(`Asset ${id} not found`);
      return JobStatus.Failed;
    }

    if (asset.stackId) {
      this.logger.debug(`Asset ${id} is already part of a stack, skipping`);
      return JobStatus.Skipped;
    }

    // a hidden or locked asset must not become the primary of a stack whose other member is
    // visible — the sibling would vanish from the timeline behind an invisible primary
    if (asset.visibility === AssetVisibility.Hidden) {
      this.logger.debug(`Asset ${id} is not visible, skipping`);
      return JobStatus.Skipped;
    }

    if (asset.visibility === AssetVisibility.Locked) {
      this.logger.debug(`Asset ${id} is locked, skipping`);
      return JobStatus.Skipped;
    }

    if (!asset.dateTimeOriginal) {
      this.logger.debug(`Asset ${id} has no capture time, skipping`);
      return JobStatus.Skipped;
    }

    const time = asset.dateTimeOriginal.getTime();
    const candidates = await this.assetJobRepository.getAutoStackCandidates({
      ownerId: asset.ownerId,
      from: new Date(time - RAW_JPEG_MAX_GAP_MS),
      to: new Date(time + RAW_JPEG_MAX_GAP_MS),
      excludeId: asset.id,
    });

    const twin = candidates.find((candidate) => isRawJpegPair(asset, candidate));
    if (!twin) {
      return JobStatus.Success;
    }

    await this.createStack(asset, twin);

    return JobStatus.Success;
  }

  private async createStack(a: AutoStackCandidate, b: AutoStackCandidate): Promise<void> {
    const [primaryId, secondaryId] = orderPair(a, b);
    const stack = await this.stackRepository.create({ ownerId: a.ownerId }, [primaryId, secondaryId]);
    await this.eventRepository.emit('StackCreate', { stackId: stack.id, userId: a.ownerId });
    this.logger.debug(`Stacked ${a.originalFileName} with ${b.originalFileName}`);
  }
}
