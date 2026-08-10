import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import sanitize from 'sanitize-filename';
import { StorageCore } from 'src/cores/storage.core';
import { Asset, AuthSharedLink } from 'src/database';
import {
  AssetBulkUploadCheckResponseDto,
  AssetMediaResponseDto,
  AssetMediaStatus,
  AssetRejectReason,
  AssetUploadAction,
} from 'src/dtos/asset-media-response.dto';
import {
  AssetBulkUploadCheckDto,
  AssetMediaCreateDto,
  AssetMediaOptionsDto,
  AssetMediaSize,
  UploadFieldName,
} from 'src/dtos/asset-media.dto';
import { AssetDownloadOriginalDto } from 'src/dtos/asset.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import {
  AssetFileType,
  AssetPathType,
  AssetVisibility,
  CacheControl,
  ChecksumAlgorithm,
  JobName,
  Permission,
  StorageFolder,
} from 'src/enum';
import { AuthRequest } from 'src/middleware/auth.guard';
import { BaseService } from 'src/services/base.service';
import { UploadFile, UploadRequest } from 'src/types';
import { requireUploadAccess } from 'src/utils/access';
import { asUploadRequest, onBeforeLink } from 'src/utils/asset.util';
import { isAssetChecksumConstraint } from 'src/utils/database';
import { getFilenameExtension, getFileNameWithoutExtension, ImmichFileResponse } from 'src/utils/file';
import { mimeTypes } from 'src/utils/mime-types';
import { fromChecksum } from 'src/utils/request';

export interface AssetMediaRedirectResponse {
  targetSize: AssetMediaSize | 'original';
}

@Injectable()
export class AssetMediaService extends BaseService {
  async getUploadAssetIdByChecksum(auth: AuthDto, checksum?: string): Promise<AssetMediaResponseDto | undefined> {
    if (!checksum) {
      return;
    }

    const assetId = await this.assetRepository.getUploadAssetIdByChecksum(auth.user.id, fromChecksum(checksum));
    if (!assetId) {
      return;
    }

    return { id: assetId, status: AssetMediaStatus.DUPLICATE };
  }

  canUploadFile({ auth, fieldName, file, body }: UploadRequest): true {
    requireUploadAccess(auth);

    const filename = body.filename || file.originalName;

    switch (fieldName) {
      case UploadFieldName.ASSET_DATA: {
        if (mimeTypes.isAsset(filename)) {
          return true;
        }
        break;
      }

      case UploadFieldName.SIDECAR_DATA: {
        if (mimeTypes.isSidecar(filename)) {
          return true;
        }
        break;
      }

      case UploadFieldName.PROFILE_DATA: {
        if (mimeTypes.isProfile(filename)) {
          return true;
        }
        break;
      }
    }

    this.logger.error(`Unsupported file type ${filename}`);
    throw new BadRequestException(`Unsupported file type ${filename}`);
  }

  getUploadFilename({ auth, fieldName, file, body }: UploadRequest): string {
    requireUploadAccess(auth);

    const extension = getFilenameExtension(body.filename || file.originalName);
    const lookup = {
      [UploadFieldName.ASSET_DATA]: extension,
      [UploadFieldName.SIDECAR_DATA]: '.xmp',
      [UploadFieldName.PROFILE_DATA]: extension,
    };

    return sanitize(`${file.uuid}${lookup[fieldName]}`);
  }

  getUploadFolder({ auth, fieldName, file }: UploadRequest): string {
    auth = requireUploadAccess(auth);

    let folder = StorageCore.getNestedFolder(StorageFolder.Upload, auth.user.id, file.uuid);
    if (fieldName === UploadFieldName.PROFILE_DATA) {
      folder = StorageCore.getFolderLocation(StorageFolder.Profile, auth.user.id);
    }

    this.storageRepository.mkdirSync(folder);

    return folder;
  }

  async getUploadVerificationConfig() {
    const { integrityChecks } = await this.getConfig({ withCache: true });
    return integrityChecks.uploadVerification;
  }

  async onUploadError(request: AuthRequest, file: Express.Multer.File) {
    const uploadFilename = this.getUploadFilename(asUploadRequest(request, file));
    const uploadFolder = this.getUploadFolder(asUploadRequest(request, file));
    const uploadPath = `${uploadFolder}/${uploadFilename}`;

    await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: [uploadPath] } });
  }

  async uploadAsset(
    auth: AuthDto,
    dto: AssetMediaCreateDto,
    file: UploadFile,
    sidecarFile?: UploadFile,
  ): Promise<AssetMediaResponseDto> {
    let asset: Asset | undefined;
    try {
      await this.requireAccess({
        auth,
        permission: Permission.AssetUpload,
        // do not need an id here, but the interface requires it
        ids: [auth.user.id],
      });

      this.requireQuota(auth, file.size);

      if (dto.livePhotoVideoId) {
        await onBeforeLink(
          { asset: this.assetRepository, event: this.eventRepository },
          { userId: auth.user.id, livePhotoVideoId: dto.livePhotoVideoId },
        );
      }

      asset = await this.assetRepository.create({
        ownerId: auth.user.id,
        libraryId: null,

        checksum: file.checksum,
        checksumAlgorithm: ChecksumAlgorithm.sha1File,
        originalPath: file.originalPath,

        fileCreatedAt: dto.fileCreatedAt,
        fileModifiedAt: dto.fileModifiedAt,
        localDateTime: dto.fileCreatedAt,

        type: mimeTypes.assetType(file.originalPath),
        isFavorite: dto.isFavorite,
        duration: dto.duration || null,
        visibility: dto.visibility ?? AssetVisibility.Timeline,
        livePhotoVideoId: dto.livePhotoVideoId,
        originalFileName: dto.filename || file.originalName,
      });

      if (dto.metadata?.length) {
        await this.assetRepository.upsertMetadata(asset.id, dto.metadata);
      }

      if (sidecarFile) {
        await this.assetRepository.upsertFile({
          assetId: asset.id,
          path: sidecarFile.originalPath,
          type: AssetFileType.Sidecar,
        });
        await this.storageRepository.utimes(sidecarFile.originalPath, new Date(), new Date(dto.fileModifiedAt));
      }
      await this.storageRepository.utimes(file.originalPath, new Date(), new Date(dto.fileModifiedAt));
      await this.assetRepository.upsertExif({
        exif: { assetId: asset.id, fileSizeInByte: file.size },
        lockedPropertiesBehavior: 'override',
      });

      await this.jobRepository.queue({ name: JobName.AssetExtractMetadata, data: { id: asset.id, source: 'upload' } });

      if (auth.sharedLink) {
        await this.addToSharedLink(auth.sharedLink, asset.id);
      }

      await this.eventRepository.emit('AssetCreate', { asset, file });

      return { id: asset.id, status: AssetMediaStatus.CREATED };
    } catch (error: any) {
      // clean up files
      await this.jobRepository.queue({
        name: JobName.FileDelete,
        data: { files: [file.originalPath, sidecarFile?.originalPath] },
      });

      // handle duplicates with a success response
      if (isAssetChecksumConstraint(error)) {
        const duplicateId = await this.assetRepository.getUploadAssetIdByChecksum(auth.user.id, file.checksum);
        if (!duplicateId) {
          this.logger.error(`Error locating duplicate for checksum constraint`);
          throw new InternalServerErrorException();
        }

        if (auth.sharedLink) {
          await this.addToSharedLink(auth.sharedLink, duplicateId);
        }

        this.logger.debug(`Duplicate asset upload rejected: existing asset ${duplicateId}`);
        return { status: AssetMediaStatus.DUPLICATE, id: duplicateId };
      }

      // clean up the asset row if one was created
      if (asset) {
        await this.assetRepository.remove({ id: asset.id });
      }

      this.logger.error(`Error uploading file ${error}`, error?.stack);
      throw error;
    }
  }

  /**
   * In-place, checksum-verified restore of an upload asset whose original file went missing.
   * Unlike delete+re-upload, the asset row is never touched destructively: the id and every
   * FK-attached record (faces, tags, albums, memories, OCR, edits, embeddings, …) survive by
   * construction — no delete, no cascade. Bytes are accepted ONLY when they hash to the checksum
   * the server already recorded, and ONLY when the asset is genuinely offline with its file
   * missing, so content can never be swapped and an intentionally-deleted asset can never be
   * resurrected (the #23897 guardrail).
   */
  async restoreAssetOriginal(auth: AuthDto, id: string, file: UploadFile): Promise<AssetMediaResponseDto> {
    const correlationId = this.logger.getCorrelationId();
    const restoreStartedAt = Date.now();
    try {
      await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: [id] });

      const asset = await this.assetRepository.getById(id);
      if (!asset) {
        throw new NotFoundException('Asset not found');
      }

      this.logger.debugFn(
        () =>
          `Restore requested for asset ${id} (offline: ${asset.isOffline}, libraryId: ${asset.libraryId}, checksumAlgorithm: ${asset.checksumAlgorithm})`,
      );

      // eligibility: an uploaded asset (libraryId IS NULL) with a file checksum
      if (asset.libraryId !== null) {
        throw new BadRequestException('Only uploaded assets can be restored in place');
      }
      if (asset.checksumAlgorithm !== ChecksumAlgorithm.sha1File) {
        throw new BadRequestException('Asset checksum is not a file checksum; cannot restore in place');
      }
      // the #23897 guardrail: re-supply is gated on offline (asset exists, file missing) and never
      // on a bare checksum match — deleted/trashed assets are never scanned, so never offline
      if (!asset.isOffline || asset.deletedAt !== null) {
        throw new BadRequestException('Asset is not offline; only a missing original can be restored');
      }

      // never overwrite a file that is present
      if (await this.storageRepository.checkFileExists(asset.originalPath)) {
        throw new ConflictException('Original file is already present; refusing to overwrite');
      }

      // the invariant that makes this upstream-mergeable: the bytes must hash to the stored checksum
      if (!file.checksum.equals(asset.checksum)) {
        this.logger.warn(`Restore rejected for asset ${id}: supplied bytes do not match the recorded checksum`);
        throw new BadRequestException('Checksum mismatch: supplied file does not match the asset');
      }

      this.logger.verboseFn(() => `Restore checksum verified for asset ${id}; moving bytes into place`);

      // move the verified temp file onto the asset's EXISTING originalPath (no re-templating);
      // StorageCore handles cross-device moves (EXDEV → copy + verify + delete) and crash recovery
      await this.storageCore.moveFile({
        entityId: asset.id,
        pathType: AssetPathType.Original,
        oldPath: file.originalPath,
        newPath: asset.originalPath,
        assetInfo: { sizeInBytes: file.size, checksum: asset.checksum },
      });
      // moveFile has branches that silently return without placing the file (verification failure,
      // non-EXDEV rename error, size mismatch); assert the bytes actually landed before clearing state
      if (!(await this.storageRepository.checkFileExists(asset.originalPath))) {
        throw new InternalServerErrorException(`Restore failed: file was not placed at ${asset.originalPath}`);
      }
      // preserve mtime so the checksum scan's mtime bookkeeping stays consistent
      await this.storageRepository.utimes(asset.originalPath, new Date(), new Date(asset.fileModifiedAt));

      // clear the offline state and drop the open missing-file report; nothing else on the row changes
      await this.assetRepository.update({ id: asset.id, isOffline: false });
      await this.integrityRepository.deleteMissingFileReportsForAsset(asset.id);

      this.logger.verboseFn(() => `Restore cleared offline state + integrity report for asset ${id}`);

      // thumbnails were lost with the file — regenerate only those. A full metadata re-extraction
      // is deliberately NOT forced: identical bytes make faces/exif a no-op, and getDates would
      // otherwise recompute localDateTime/fileCreatedAt without consulting lockedProperties.
      await this.jobRepository.queue({
        name: JobName.AssetGenerateThumbnails,
        data: { id: asset.id, source: 'upload', correlationId },
      });

      this.telemetryRepository.jobs.addToCounter('immich.restore.assets.restored', 1);
      this.telemetryRepository.jobs.addToHistogram('immich.restore.duration_ms', Date.now() - restoreStartedAt);

      this.logger.log(`Restored missing original for asset ${id} in place`);

      return { id: asset.id, status: AssetMediaStatus.RESTORED };
    } catch (error: any) {
      // discard the temp upload; the asset row is never touched on failure
      await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: [file.originalPath] } });
      throw error;
    }
  }

  async downloadOriginal(auth: AuthDto, id: string, dto: AssetDownloadOriginalDto): Promise<ImmichFileResponse> {
    await this.requireAccess({ auth, permission: Permission.AssetDownload, ids: [id] });

    if (auth.sharedLink) {
      dto.edited = true;
    }

    const { originalPath, originalFileName, editedPath } = await this.assetRepository.getForOriginal(
      id,
      dto.edited ?? false,
    );

    const path = editedPath ?? originalPath!;

    return new ImmichFileResponse({
      path,
      fileName: getFileNameWithoutExtension(originalFileName) + getFilenameExtension(path),
      contentType: mimeTypes.lookup(path),
      cacheControl: CacheControl.PrivateWithCache,
    });
  }

  async viewThumbnail(
    auth: AuthDto,
    id: string,
    dto: AssetMediaOptionsDto,
  ): Promise<ImmichFileResponse | AssetMediaRedirectResponse> {
    await this.requireAccess({ auth, permission: Permission.AssetView, ids: [id] });

    if (dto.size === AssetMediaSize.Original) {
      throw new BadRequestException('May not request original file');
    }

    if (auth.sharedLink) {
      dto.edited = true;
    }

    const size = (dto.size ?? AssetMediaSize.THUMBNAIL) as unknown as AssetFileType;
    const { originalPath, originalFileName, path } = await this.assetRepository.getForThumbnail(
      id,
      size,
      dto.edited ?? false,
    );

    if (size === AssetFileType.FullSize && mimeTypes.isWebSupportedImage(originalPath) && !dto.edited) {
      // use original file for web supported images
      return { targetSize: 'original' };
    }

    if (dto.size === AssetMediaSize.FULLSIZE && !path) {
      // downgrade to preview if fullsize is not available.
      // e.g. disabled or not yet (re)generated
      return { targetSize: AssetMediaSize.PREVIEW };
    }

    if (!path) {
      throw new NotFoundException('Asset media not found');
    }

    const fileNameBase =
      auth.sharedLink && !auth.sharedLink.showExif ? id : getFileNameWithoutExtension(originalFileName);
    const fileName = `${fileNameBase}_${size}${getFilenameExtension(path)}`;

    return new ImmichFileResponse({
      fileName,
      path,
      contentType: mimeTypes.lookup(path),
      cacheControl: CacheControl.PrivateWithCache,
    });
  }

  async playbackVideo(auth: AuthDto, id: string): Promise<ImmichFileResponse> {
    await this.requireAccess({ auth, permission: Permission.AssetView, ids: [id] });

    const asset = await this.assetRepository.getForVideo(id);

    if (!asset) {
      throw new NotFoundException('Asset not found or asset is not a video');
    }

    const filepath = asset.encodedVideoPath || asset.originalPath;

    return new ImmichFileResponse({
      path: filepath,
      contentType: mimeTypes.lookup(filepath),
      cacheControl: CacheControl.PrivateWithCache,
    });
  }

  async bulkUploadCheck(auth: AuthDto, dto: AssetBulkUploadCheckDto): Promise<AssetBulkUploadCheckResponseDto> {
    const checksums: Buffer[] = dto.assets.map((asset) => fromChecksum(asset.checksum));
    const results = await this.assetRepository.getByChecksums(auth.user.id, checksums);
    const checksumMap: Record<string, { id: string; isTrashed: boolean }> = {};

    for (const { id, deletedAt, checksum } of results) {
      checksumMap[checksum.toString('hex')] = { id, isTrashed: !!deletedAt };
    }

    return {
      results: dto.assets.map(({ id, checksum }) => {
        const duplicate = checksumMap[fromChecksum(checksum).toString('hex')];
        if (duplicate) {
          return {
            id,
            action: AssetUploadAction.REJECT,
            reason: AssetRejectReason.DUPLICATE,
            assetId: duplicate.id,
            isTrashed: duplicate.isTrashed,
          };
        }

        return {
          id,
          action: AssetUploadAction.ACCEPT,
        };
      }),
    };
  }

  private async addToSharedLink(sharedLink: AuthSharedLink, assetId: string) {
    if (!sharedLink.albumId) {
      await this.sharedLinkRepository.addAssets(sharedLink.id, [assetId]);
      return;
    }

    const album = await this.albumRepository.getById(sharedLink.albumId, { withAssets: false });
    if (!album) {
      return;
    }

    await this.albumRepository.addAssetIds(album.id, [assetId]);
    const userIds = album.albumUsers.map(({ user }) => user.id);
    await this.eventRepository.emit('AlbumUpdate', {
      id: album.id,
      userIds,
      recipientIds: userIds,
    });
  }

  private requireQuota(auth: AuthDto, size: number) {
    if (auth.user.quotaSizeInBytes !== null && auth.user.quotaSizeInBytes < auth.user.quotaUsageInBytes + size) {
      throw new BadRequestException('Quota has been exceeded!');
    }
  }
}
