import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const TaskConfigSchema = z
  .object({
    enabled: z.boolean().describe('Whether the task is enabled'),
  })
  .meta({ id: 'TaskConfig' });

const ModelConfigSchema = TaskConfigSchema.extend({
  modelName: z.string().describe('Name of the model to use'),
});

export const CLIPConfigSchema = ModelConfigSchema.meta({ id: 'CLIPConfig' });

export const DuplicateDetectionConfigSchema = TaskConfigSchema.extend({
  maxDistance: z
    .number()
    .meta({ format: 'double' })
    .min(0.001)
    .max(0.1)
    .describe('Maximum distance threshold for duplicate detection'),
}).meta({ id: 'DuplicateDetectionConfig' });

export const FacialRecognitionConfigSchema = ModelConfigSchema.extend({
  minScore: z
    .number()
    .meta({ format: 'double' })
    .min(0.1)
    .max(1)
    .describe('Minimum confidence score for face detection'),
  maxDistance: z
    .number()
    .meta({ format: 'double' })
    .min(0.1)
    .max(2)
    .describe('Maximum distance threshold for face recognition'),
  minFaces: z.int().min(1).describe('Minimum number of faces required for recognition'),
}).meta({ id: 'FacialRecognitionConfig' });

export const OcrConfigSchema = ModelConfigSchema.extend({
  maxResolution: z.int().min(1).describe('Maximum resolution for OCR processing'),
  minDetectionScore: z
    .number()
    .meta({ format: 'double' })
    .min(0.1)
    .max(1)
    .describe('Minimum confidence score for text detection'),
  minRecognitionScore: z
    .number()
    .meta({ format: 'double' })
    .min(0.1)
    .max(1)
    .describe('Minimum confidence score for text recognition'),
}).meta({ id: 'OcrConfig' });

export const PanoramaConfigSchema = ModelConfigSchema.extend({
  maxGapSeconds: z.int().min(1).max(120).describe('Maximum seconds between consecutive shots in a sweep'),
  minFrames: z.int().min(2).max(32).describe('Minimum frames for a panorama group'),
  maxFrames: z.int().min(2).max(32).describe('Maximum frames stitched into one panorama'),
  minOverlap: z
    .number()
    .meta({ format: 'double' })
    .min(0)
    .max(1)
    .describe('Minimum pairwise frame overlap for a sweep link'),
  maxOverlap: z
    .number()
    .meta({ format: 'double' })
    .min(0)
    .max(1)
    .describe('Maximum pairwise frame overlap for a sweep link (higher is a duplicate)'),
  minInliers: z.int().min(4).describe('Minimum RANSAC inlier matches for a valid link'),
  minDisplacement: z
    .number()
    .meta({ format: 'double' })
    .min(0)
    .max(1)
    .describe('Minimum camera sweep displacement between frames, as a fraction of frame size'),
  autoStitch: z.boolean().describe('Automatically stitch detected panoramas without review'),
  stackSources: z.boolean().describe('Stack the source frames under the generated panorama'),
  rawPano: z.boolean().describe('Also produce a panorama developed from RAW twins when every frame has one'),
  quality: z.int().min(50).max(100).describe('JPEG quality of the stitched panorama'),
  compositeResolution: z
    .enum(['full', 'preview'])
    .describe('Stitch at full original resolution or fast preview resolution'),
}).meta({ id: 'PanoramaConfig' });

export class CLIPConfig extends createZodDto(CLIPConfigSchema) {}
