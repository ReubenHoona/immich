import { Injectable } from '@nestjs/common';
import { Duration } from 'luxon';
import { readFile } from 'node:fs/promises';
import { MachineLearningConfig } from 'src/config';
import { CLIPConfig } from 'src/dtos/model-config.dto';
import { LoggingRepository } from 'src/repositories/logging.repository';

export interface BoundingBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export enum ModelTask {
  FACIAL_RECOGNITION = 'facial-recognition',
  SEARCH = 'clip',
  OCR = 'ocr',
}

export enum ModelType {
  DETECTION = 'detection',
  PIPELINE = 'pipeline',
  RECOGNITION = 'recognition',
  TEXTUAL = 'textual',
  VISUAL = 'visual',
  OCR = 'ocr',
}

export type ModelPayload = { imagePath: string } | { text: string };

type ModelOptions = { modelName: string };

export type FaceDetectionOptions = ModelOptions & { minScore: number };
export type OcrOptions = ModelOptions & {
  minDetectionScore: number;
  minRecognitionScore: number;
  maxResolution: number;
};
type VisualResponse = { imageHeight: number; imageWidth: number };
export type ClipVisualRequest = { [ModelTask.SEARCH]: { [ModelType.VISUAL]: ModelOptions } };
export type ClipVisualResponse = { [ModelTask.SEARCH]: string } & VisualResponse;

export type ClipTextualRequest = { [ModelTask.SEARCH]: { [ModelType.TEXTUAL]: ModelOptions } };
export type ClipTextualResponse = { [ModelTask.SEARCH]: string };

export type OCR = {
  text: string[];
  box: number[];
  boxScore: number[];
  textScore: number[];
};

export type OcrRequest = {
  [ModelTask.OCR]: {
    [ModelType.DETECTION]: ModelOptions & { options: { minScore: number; maxResolution: number } };
    [ModelType.RECOGNITION]: ModelOptions & { options: { minScore: number } };
  };
};
export type OcrResponse = { [ModelTask.OCR]: OCR } & VisualResponse;

export type FacialRecognitionRequest = {
  [ModelTask.FACIAL_RECOGNITION]: {
    [ModelType.DETECTION]: ModelOptions & { options: { minScore: number } };
    [ModelType.RECOGNITION]: ModelOptions;
  };
};

export interface Face {
  boundingBox: BoundingBox;
  embedding: string;
  score: number;
}

export type FacialRecognitionResponse = { [ModelTask.FACIAL_RECOGNITION]: Face[] } & VisualResponse;
export type DetectedFaces = { faces: Face[] } & VisualResponse;
export type MachineLearningRequest = ClipVisualRequest | ClipTextualRequest | FacialRecognitionRequest | OcrRequest;
export type TextEncodingOptions = ModelOptions & { language?: string };

export type PanoramaDetectOptions = {
  minOverlap: number;
  maxOverlap: number;
  minInliers: number;
  minDisplacement: number;
};

export type PanoramaLink = {
  matches: number;
  inliers: number;
  ratio: number;
  overlap: number | null;
  displacement: number | null;
  dx: number;
  dy: number;
  ok: boolean;
};

export type PanoramaDetectResponse = {
  frames: number;
  links: PanoramaLink[];
  classification: 'panorama' | 'burst' | 'unrelated';
  chainStart: number | null;
  chainEnd: number | null;
  score: number;
  mixedDirections: boolean;
};

export type PanoramaStitchOptions = {
  quality: number;
  compositeResolution: 'full' | 'preview';
};

export type PanoramaStitchResult = {
  data: Buffer;
  width: number;
  height: number;
};

@Injectable()
export class MachineLearningRepository {
  private healthyMap: Record<string, boolean> = {};
  private interval?: ReturnType<typeof setInterval>;
  private _config?: MachineLearningConfig;

  private get config(): MachineLearningConfig {
    if (!this._config) {
      throw new Error('Machine learning repository not been setup');
    }

    return this._config;
  }

  constructor(private logger: LoggingRepository) {
    this.logger.setContext(MachineLearningRepository.name);
  }

  setup(config: MachineLearningConfig) {
    this._config = config;
    this.teardown();

    // delete old servers
    for (const url of Object.keys(this.healthyMap)) {
      if (!config.urls.includes(url)) {
        delete this.healthyMap[url];
      }
    }

    if (!config.enabled || !config.availabilityChecks.enabled) {
      return;
    }

    this.tick();
    this.interval = setInterval(
      () => this.tick(),
      Duration.fromObject({ milliseconds: config.availabilityChecks.interval }).as('milliseconds'),
    );
  }

  teardown() {
    if (this.interval) {
      clearInterval(this.interval);
    }
  }

  private tick() {
    for (const url of this.config.urls) {
      void this.check(url);
    }
  }

  private async check(url: string) {
    let isHealthy = false;
    try {
      const response = await fetch(new URL('ping', url), {
        signal: AbortSignal.timeout(this.config.availabilityChecks.timeout),
      });
      if (response.ok) {
        isHealthy = true;
      }
    } catch {
      // nothing to do here
    }

    this.setHealthy(url, isHealthy);
  }

  private setHealthy(url: string, healthy: boolean) {
    if (this.healthyMap[url] !== healthy) {
      this.logger.log(`Machine learning server became ${healthy ? 'healthy' : 'unhealthy'} (${url}).`);
    }

    this.healthyMap[url] = healthy;
  }

  private isHealthy(url: string) {
    if (!this.config.availabilityChecks.enabled) {
      return true;
    }

    return this.healthyMap[url];
  }

  private async predict<T>(payload: ModelPayload, config: MachineLearningRequest): Promise<T> {
    const formData = await this.getFormData(payload, config);

    for (const url of [
      // try healthy servers first
      ...this.config.urls.filter((url) => this.isHealthy(url)),
      ...this.config.urls.filter((url) => !this.isHealthy(url)),
    ]) {
      try {
        const response = await fetch(new URL('predict', url), { method: 'POST', body: formData });
        if (response.ok) {
          this.setHealthy(url, true);
          return response.json();
        }

        this.logger.warn(
          `Machine learning request to "${url}" failed with status ${response.status}: ${response.statusText}`,
        );
      } catch (error: Error | unknown) {
        this.logger.warn(
          `Machine learning request to "${url}" failed: ${error instanceof Error ? error.message : error}`,
        );
      }

      this.setHealthy(url, false);
    }

    throw new Error(`Machine learning request '${JSON.stringify(config)}' failed for all URLs`);
  }

  async detectFaces(imagePath: string, { modelName, minScore }: FaceDetectionOptions) {
    const request = {
      [ModelTask.FACIAL_RECOGNITION]: {
        [ModelType.DETECTION]: { modelName, options: { minScore } },
        [ModelType.RECOGNITION]: { modelName },
      },
    };
    const response = await this.predict<FacialRecognitionResponse>({ imagePath }, request);
    return {
      imageHeight: response.imageHeight,
      imageWidth: response.imageWidth,
      faces: response[ModelTask.FACIAL_RECOGNITION],
    };
  }

  async encodeImage(imagePath: string, { modelName }: CLIPConfig) {
    const request = { [ModelTask.SEARCH]: { [ModelType.VISUAL]: { modelName } } };
    const response = await this.predict<ClipVisualResponse>({ imagePath }, request);
    return response[ModelTask.SEARCH];
  }

  async encodeText(text: string, { language, modelName }: TextEncodingOptions) {
    const request = { [ModelTask.SEARCH]: { [ModelType.TEXTUAL]: { modelName, options: { language } } } };
    const response = await this.predict<ClipTextualResponse>({ text }, request);
    return response[ModelTask.SEARCH];
  }

  private orderedUrls() {
    return [
      // try healthy servers first
      ...this.config.urls.filter((url) => this.isHealthy(url)),
      ...this.config.urls.filter((url) => !this.isHealthy(url)),
    ];
  }

  private async getImagesFormData(imagePaths: string[], options: object): Promise<FormData> {
    const formData = new FormData();
    formData.append('options', JSON.stringify(options));
    for (const imagePath of imagePaths) {
      const fileBuffer = await readFile(imagePath);
      formData.append('images', new Blob([new Uint8Array(fileBuffer)]));
    }
    return formData;
  }

  async panoramaDetect(imagePaths: string[], options: PanoramaDetectOptions): Promise<PanoramaDetectResponse> {
    const formData = await this.getImagesFormData(imagePaths, options);

    for (const url of this.orderedUrls()) {
      try {
        const response = await fetch(new URL('panorama/detect', url), { method: 'POST', body: formData });
        if (response.ok) {
          this.setHealthy(url, true);
          return response.json();
        }
        this.logger.warn(`Panorama detect request to "${url}" failed with status ${response.status}`);
      } catch (error: Error | unknown) {
        this.logger.warn(`Panorama detect request to "${url}" failed: ${error instanceof Error ? error.message : error}`);
        this.setHealthy(url, false);
      }
    }

    throw new Error(`Panorama detect request failed for all URLs`);
  }

  async panoramaStitch(imagePaths: string[], options: PanoramaStitchOptions): Promise<PanoramaStitchResult> {
    const formData = await this.getImagesFormData(imagePaths, options);

    // A stitch is minutes of CPU on the ML side: try each URL at most once and
    // never retry after a timeout, so a slow stitch cannot be doubled up.
    for (const url of this.orderedUrls()) {
      try {
        const response = await fetch(new URL('panorama/stitch', url), {
          method: 'POST',
          body: formData,
          signal: AbortSignal.timeout(240_000),
        });
        if (response.ok) {
          this.setHealthy(url, true);
          return {
            data: Buffer.from(await response.arrayBuffer()),
            width: Number(response.headers.get('X-Immich-Pano-Width')),
            height: Number(response.headers.get('X-Immich-Pano-Height')),
          };
        }
        const detail = await response.text().catch(() => '');
        throw new Error(`Panorama stitch failed with status ${response.status}: ${detail.slice(0, 200)}`);
      } catch (error: Error | unknown) {
        if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
          throw new Error(`Panorama stitch timed out against "${url}"`);
        }
        throw error instanceof Error ? error : new Error(String(error));
      }
    }

    throw new Error(`No machine learning servers configured for panorama stitch`);
  }

  async ocr(imagePath: string, { modelName, minDetectionScore, minRecognitionScore, maxResolution }: OcrOptions) {
    const request = {
      [ModelTask.OCR]: {
        [ModelType.DETECTION]: { modelName, options: { minScore: minDetectionScore, maxResolution } },
        [ModelType.RECOGNITION]: { modelName, options: { minScore: minRecognitionScore } },
      },
    };
    const response = await this.predict<OcrResponse>({ imagePath }, request);
    return response[ModelTask.OCR];
  }

  private async getFormData(payload: ModelPayload, config: MachineLearningRequest): Promise<FormData> {
    const formData = new FormData();
    formData.append('entries', JSON.stringify(config));

    if ('imagePath' in payload) {
      const fileBuffer = await readFile(payload.imagePath);
      formData.append('image', new Blob([new Uint8Array(fileBuffer)]));
    } else if ('text' in payload) {
      formData.append('text', payload.text);
    } else {
      throw new Error('Invalid input');
    }

    return formData;
  }
}
