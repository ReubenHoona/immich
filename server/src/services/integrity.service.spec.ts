import { IntegrityReport } from 'src/enum';
import { IntegrityService } from 'src/services/integrity.service';
import { newTestService, ServiceMocks } from 'test/utils';

describe(IntegrityService.name, () => {
  let sut: IntegrityService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(IntegrityService));
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('handleDeleteAllIntegrityReports', () => {
    beforeEach(() => {
      mocks.integrityReport.streamIntegrityReportsByProperty.mockReturnValue((function* () {})() as never);
    });

    it('should query all property types when no type specified', async () => {
      await sut.handleDeleteAllIntegrityReports({});

      expect(mocks.integrityReport.streamIntegrityReportsByProperty).toHaveBeenCalledWith(undefined, undefined);
      expect(mocks.integrityReport.streamIntegrityReportsByProperty).toHaveBeenCalledWith('assetId', undefined);
      expect(mocks.integrityReport.streamIntegrityReportsByProperty).toHaveBeenCalledWith('fileAssetId', undefined);
    });
  });

  describe('handleMissingFiles', () => {
    it('should flag a missing upload original offline and create a report', async () => {
      mocks.storage.stat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));

      await sut.handleMissingFiles({
        items: [{ path: '/data/upload/photo.jpg', assetId: 'asset-1', fileAssetId: null, reportId: null }],
      });

      expect(mocks.asset.setUploadAssetsOffline).toHaveBeenCalledWith(['asset-1'], true);
      expect(mocks.integrityReport.create).toHaveBeenCalledWith([
        {
          type: IntegrityReport.MissingFile,
          path: '/data/upload/photo.jpg',
          assetId: 'asset-1',
          fileAssetId: null,
        },
      ]);
    });

    it('should not flag a missing derivative (fileAssetId) offline', async () => {
      mocks.storage.stat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));

      await sut.handleMissingFiles({
        items: [{ path: '/data/thumbs/thumb.webp', assetId: null, fileAssetId: 'file-1', reportId: null }],
      });

      // an original-file miss carries assetId; a derivative miss carries fileAssetId and is a
      // thumbnail issue, not an offline asset
      expect(mocks.asset.setUploadAssetsOffline).toHaveBeenCalledWith([], true);
    });

    it('should bring a returned original back online and delete its stale report', async () => {
      mocks.storage.stat.mockResolvedValue({} as never);

      await sut.handleMissingFiles({
        items: [{ path: '/data/upload/photo.jpg', assetId: 'asset-1', fileAssetId: null, reportId: 'report-1' }],
      });

      expect(mocks.integrityReport.deleteByIds).toHaveBeenCalledWith(['report-1']);
      expect(mocks.asset.setUploadAssetsOffline).toHaveBeenCalledWith(['asset-1'], false);
      expect(mocks.integrityReport.create).not.toHaveBeenCalled();
    });
  });

  describe('handleMissingRefresh', () => {
    it('should clear offline for upload assets whose file returned, then delete the reports', async () => {
      mocks.storage.stat.mockResolvedValue({} as never);
      mocks.integrityReport.getAssetIdsByReportIds.mockResolvedValue(['asset-1']);

      await sut.handleMissingRefresh({ items: [{ path: '/data/upload/photo.jpg', reportId: 'report-1' }] });

      expect(mocks.integrityReport.getAssetIdsByReportIds).toHaveBeenCalledWith(['report-1']);
      expect(mocks.asset.setUploadAssetsOffline).toHaveBeenCalledWith(['asset-1'], false);
      expect(mocks.integrityReport.deleteByIds).toHaveBeenCalledWith(['report-1']);
    });

    it('should do nothing when the file is still missing', async () => {
      mocks.storage.stat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));

      await sut.handleMissingRefresh({ items: [{ path: '/data/upload/photo.jpg', reportId: 'report-1' }] });

      expect(mocks.integrityReport.getAssetIdsByReportIds).not.toHaveBeenCalled();
      expect(mocks.asset.setUploadAssetsOffline).not.toHaveBeenCalled();
      expect(mocks.integrityReport.deleteByIds).not.toHaveBeenCalled();
    });
  });
});
