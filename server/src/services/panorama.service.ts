import { Injectable } from '@nestjs/common';
import { OnJob } from 'src/decorators';
import { JobName, JobStatus, QueueName } from 'src/enum';
import { BaseService } from 'src/services/base.service';
import { JobOf } from 'src/types';
import { isPanoramaEnabled } from 'src/utils/misc';

@Injectable()
export class PanoramaService extends BaseService {
  @OnJob({ name: JobName.PanoramaQueueAll, queue: QueueName.Panorama })
  async handleQueueAll({ force }: JobOf<JobName.PanoramaQueueAll>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isPanoramaEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    // TODO(panorama phase 3): stream candidate assets, time-cluster, queue PanoramaDetect per cluster
    this.logger.log(`Panorama detection queue-all requested (force=${force}) — detection logic lands in phase 3`);
    return JobStatus.Skipped;
  }

  @OnJob({ name: JobName.PanoramaDetect, queue: QueueName.Panorama })
  async handleDetect({ ids }: JobOf<JobName.PanoramaDetect>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!isPanoramaEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    this.logger.debug(`Panorama detect stub for cluster of ${ids.length} assets`);
    return JobStatus.Skipped;
  }

  @OnJob({ name: JobName.PanoramaStitch, queue: QueueName.Panorama })
  async handleStitch({ id }: JobOf<JobName.PanoramaStitch>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!isPanoramaEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    this.logger.debug(`Panorama stitch stub for group ${id}`);
    return JobStatus.Skipped;
  }
}
