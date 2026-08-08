import { BadRequestException, Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import { JOBS_ASSET_PAGINATION_SIZE } from 'src/constants';
import { StorageCore } from 'src/cores/storage.core';
import { OnJob } from 'src/decorators';
import { mapAsset } from 'src/dtos/asset-response.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { PanoramaGroupResponseDto, PanoramaGroupSearchDto, PanoramaGroupUpdateDto } from 'src/dtos/panorama.dto';
import {
  AssetType,
  AssetVisibility,
  ChecksumAlgorithm,
  JobName,
  JobStatus,
  PanoramaGroupStatus,
  Permission,
  QueueName,
  StorageFolder,
} from 'src/enum';
import { BaseService } from 'src/services/base.service';
import { JobItem, JobOf } from 'src/types';
import { isAssetChecksumConstraint } from 'src/utils/database';
import { isPanoramaEnabled } from 'src/utils/misc';

/** Frames sent to detection per cluster; stitching is separately capped by config.maxFrames. */
export const PANORAMA_DETECT_MAX_FRAMES = 16;

/** Twins closer than this are the same shot saved twice (e.g. RAW + JPEG). */
const TWIN_MAX_GAP_MS = 2000;

/** Formats the stitcher can decode at original resolution; anything else falls back to the preview. */
const STITCHABLE_ORIGINAL = /\.(jpe?g|png|tiff?|webp)$/i;

export interface PanoramaStreamRow {
  id: string;
  ownerId: string;
  originalFileName: string;
  make: string | null;
  model: string | null;
  dateTimeOriginal: Date;
  panoramaAt: Date | null;
}

/** Pixel RAW twins are named X.RAW-01.jpg / X.RAW-02.ORIGINAL.dng — normalize to a shared stem. */
export const normalizeStem = (fileName: string): string =>
  fileName
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/\.raw-0\d(\.original)?$/, '');

const isJpeg = (fileName: string) => /\.jpe?g$/i.test(fileName);

/** Collapse RAW+JPEG pairs of the same shot down to one frame, preferring the JPEG. */
export const collapseTwins = (rows: PanoramaStreamRow[]): PanoramaStreamRow[] => {
  const kept: PanoramaStreamRow[] = [];
  for (const row of rows) {
    const previous = kept.at(-1);
    if (
      previous &&
      normalizeStem(previous.originalFileName) === normalizeStem(row.originalFileName) &&
      Math.abs(row.dateTimeOriginal.getTime() - previous.dateTimeOriginal.getTime()) <= TWIN_MAX_GAP_MS
    ) {
      if (isJpeg(row.originalFileName) && !isJpeg(previous.originalFileName)) {
        kept[kept.length - 1] = row;
      }
      continue;
    }
    kept.push(row);
  }
  return kept;
};

export const isSameSeries = (a: PanoramaStreamRow, b: PanoramaStreamRow) =>
  a.ownerId === b.ownerId && a.make === b.make && a.model === b.model;

@Injectable()
export class PanoramaService extends BaseService {
  async getAll(auth: AuthDto, dto: PanoramaGroupSearchDto): Promise<PanoramaGroupResponseDto[]> {
    const groups = await this.panoramaRepository.getAllForUser(auth.user.id, dto.status);
    const assetIds = groups.flatMap((group) => group.members.map((member) => member.assetId));
    const assets = assetIds.length > 0 ? await this.assetRepository.getByIdsWithAllRelationsButStacks(assetIds) : [];
    const assetById = new Map(assets.map((asset) => [asset.id, asset]));
    return groups
      .map((group) => this.mapGroup(auth, group, assetById))
      .filter((group) => group.assets.length >= 2);
  }

  async get(auth: AuthDto, id: string): Promise<PanoramaGroupResponseDto> {
    await this.requireAccess({ auth, permission: Permission.PanoramaRead, ids: [id] });
    return this.load(auth, id);
  }

  async preview(auth: AuthDto, id: string): Promise<StreamableFile> {
    await this.requireAccess({ auth, permission: Permission.PanoramaRead, ids: [id] });
    const group = await this.panoramaRepository.getById(id);
    if (!group) {
      throw new NotFoundException('Panorama group not found');
    }
    const memberIds = group.members.map((member) => member.assetId);
    const assets = await this.assetJobRepository.getForPanoramaDetect(memberIds);
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    const previews = memberIds
      .map((assetId) => byId.get(assetId)?.previewFile)
      .filter((path): path is string => !!path);
    if (previews.length < 2) {
      throw new BadRequestException('Not enough source previews are available for this group');
    }
    const { data } = await this.machineLearningRepository.panoramaStitch(previews, {
      quality: 85,
      compositeResolution: 'preview',
    });
    return new StreamableFile(data, { type: 'image/jpeg' });
  }

  async queueStitch(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.PanoramaUpdate, ids: [id] });
    const group = await this.panoramaRepository.getById(id);
    if (!group) {
      throw new NotFoundException('Panorama group not found');
    }
    if (group.status !== PanoramaGroupStatus.Candidate && group.status !== PanoramaGroupStatus.Failed) {
      throw new BadRequestException(`Cannot stitch a group with status '${group.status}'`);
    }
    await this.jobRepository.queue({ name: JobName.PanoramaStitch, data: { id } });
  }

  async update(auth: AuthDto, id: string, dto: PanoramaGroupUpdateDto): Promise<PanoramaGroupResponseDto> {
    await this.requireAccess({ auth, permission: Permission.PanoramaUpdate, ids: [id] });
    const group = await this.panoramaRepository.getById(id);
    if (!group) {
      throw new NotFoundException('Panorama group not found');
    }
    const allowed =
      (group.status === PanoramaGroupStatus.Candidate && dto.status === PanoramaGroupStatus.Dismissed) ||
      (group.status === PanoramaGroupStatus.Dismissed && dto.status === PanoramaGroupStatus.Candidate) ||
      (group.status === PanoramaGroupStatus.Failed && dto.status === PanoramaGroupStatus.Dismissed);
    if (!allowed) {
      throw new BadRequestException(`Cannot change status from '${group.status}' to '${dto.status}'`);
    }
    await this.panoramaRepository.update(id, { status: dto.status });
    return this.load(auth, id);
  }

  private async load(auth: AuthDto, id: string): Promise<PanoramaGroupResponseDto> {
    const group = await this.panoramaRepository.getById(id);
    if (!group) {
      throw new NotFoundException('Panorama group not found');
    }
    const assetIds = group.members.map((member) => member.assetId);
    const assets = await this.assetRepository.getByIdsWithAllRelationsButStacks(assetIds);
    return this.mapGroup(auth, group, new Map(assets.map((asset) => [asset.id, asset])));
  }

  private mapGroup(
    auth: AuthDto,
    group: NonNullable<Awaited<ReturnType<PanoramaService['panoramaRepository']['getById']>>>,
    assetById: Map<string, Parameters<typeof mapAsset>[0]>,
  ): PanoramaGroupResponseDto {
    return {
      id: group.id,
      status: group.status,
      score: group.score,
      resultAssetId: group.resultAssetId,
      createdAt: group.createdAt.toISOString(),
      assets: group.members
        .map((member) => assetById.get(member.assetId))
        .filter((asset): asset is NonNullable<typeof asset> => !!asset)
        .map((asset) => mapAsset(asset, { auth })),
    };
  }

  @OnJob({ name: JobName.PanoramaQueueAll, queue: QueueName.Panorama })
  async handleQueueAll({ force }: JobOf<JobName.PanoramaQueueAll>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isPanoramaEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }
    const { maxGapSeconds, minFrames } = machineLearning.panorama;

    if (force) {
      await this.panoramaRepository.deletePending();
    }

    let jobs: JobItem[] = [];
    let clusters = 0;
    let cluster: PanoramaStreamRow[] = [];

    const flush = async () => {
      const frames = collapseTwins(cluster);
      cluster = [];
      if (frames.length < minFrames) {
        return;
      }
      if (!force && frames.every((frame) => frame.panoramaAt !== null)) {
        return;
      }
      // long sessions (slow deliberate sweeps) can exceed the per-detection frame cap;
      // split into overlapping windows so chains crossing a boundary are still found
      const step = PANORAMA_DETECT_MAX_FRAMES - 2;
      for (let start = 0; start === 0 || start + 2 < frames.length; start += step) {
        const window = frames.slice(start, start + PANORAMA_DETECT_MAX_FRAMES);
        if (window.length < minFrames) {
          break;
        }
        clusters++;
        jobs.push({ name: JobName.PanoramaDetect, data: { ids: window.map((frame) => frame.id) } });
      }
      if (jobs.length >= JOBS_ASSET_PAGINATION_SIZE) {
        await this.jobRepository.queueAll(jobs);
        jobs = [];
      }
    };

    for await (const row of this.assetJobRepository.streamForPanoramaJob()) {
      const item = row as PanoramaStreamRow;
      const previous = cluster.at(-1);
      if (
        previous &&
        (!isSameSeries(previous, item) ||
          item.dateTimeOriginal.getTime() - previous.dateTimeOriginal.getTime() > maxGapSeconds * 1000)
      ) {
        await flush();
      }
      cluster.push(item);
    }
    await flush();
    await this.jobRepository.queueAll(jobs);

    this.logger.log(`Queued ${clusters} panorama candidate cluster(s) for detection`);
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.PanoramaDetect, queue: QueueName.Panorama })
  async handleDetect({ ids }: JobOf<JobName.PanoramaDetect>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!isPanoramaEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }
    const config = machineLearning.panorama;

    const assets = await this.assetJobRepository.getForPanoramaDetect(ids);
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    const ordered = ids
      .map((id) => byId.get(id))
      .filter(
        (asset): asset is NonNullable<typeof asset> =>
          !!asset && !!asset.previewFile && asset.visibility !== AssetVisibility.Hidden,
      );

    if (ordered.length >= config.minFrames) {
      const response = await this.machineLearningRepository.panoramaDetect(
        ordered.map((asset) => asset.previewFile as string),
        {
          minOverlap: config.minOverlap,
          maxOverlap: config.maxOverlap,
          minInliers: config.minInliers,
          minDisplacement: config.minDisplacement,
        },
      );

      if (response.classification === 'panorama' && response.chainStart !== null && response.chainEnd !== null) {
        const chain = ordered.slice(response.chainStart, response.chainEnd + 1);
        if (chain.length >= config.minFrames) {
          const chainIds = chain.map((asset) => asset.id);
          const sortedChain = [...chainIds].sort();
          const settled = await this.panoramaRepository.getSettledMemberSets(chainIds);
          const alreadySettled = settled.some(
            (memberSet) =>
              memberSet.length === sortedChain.length && memberSet.every((value, i) => value === sortedChain[i]),
          );
          if (alreadySettled) {
            this.logger.debug(`Skipping already dismissed/completed panorama chain (${chainIds.length} frames)`);
          } else {
            await this.panoramaRepository.deletePendingByAssetIds(ids);
            const group = await this.panoramaRepository.create(
              {
                ownerId: chain[0].ownerId,
                status: PanoramaGroupStatus.Candidate,
                score: response.score,
                linkStats: {
                  frames: response.frames,
                  chainStart: response.chainStart,
                  chainEnd: response.chainEnd,
                  mixedDirections: response.mixedDirections,
                  links: response.links,
                },
              },
              chainIds,
            );
            this.logger.log(
              `Detected panorama candidate ${group.id} (${chainIds.length} frames, score ${response.score})`,
            );
            if (config.autoStitch) {
              await this.jobRepository.queue({ name: JobName.PanoramaStitch, data: { id: group.id } });
            }
          }
        }
      }
    }

    const now = new Date();
    await this.assetRepository.upsertJobStatus(...ids.map((assetId) => ({ assetId, panoramaAt: now })));
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.PanoramaStitch, queue: QueueName.Panorama })
  async handleStitch({ id }: JobOf<JobName.PanoramaStitch>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!isPanoramaEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }
    const config = machineLearning.panorama;

    const group = await this.panoramaRepository.getById(id);
    if (!group) {
      this.logger.warn(`Panorama group ${id} not found`);
      return JobStatus.Failed;
    }
    if (group.status === PanoramaGroupStatus.Completed || group.status === PanoramaGroupStatus.Dismissed) {
      return JobStatus.Skipped;
    }
    await this.panoramaRepository.update(id, { status: PanoramaGroupStatus.Processing });

    let outputPath: string | null = null;
    try {
      const memberIds = group.members.map((member) => member.assetId);
      const assets = await this.assetJobRepository.getForPanoramaStitch(memberIds);
      const byId = new Map(assets.map((asset) => [asset.id, asset]));
      const frames = memberIds
        .map((assetId) => byId.get(assetId))
        .filter((asset): asset is NonNullable<typeof asset> => !!asset)
        .slice(0, config.maxFrames);
      if (frames.length < config.minFrames) {
        throw new Error(`Only ${frames.length} of ${memberIds.length} source frames are still available`);
      }

      const paths = frames.map((frame) => {
        if (STITCHABLE_ORIGINAL.test(frame.originalPath)) {
          return frame.originalPath;
        }
        if (!frame.previewFile) {
          throw new Error(`Frame ${frame.id} is not stitchable (unsupported original, no preview)`);
        }
        return frame.previewFile;
      });

      const { data, width, height } = await this.machineLearningRepository.panoramaStitch(paths, {
        quality: config.quality,
        compositeResolution: config.compositeResolution,
      });

      const ownerId = group.ownerId;
      const panoramaId = this.cryptoRepository.randomUUID();
      outputPath = StorageCore.getNestedPath(StorageFolder.Upload, ownerId, `${panoramaId}.jpg`);
      this.storageCore.ensureFolders(outputPath);
      await this.storageRepository.createFile(outputPath, data);

      // Timeline placement comes from the middle frame. Deliberately no Make/Model:
      // the result must never satisfy the clustering predicate itself.
      const middle = frames[Math.floor(frames.length / 2)];
      const dateTimeOriginal = middle.dateTimeOriginal ?? middle.fileCreatedAt;
      await this.mediaRepository.writeExif({ dateTimeOriginal, timeZone: middle.timeZone }, outputPath);

      const stats = await this.storageRepository.stat(outputPath);
      const checksum = await this.cryptoRepository.hashFile(outputPath);
      const checksumQuery = { ownerId, checksum };

      let asset = await this.assetRepository.getByChecksum(checksumQuery);
      if (asset) {
        // A byte-identical panorama already exists (e.g. job re-run) — reuse it.
        await this.storageRepository.unlink(outputPath);
        outputPath = null;
      } else {
        try {
          asset = await this.assetRepository.create({
            id: panoramaId,
            ownerId,
            libraryId: null,
            type: AssetType.Image,
            originalPath: outputPath,
            originalFileName: `PANO_${dateTimeOriginal.toISOString().replaceAll(/[:-]/g, '').slice(0, 15)}.jpg`,
            checksum,
            checksumAlgorithm: ChecksumAlgorithm.sha1File,
            fileCreatedAt: dateTimeOriginal,
            fileModifiedAt: stats.mtime,
            localDateTime: middle.localDateTime,
            visibility: AssetVisibility.Timeline,
          });
          outputPath = null; // now owned by the asset record
          await this.userRepository.updateUsage(ownerId, stats.size);
        } catch (error) {
          if (!isAssetChecksumConstraint(error)) {
            throw error;
          }
          asset = await this.assetRepository.getByChecksum(checksumQuery);
          if (!asset) {
            throw new Error('Panorama asset vanished after checksum conflict', { cause: error });
          }
        }
      }

      await this.assetRepository.upsertExif({
        exif: { assetId: asset.id, fileSizeInByte: stats.size },
        lockedPropertiesBehavior: 'override',
      });
      await this.jobRepository.queue({ name: JobName.AssetExtractMetadata, data: { id: asset.id, source: 'upload' } });

      if (config.stackSources) {
        try {
          await this.stackRepository.create({ ownerId }, [asset.id, ...memberIds]);
        } catch (error) {
          this.logger.warn(`Could not stack panorama ${asset.id} with its sources: ${error}`);
        }
      }

      await this.panoramaRepository.update(id, { status: PanoramaGroupStatus.Completed, resultAssetId: asset.id });
      this.logger.log(`Stitched panorama ${asset.id} (${width}x${height}) from ${frames.length} frames`);
      return JobStatus.Success;
    } catch (error) {
      this.logger.error(`Panorama stitch for group ${id} failed: ${error instanceof Error ? error.message : error}`);
      if (outputPath) {
        await this.storageRepository.unlink(outputPath).catch(() => {});
      }
      await this.panoramaRepository.update(id, { status: PanoramaGroupStatus.Failed }).catch(() => {});
      return JobStatus.Failed;
    }
  }
}
