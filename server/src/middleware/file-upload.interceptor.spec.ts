import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { FileUploadInterceptor } from 'src/middleware/file-upload.interceptor';
import { Mocked, vitest } from 'vitest';

describe(FileUploadInterceptor.name, () => {
  let sut: FileUploadInterceptor;
  let assetService: { getUploadVerificationConfig: Mocked<any>; canUploadFile: Mocked<any> };
  let storageRepository: { stat: Mocked<any>; createPlainReadStream: Mocked<any>; unlink: Mocked<any> };

  const logger = {
    setContext: vitest.fn(),
    error: vitest.fn(),
    warn: vitest.fn(),
    debug: vitest.fn(),
  };

  const verify = (path: string, size: number, checksum?: Buffer) =>
    (sut as any).verifyWrittenFile(path, size, checksum) as Promise<void>;

  beforeEach(() => {
    assetService = { getUploadVerificationConfig: vitest.fn(), canUploadFile: vitest.fn() };
    storageRepository = { stat: vitest.fn(), createPlainReadStream: vitest.fn(), unlink: vitest.fn() };
    sut = new FileUploadInterceptor(new Reflector(), assetService as any, storageRepository as any, logger as any);
  });

  describe('verifyWrittenFile', () => {
    it('should not touch the disk when verification is disabled', async () => {
      assetService.getUploadVerificationConfig.mockResolvedValue({ size: false, rehash: false });

      await expect(verify('/upload/file.jpg', 42)).resolves.toBeUndefined();

      expect(storageRepository.stat).not.toHaveBeenCalled();
    });

    it('should pass when the on-disk size matches', async () => {
      assetService.getUploadVerificationConfig.mockResolvedValue({ size: true, rehash: false });
      storageRepository.stat.mockResolvedValue({ size: 42 });

      await expect(verify('/upload/file.jpg', 42)).resolves.toBeUndefined();
    });

    it('should reject when the on-disk size differs', async () => {
      assetService.getUploadVerificationConfig.mockResolvedValue({ size: true, rehash: false });
      storageRepository.stat.mockResolvedValue({ size: 0 });

      await expect(verify('/upload/file.jpg', 42)).rejects.toThrow('Upload verification failed');
    });

    it('should reject when the file is missing entirely', async () => {
      assetService.getUploadVerificationConfig.mockResolvedValue({ size: true, rehash: false });
      storageRepository.stat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      await expect(verify('/upload/file.jpg', 42)).rejects.toThrow('ENOENT');
    });

    it('should pass a matching rehash', async () => {
      const content = Buffer.from('hello world');
      const checksum = createHash('sha1').update(content).digest();
      assetService.getUploadVerificationConfig.mockResolvedValue({ size: true, rehash: true });
      storageRepository.stat.mockResolvedValue({ size: content.length });
      storageRepository.createPlainReadStream.mockReturnValue(Readable.from([content]));

      await expect(verify('/upload/file.jpg', content.length, checksum)).resolves.toBeUndefined();
    });

    it('should reject a mismatched rehash', async () => {
      const content = Buffer.from('hello world');
      const wrongChecksum = createHash('sha1').update('something else').digest();
      assetService.getUploadVerificationConfig.mockResolvedValue({ size: true, rehash: true });
      storageRepository.stat.mockResolvedValue({ size: content.length });
      storageRepository.createPlainReadStream.mockReturnValue(Readable.from([content]));

      await expect(verify('/upload/file.jpg', content.length, wrongChecksum)).rejects.toThrow('checksum mismatch');
    });
  });
});
