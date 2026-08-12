import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { OnJob } from 'src/decorators';
import { AuthDto } from 'src/dtos/auth.dto';
import { BurstGroupResponseDto, BurstGroupSearchDto, mapBurstGroup } from 'src/dtos/burst.dto';
import { AssetVisibility, BurstGroupStatus, JobName, JobStatus, Permission, QueueName } from 'src/enum';
import { BaseService } from 'src/services/base.service';
import { mimeTypes } from 'src/utils/mime-types';
import { isBurstDetectionEnabled } from 'src/utils/misc';

/**
 * Variant markers a camera appends to the shared base name of one shot — a Pixel burst of five
 * presses is ten files, `X.RAW-01.jpg` plus `X.RAW-02.ORIGINAL.dng` each time. Collapsing them
 * keeps a burst counted in shots rather than in files.
 */
const VARIANT_TOKEN = /\.(raw-\d+|raw|original|cover|mp)$/i;

/** A camera writes the RAW and the JPEG of one shot within a second or so of each other. */
export const RAW_TWIN_MAX_GAP_MS = 2000;

/** `POST /stacks` refuses fewer than two assets, so a group below this cannot be accepted. */
const MIN_STACK_ASSETS = 2;

/**
 * A run longer than this is not a burst — it is a time-lapse, a dashcam sequence, or a bulk import
 * whose files all share one fallback capture time. Cutting it keeps the similarity query and the
 * member insert bounded no matter what the library contains.
 */
export const MAX_RUN_FRAMES = 100;

export const normalizeStem = (fileName: string): string => {
  let stem = fileName.replace(/\.[^.]+$/, '');
  let stripped = stem.replace(VARIANT_TOKEN, '');
  while (stripped !== stem) {
    stem = stripped;
    stripped = stem.replace(VARIANT_TOKEN, '');
  }
  return stem.toLowerCase();
};

export interface BurstCandidate {
  id: string;
  ownerId: string;
  originalFileName: string;
  dateTimeOriginal: Date | null;
  make: string | null;
  model: string | null;
}

/** Two frames belong to the same run when one camera took them within the window of each other. */
export const isSameRun = (previous: BurstCandidate, next: BurstCandidate, windowMs: number): boolean => {
  if (previous.ownerId !== next.ownerId) {
    return false;
  }

  if (previous.make !== next.make || previous.model !== next.model) {
    return false;
  }

  if (!previous.dateTimeOriginal || !next.dateTimeOriginal) {
    return false;
  }

  const gap = next.dateTimeOriginal.getTime() - previous.dateTimeOriginal.getTime();
  return gap >= 0 && gap <= windowMs;
};

/**
 * Reduce a run to one frame per shot: a burst's RAW and JPEG of the same press are one frame, not
 * two. The non-RAW file wins, for the same reason it leads a RAW+JPEG stack — and because a RAW
 * renders differently enough from its JPEG to sit a measurable distance away in embedding space,
 * which would otherwise make a burst look less self-similar than it is.
 */
export const collapseTwins = (run: BurstCandidate[]): BurstCandidate[] => {
  const byStem = new Map<string, BurstCandidate>();
  for (const frame of run) {
    const stem = normalizeStem(frame.originalFileName);
    const existing = byStem.get(stem);
    if (!existing || (mimeTypes.isRaw(existing.originalFileName) && !mimeTypes.isRaw(frame.originalFileName))) {
      byStem.set(stem, frame);
    }
  }

  return byStem
    .values()
    .toArray()
    .sort((a, b) => (a.dateTimeOriginal?.getTime() ?? 0) - (b.dateTimeOriginal?.getTime() ?? 0));
};

export interface HandledFrame {
  originalFileName: string;
  dateTimeOriginal: Date | null;
  make: string | null;
  model: string | null;
}

/**
 * True when this frame is the same shot as one already in a group — same camera, same normalized
 * stem, and close enough in time to be that shot rather than a filename-counter collision years
 * apart.
 */
export const isAlreadyHandled = (frame: BurstCandidate, handled: HandledFrame[]): boolean => {
  const stem = normalizeStem(frame.originalFileName);
  return handled.some(
    (seen) =>
      normalizeStem(seen.originalFileName) === stem &&
      seen.make === frame.make &&
      seen.model === frame.model &&
      !!seen.dateTimeOriginal &&
      !!frame.dateTimeOriginal &&
      Math.abs(seen.dateTimeOriginal.getTime() - frame.dateTimeOriginal.getTime()) <= RAW_TWIN_MAX_GAP_MS,
  );
};

@Injectable()
export class BurstService extends BaseService {
  async getAll(auth: AuthDto, dto: BurstGroupSearchDto): Promise<BurstGroupResponseDto[]> {
    const groups = await this.burstRepository.getAllForUser(auth.user.id, dto.status);
    const assetIds = groups.flatMap((group) => group.members.map(({ assetId }) => assetId));
    const assets = await this.loadVisibleAssets(assetIds);
    const assetById = new Map(assets.map((asset) => [asset.id, asset]));

    return groups.map((group) => mapBurstGroup(group, assetById, auth)).filter((group) => group.assets.length >= 2);
  }

  async accept(auth: AuthDto, id: string): Promise<BurstGroupResponseDto> {
    await this.requireAccess({ auth, permission: Permission.BurstGroupUpdate, ids: [id] });
    const group = await this.load(id);

    if (group.status !== BurstGroupStatus.Candidate) {
      throw new BadRequestException('Only a candidate burst can be accepted');
    }

    // The member list was frozen when the group was detected, so re-check it against the database
    // before stacking: in the meantime a frame may have been trashed, or stacked by hand or by
    // RAW+JPEG pairing. `stackRepository.create` deletes and rebuilds any stack whose primary is in
    // the id list, so accepting a stale list would silently destroy the user's own stack.
    const frames = await this.burstRepository.getStackableMembers(id);
    if (frames.length < MIN_STACK_ASSETS) {
      throw new BadRequestException('Too few frames of this burst are still available to stack');
    }

    // members ordered by distance, so the frame closest to the reference leads the stack
    const frameIds = frames.map(({ assetId }) => assetId);
    const assetIds = [...frameIds, ...(await this.findTwins(auth.user.id, frameIds))];

    // the same check `StackService.create` performs — it is what forwards elevated permission into
    // the locked-folder filter, so a locked frame cannot be stacked from an unelevated session
    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: assetIds });

    const stack = await this.stackRepository.create({ ownerId: auth.user.id }, assetIds);
    await this.eventRepository.emit('StackCreate', { stackId: stack.id, userId: auth.user.id });
    await this.burstRepository.setStatus(id, BurstGroupStatus.Accepted);

    return this.get(auth, id);
  }

  async dismiss(auth: AuthDto, id: string): Promise<BurstGroupResponseDto> {
    await this.requireAccess({ auth, permission: Permission.BurstGroupUpdate, ids: [id] });
    const group = await this.load(id);

    if (group.status === BurstGroupStatus.Accepted) {
      throw new BadRequestException('An accepted burst cannot be dismissed');
    }

    await this.burstRepository.setStatus(id, BurstGroupStatus.Dismissed);

    return this.get(auth, id);
  }

  async get(auth: AuthDto, id: string): Promise<BurstGroupResponseDto> {
    await this.requireAccess({ auth, permission: Permission.BurstGroupRead, ids: [id] });
    const group = await this.load(id);
    const assets = await this.loadVisibleAssets(group.members.map(({ assetId }) => assetId));
    return mapBurstGroup(group, new Map(assets.map((asset) => [asset.id, asset])), auth);
  }

  @OnJob({ name: JobName.AssetDetectBurstsQueueAll, queue: QueueName.BurstDetection })
  async handleQueueDetectBursts(): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isBurstDetectionEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    const { timeWindowSeconds, maxDistance, minAssets } = machineLearning.burstDetection;
    const windowMs = timeWindowSeconds * 1000;

    // Handled shots are tracked by normalized stem, not by asset id: a group holds one frame per
    // shot, so keying on ids would let the RAW twin of a dismissed shot come back as its own burst.
    // The stem alone is not unique across cameras, so `isAlreadyHandled` also requires the same
    // body and a capture time within a twin's distance.
    const handledStems = new Map<string, HandledFrame[]>();
    let created = 0;
    let run: BurstCandidate[] = [];

    const finishRun = async () => {
      const frames = collapseTwins(run);
      run = [];

      if (frames.length < minAssets) {
        return;
      }

      const ownerId = frames[0].ownerId;
      if (!handledStems.has(ownerId)) {
        // copy: the list is appended to as groups are created, and the caller's array is not ours
        handledStems.set(ownerId, [...(await this.burstRepository.getGroupedAssetNames(ownerId))]);
      }
      const handled = handledStems.get(ownerId)!;

      // A re-run must not re-offer a group the user already accepted or dismissed. Matching is by
      // normalized stem so the RAW twin of a handled shot cannot come back on its own — but stems
      // like IMG_0123 recycle across bodies and counter resets, so the match is confined to the
      // same camera and the same moment. Only the matched frames drop out; the rest of the run
      // still stands on its own.
      const remaining = frames.filter((frame) => !isAlreadyHandled(frame, handled));
      if (remaining.length < frames.length) {
        this.logger.debug(`Dropped ${frames.length - remaining.length} already-handled frame(s) from a run`);
      }
      if (remaining.length < minAssets) {
        return;
      }

      const members = await this.filterBySimilarity(remaining, maxDistance);
      if (members.length < minAssets) {
        return;
      }

      const group = await this.burstRepository.create(ownerId, members);
      const frameById = new Map(remaining.map((frame) => [frame.id, frame]));
      for (const { assetId } of members) {
        handled.push(frameById.get(assetId)!);
      }
      created++;
      this.logger.debug(`Burst group ${group.id}: ${members.length} frames`);
    };

    for await (const asset of this.burstRepository.streamForBurstDetection()) {
      const candidate = asset as BurstCandidate;
      const previous = run.at(-1);
      if (previous && !isSameRun(previous, candidate, windowMs)) {
        await finishRun();
      } else if (run.length >= MAX_RUN_FRAMES) {
        // a chain this long is not a burst; cut it so nothing downstream is unbounded
        this.logger.debug(`Cutting a run at ${MAX_RUN_FRAMES} frames — longer than any real burst`);
        await finishRun();
      }
      run.push(candidate);
    }

    await finishRun();

    this.logger.log(`Burst detection found ${created} candidate burst${created === 1 ? '' : 's'}`);

    return JobStatus.Success;
  }

  /**
   * Keep the frames that actually look like the first one. The time window alone would happily
   * group a shot of a bird and the shot of the ground you took a second later.
   */
  private async filterBySimilarity(frames: BurstCandidate[], maxDistance: number) {
    const referenceId = frames[0].id;
    const distances = await this.burstRepository.getEmbeddingDistances({
      referenceId,
      assetIds: frames.map(({ id }) => id),
    });

    if (distances.length < frames.length) {
      this.logger.debug(
        `Skipping a run of ${frames.length} frames: only ${distances.length} have a CLIP embedding yet`,
      );
      return [];
    }

    const byId = new Map(distances.map(({ assetId, distance }) => [assetId, distance]));

    return frames
      .map(({ id }) => ({ assetId: id, distance: byId.get(id) ?? Infinity }))
      .filter(({ distance }) => distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance);
  }

  /**
   * Hydrate members for a response, dropping anything the caller should not see. A group's member
   * list is a snapshot, so by the time it is read a frame may have been trashed or moved into the
   * locked folder — and `getByIdsWithAllRelationsButStacks` filters neither. `mapBurstGroup`
   * tolerates missing members, so the group simply shows fewer frames.
   */
  private async loadVisibleAssets(assetIds: string[]) {
    if (assetIds.length === 0) {
      return [];
    }

    const assets = await this.assetRepository.getByIdsWithAllRelationsButStacks(assetIds);
    return assets.filter(
      (asset) =>
        !asset.deletedAt &&
        (asset.visibility === AssetVisibility.Timeline || asset.visibility === AssetVisibility.Archive),
    );
  }

  /**
   * The RAW twins of a group's frames. A group holds one frame per shot, so stacking only those
   * would leave each shot's RAW loose in the timeline — and a later sweep would then offer those
   * RAWs as a burst of their own.
   */
  private async findTwins(ownerId: string, frameIds: string[]): Promise<string[]> {
    const frames = await this.assetRepository.getByIdsWithAllRelationsButStacks(frameIds);
    const times = frames
      .map((frame) => frame.exifInfo?.dateTimeOriginal)
      .filter((date): date is NonNullable<typeof date> => !!date)
      .map((date) => new Date(date).getTime())
      .filter((time) => Number.isFinite(time));

    if (times.length === 0) {
      return [];
    }

    const stems = new Set(frames.map((frame) => normalizeStem(frame.originalFileName)));
    const nearby = await this.burstRepository.getUnstackedInRange({
      ownerId,
      from: new Date(Math.min(...times) - RAW_TWIN_MAX_GAP_MS),
      to: new Date(Math.max(...times) + RAW_TWIN_MAX_GAP_MS),
    });

    const frameIdSet = new Set(frameIds);
    return nearby
      .filter(({ id, originalFileName }) => !frameIdSet.has(id) && stems.has(normalizeStem(originalFileName)))
      .map(({ id }) => id);
  }

  private async load(id: string) {
    const group = await this.burstRepository.getById(id);
    if (!group) {
      throw new NotFoundException('Burst group not found');
    }
    return group;
  }
}
