import { defaults, SystemConfig } from 'src/config';
import { UserAdmin } from 'src/database';
import { IntegrityReport, JobName, JobStatus, NotificationType, SystemMetadataKey } from 'src/enum';
import { describeFindings, IntegrityNotificationService } from 'src/services/integrity-notification.service';
import { newTestService, ServiceMocks } from 'test/utils';

const admin = { id: 'admin-id', name: 'Admin', email: 'admin@test.com' } as UserAdmin;

const notificationItem = {
  id: 'notification-id',
  userId: admin.id,
  type: NotificationType.IntegrityIssues,
  level: 'warning',
  title: 'Integrity check findings',
  description: 'something',
  data: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
  readAt: null,
} as any;

const counts = (missing: number, untracked = 0, checksum = 0) => ({
  [IntegrityReport.MissingFile]: missing,
  [IntegrityReport.UntrackedFile]: untracked,
  [IntegrityReport.ChecksumFail]: checksum,
});

const smtpEnabledConfig = {
  notifications: {
    smtp: {
      ...defaults.notifications.smtp,
      enabled: true,
    },
  },
} as Partial<SystemConfig>;

describe(IntegrityNotificationService.name, () => {
  let sut: IntegrityNotificationService;
  let mocks: ServiceMocks;

  const withState = (config: Partial<SystemConfig>, state?: { lastNotifiedAt?: string }) => {
    mocks.systemMetadata.get.mockImplementation(
      (key) => Promise.resolve(key === SystemMetadataKey.SystemConfig ? config : state) as Promise<any>,
    );
  };

  beforeEach(() => {
    ({ sut, mocks } = newTestService(IntegrityNotificationService));
    mocks.user.getAdmin.mockResolvedValue(admin);
    mocks.notification.create.mockResolvedValue(notificationItem);
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe(describeFindings.name, () => {
    it('should humanize counts, skipping zeroes and handling plurals', () => {
      expect(describeFindings(counts(1, 0, 2))).toBe('1 missing file, 2 checksum mismatches');
    });
  });

  describe('handleIntegrityNotify', () => {
    it('should skip when notifications are disabled', async () => {
      withState({ integrityChecks: { notifications: { enabled: false, cronExpression: '0 5 * * *' } } } as any);

      await expect(sut.handleIntegrityNotify()).resolves.toBe(JobStatus.Skipped);

      expect(mocks.integrityReport.getNewFindingCounts).not.toHaveBeenCalled();
    });

    it('should do nothing when there are no new findings', async () => {
      withState({});
      mocks.integrityReport.getNewFindingCounts.mockResolvedValue({ counts: counts(0), total: 0, latest: null });

      await expect(sut.handleIntegrityNotify()).resolves.toBe(JobStatus.Success);

      expect(mocks.notification.create).not.toHaveBeenCalled();
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('should query findings newer than the stored watermark, passing it through verbatim', async () => {
      // the watermark is postgres' own text timestamp (microsecond precision) — it must
      // never round-trip through a JS Date, which would truncate to milliseconds
      const lastNotifiedAt = '2026-08-01 05:00:00.123456+00';
      withState({}, { lastNotifiedAt });
      mocks.integrityReport.getNewFindingCounts.mockResolvedValue({ counts: counts(0), total: 0, latest: null });

      await sut.handleIntegrityNotify();

      expect(mocks.integrityReport.getNewFindingCounts).toHaveBeenCalledWith(lastNotifiedAt);
    });

    it('should notify in-app and advance the watermark to the newest counted row', async () => {
      const latest = '2026-08-09 03:00:05.654321+00';
      withState({});
      mocks.integrityReport.getNewFindingCounts.mockResolvedValue({ counts: counts(3), total: 3, latest });

      await expect(sut.handleIntegrityNotify()).resolves.toBe(JobStatus.Success);

      expect(mocks.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: admin.id,
          type: NotificationType.IntegrityIssues,
          description: expect.stringContaining('3 missing files'),
        }),
      );
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_notification', admin.id, expect.anything());
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.IntegrityNotificationState, {
        lastNotifiedAt: latest,
      });
    });

    it('should not send email when smtp is disabled', async () => {
      withState({});
      mocks.integrityReport.getNewFindingCounts.mockResolvedValue({
        counts: counts(1),
        total: 1,
        latest: '2026-08-09 03:00:05+00',
      });

      await sut.handleIntegrityNotify();

      expect(mocks.email.renderEmail).not.toHaveBeenCalled();
    });

    it('should send email when smtp is enabled', async () => {
      withState(smtpEnabledConfig);
      mocks.integrityReport.getNewFindingCounts.mockResolvedValue({
        counts: counts(2),
        total: 2,
        latest: '2026-08-09 03:00:06+00',
      });
      mocks.email.renderEmail.mockResolvedValue({ html: '<p>hi</p>', text: 'hi' });

      await sut.handleIntegrityNotify();

      expect(mocks.email.renderEmail).toHaveBeenCalled();
      expect(mocks.job.queue).toHaveBeenCalledWith(
        expect.objectContaining({
          name: JobName.SendMail,
          data: expect.objectContaining({ to: admin.email }),
        }),
      );
    });

    it('should still advance the watermark when one channel fails but another delivers', async () => {
      const latest = '2026-08-09 03:00:05.999999+00';
      withState(smtpEnabledConfig);
      mocks.integrityReport.getNewFindingCounts.mockResolvedValue({ counts: counts(1), total: 1, latest });
      mocks.notification.create.mockRejectedValue(new Error('boom'));
      mocks.email.renderEmail.mockResolvedValue({ html: '<p>hi</p>', text: 'hi' });

      await expect(sut.handleIntegrityNotify()).resolves.toBe(JobStatus.Success);

      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.IntegrityNotificationState, {
        lastNotifiedAt: latest,
      });
    });

    it('should not advance the watermark when every channel fails, so the window is re-announced', async () => {
      const latest = '2026-08-09 03:00:05.999999+00';
      withState({});
      mocks.integrityReport.getNewFindingCounts.mockResolvedValue({ counts: counts(1), total: 1, latest });
      mocks.notification.create.mockRejectedValue(new Error('boom'));

      await expect(sut.handleIntegrityNotify()).resolves.toBe(JobStatus.Failed);

      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });
  });
});
