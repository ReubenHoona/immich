import { Injectable } from '@nestjs/common';
import { UserAdmin } from 'src/database';
import { OnJob } from 'src/decorators';
import { SystemConfig } from 'src/dtos/config.dto';
import { mapNotification } from 'src/dtos/notification.dto';
import {
  IntegrityReport,
  JobName,
  JobStatus,
  NotificationLevel,
  NotificationType,
  QueueName,
  SystemMetadataKey,
} from 'src/enum';
import { EmailTemplate } from 'src/repositories/email.repository';
import { BaseService } from 'src/services/base.service';
import { getExternalDomain } from 'src/utils/misc';

export interface IntegrityFindingsPayload {
  admin: UserAdmin;
  counts: Record<IntegrityReport, number>;
  total: number;
  baseUrl: string;
}

/**
 * A delivery channel for integrity findings. To add a new channel (ntfy, webhook, ...),
 * implement this interface and append an instance to `IntegrityNotificationService.channels`.
 */
export interface IntegrityNotificationChannel {
  readonly name: string;
  isEnabled(config: SystemConfig): boolean;
  send(payload: IntegrityFindingsPayload): Promise<void>;
}

const REPORT_LABELS: Record<IntegrityReport, [singular: string, plural: string]> = {
  [IntegrityReport.MissingFile]: ['missing file', 'missing files'],
  [IntegrityReport.UntrackedFile]: ['untracked file', 'untracked files'],
  [IntegrityReport.ChecksumFail]: ['checksum mismatch', 'checksum mismatches'],
};

export const describeFindings = (counts: Record<IntegrityReport, number>) =>
  Object.values(IntegrityReport)
    .filter((type) => counts[type] > 0)
    .map((type) => `${counts[type]} ${REPORT_LABELS[type][counts[type] === 1 ? 0 : 1]}`)
    .join(', ');

@Injectable()
export class IntegrityNotificationService extends BaseService {
  private channels: IntegrityNotificationChannel[] = [
    {
      name: 'in-app',
      isEnabled: () => true,
      send: (payload) => this.sendInAppNotification(payload),
    },
    {
      name: 'email',
      isEnabled: (config) => config.notifications.smtp.enabled,
      send: (payload) => this.sendEmailNotification(payload),
    },
  ];

  @OnJob({ name: JobName.IntegrityNotify, queue: QueueName.Notification })
  async handleIntegrityNotify(): Promise<JobStatus> {
    const config = await this.getConfig({ withCache: false });
    if (!config.integrityChecks.notifications.enabled) {
      return JobStatus.Skipped;
    }

    const state = await this.systemMetadataRepository.get(SystemMetadataKey.IntegrityNotificationState);
    // the watermark is postgres' text rendering of the newest announced row (µs precision)
    const { counts, total, latest } = await this.integrityRepository.getNewFindingCounts(state?.lastNotifiedAt);
    if (total === 0 || !latest) {
      this.logger.debug('No new integrity findings to announce');
      return JobStatus.Success;
    }

    const admin = await this.userRepository.getAdmin();
    if (!admin) {
      return JobStatus.Skipped;
    }

    const payload: IntegrityFindingsPayload = {
      admin,
      counts,
      total,
      baseUrl: getExternalDomain(config.server),
    };

    let delivered = 0;
    for (const channel of this.channels) {
      if (!channel.isEnabled(config)) {
        continue;
      }
      try {
        await channel.send(payload);
        delivered++;
      } catch (error: Error | any) {
        this.logger.error(`Failed to send integrity findings via ${channel.name} channel: ${error}`, error?.stack);
      }
    }

    // Nothing went out — leave the watermark alone so the next run re-announces this window
    // instead of silently swallowing it, and fail the job so the error is visible.
    if (delivered === 0) {
      this.logger.error(`Integrity findings could not be delivered on any channel; will retry on the next run`);
      return JobStatus.Failed;
    }

    // advance the watermark to the newest row we counted (not now()), so findings
    // inserted while this job ran are picked up by the next run
    await this.systemMetadataRepository.set(SystemMetadataKey.IntegrityNotificationState, {
      lastNotifiedAt: latest,
    });

    return JobStatus.Success;
  }

  private async sendInAppNotification({ admin, counts, total }: IntegrityFindingsPayload) {
    const item = await this.notificationRepository.create({
      userId: admin.id,
      type: NotificationType.IntegrityIssues,
      level: NotificationLevel.Warning,
      title: 'Integrity check findings',
      description: `${describeFindings(counts)} detected — review them in Administration > Maintenance`,
      data: { counts, total },
    });

    this.websocketRepository.clientSend('on_notification', admin.id, mapNotification(item));
  }

  private async sendEmailNotification({ admin, counts, total, baseUrl }: IntegrityFindingsPayload) {
    const { html, text } = await this.emailRepository.renderEmail({
      template: EmailTemplate.INTEGRITY_ISSUES,
      data: {
        baseUrl,
        displayName: admin.name,
        findings: describeFindings(counts),
        total,
      },
      customTemplate: '',
    });

    await this.jobRepository.queue({
      name: JobName.SendMail,
      data: {
        to: admin.email,
        subject: `Immich integrity check: ${describeFindings(counts)}`,
        html,
        text,
      },
    });
  }
}
