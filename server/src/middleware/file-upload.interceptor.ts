import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  NestInterceptor,
} from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { transformException } from '@nestjs/platform-express/multer/multer/multer.utils';
import { NextFunction, RequestHandler } from 'express';
import multer from 'multer';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pipeline } from 'node:stream';
import { Observable } from 'rxjs';
import { UploadFieldName } from 'src/dtos/asset-media.dto';
import { RouteKey } from 'src/enum';
import { AuthRequest } from 'src/middleware/auth.guard';
import { CryptoRepository } from 'src/repositories/crypto.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { StorageRepository } from 'src/repositories/storage.repository';
import { AssetMediaService } from 'src/services/asset-media.service';
import { ImmichFile, UploadFile, UploadFiles } from 'src/types';
import { asUploadRequest, mapToUploadFile } from 'src/utils/asset.util';

export function getFile(files: UploadFiles, property: 'assetData' | 'sidecarData') {
  const file = files[property]?.[0];
  return file ? mapToUploadFile(file) : file;
}

export function getFiles(files: UploadFiles) {
  return {
    file: getFile(files, 'assetData') as UploadFile,
    sidecarFile: getFile(files, 'sidecarData'),
  };
}

type ImmichMulterFile = Express.Multer.File & { uuid: string };

interface Callback<T> {
  (error: Error): void;
  (error: null, result: T): void;
}

@Injectable()
export class FileUploadInterceptor implements NestInterceptor {
  private handlers: {
    userProfile: RequestHandler;
    assetUpload: RequestHandler;
    assetRestore: RequestHandler;
  };

  constructor(
    private reflect: Reflector,
    private assetService: AssetMediaService,
    private storageRepository: StorageRepository,
    private cryptoRepository: CryptoRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(FileUploadInterceptor.name);

    const instance = multer({
      fileFilter: this.fileFilter.bind(this),
      storage: {
        _handleFile: this.handleFile.bind(this),
        _removeFile: this.removeFile.bind(this),
      },
    });

    this.handlers = {
      userProfile: instance.single(UploadFieldName.PROFILE_DATA),
      assetUpload: instance.fields([
        { name: UploadFieldName.ASSET_DATA, maxCount: 1 },
        { name: UploadFieldName.SIDECAR_DATA, maxCount: 1 },
      ]),
      // the restore endpoint takes a bare original only; an accepted-but-unread sidecar part
      // would be written to disk with nothing ever consuming or deleting it
      assetRestore: instance.fields([{ name: UploadFieldName.ASSET_DATA, maxCount: 1 }]),
    };
  }

  async intercept(context: ExecutionContext, next: CallHandler<any>): Promise<Observable<any>> {
    const context_ = context.switchToHttp();
    const route = this.reflect.get<string>(PATH_METADATA, context.getClass());
    const endpoint = this.reflect.get<string>(PATH_METADATA, context.getHandler());

    const handler: RequestHandler | null = this.getHandler(route as RouteKey, endpoint);
    if (handler) {
      await new Promise<void>((resolve, reject) => {
        const next: NextFunction = (error) => (error ? reject(transformException(error)) : resolve());
        const maybePromise = handler(context_.getRequest(), context_.getResponse(), next);
        Promise.resolve(maybePromise).catch((error) => reject(error));
      });
    } else {
      this.logger.warn(`Skipping invalid file upload route: ${route}`);
    }

    return next.handle();
  }

  private fileFilter(request: AuthRequest, file: Express.Multer.File, callback: multer.FileFilterCallback) {
    try {
      callback(null, this.assetService.canUploadFile(asUploadRequest(request, file)));
    } catch (error: Error | any) {
      callback(error);
    }
  }

  private handleFile(request: AuthRequest, file: Express.Multer.File, callback: Callback<Partial<ImmichFile>>) {
    request.on('error', (error) => {
      if ('code' in error && error.code === 'ECONNRESET') {
        this.logger.debug('Upload was cancelled');
      } else {
        this.logger.error(`Upload failed with: ${error}`);
      }
      this.assetService.onUploadError(request, file).catch(this.logger.error);
    });

    try {
      (file as ImmichMulterFile).uuid = randomUUID();

      const uploadRequest = asUploadRequest(request, file);

      const path = join(
        this.assetService.getUploadFolder(uploadRequest),
        this.assetService.getUploadFilename(uploadRequest),
      );

      const writeStream = this.storageRepository.createWriteStream(path);
      const hash = file.fieldname === UploadFieldName.ASSET_DATA ? createHash('sha1') : null;

      let size = 0;

      file.stream.on('data', (chunk) => {
        hash?.update(chunk);
        size += chunk.length;
      });

      pipeline(file.stream, writeStream, (error) => {
        if (error) {
          hash?.destroy();
          return this.failUpload(path, error, callback);
        }
        if (size === 0) {
          return this.failUpload(path, new BadRequestException('File is empty'), callback);
        }
        const checksum = hash?.digest();
        this.verifyWrittenFile(path, size, checksum)
          .then(() => callback(null, { path, size, checksum }))
          .catch((error: Error) => this.failUpload(path, error, callback));
      });
    } catch (error: Error | any) {
      callback(error);
    }
  }

  /**
   * Fail the upload AND remove whatever reached the disk. Multer only unlinks files it was
   * told about via the success callback, so an error after the write stream opened would
   * otherwise leave the (partial or unverified) file behind as an untracked-file orphan.
   */
  private failUpload(path: string, error: Error, callback: Callback<Partial<ImmichFile>>) {
    this.storageRepository
      .unlink(path)
      .catch((unlinkError) => this.logger.warn(`Unable to remove failed upload ${path}: ${unlinkError}`))
      .finally(() => callback(error));
  }

  /**
   * Confirm the bytes we just acknowledged from the client actually reached the disk.
   * A failure here fails the whole upload request, so the client keeps the file queued
   * and retries — instead of the server holding a record for a file that never landed.
   */
  private async verifyWrittenFile(path: string, expectedSize: number, checksum?: Buffer) {
    const { size: verifySize, rehash } = await this.assetService.getUploadVerificationConfig();

    if (verifySize || rehash) {
      const stat = await this.storageRepository.stat(path);
      if (stat.size !== expectedSize) {
        throw new InternalServerErrorException(
          `Upload verification failed: received ${expectedSize} bytes but found ${stat.size} on disk for ${path}`,
        );
      }
    }

    if (rehash && checksum) {
      const diskHash = await this.cryptoRepository.hashFile(path);
      if (!diskHash.equals(checksum)) {
        throw new InternalServerErrorException(`Upload verification failed: on-disk checksum mismatch for ${path}`);
      }
    }
  }

  private removeFile(_request: AuthRequest, file: Express.Multer.File, callback: (error: Error | null) => void) {
    this.storageRepository
      .unlink(file.path)
      .then(() => callback(null))
      .catch(callback);
  }

  private getHandler(route: RouteKey, endpoint?: string) {
    switch (route) {
      case RouteKey.Asset: {
        return endpoint === ':id/original' ? this.handlers.assetRestore : this.handlers.assetUpload;
      }

      case RouteKey.User: {
        return this.handlers.userProfile;
      }

      default: {
        return null;
      }
    }
  }
}
