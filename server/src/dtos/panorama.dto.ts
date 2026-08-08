import { createZodDto } from 'nestjs-zod';
import { AssetResponseSchema } from 'src/dtos/asset-response.dto';
import { PanoramaGroupStatus, PanoramaGroupStatusSchema } from 'src/enum';
import z from 'zod';

const PanoramaGroupResponseSchema = z
  .object({
    id: z.uuidv4().describe('Panorama group ID'),
    status: PanoramaGroupStatusSchema,
    score: z.number().meta({ format: 'double' }).describe('Detection confidence score (higher is better)'),
    assets: z.array(AssetResponseSchema).describe('Source frames, in sweep order'),
    resultAssetId: z.uuidv4().nullable().describe('The stitched panorama asset, once generated'),
    createdAt: z.iso.datetime().describe('When the group was detected'),
  })
  .meta({ id: 'PanoramaGroupResponseDto' });

const PanoramaGroupSearchSchema = z
  .object({
    status: PanoramaGroupStatusSchema.optional().describe('Filter by group status'),
  })
  .meta({ id: 'PanoramaGroupSearchDto' });

export const PanoramaGroupUpdateStatusSchema = z
  .enum([PanoramaGroupStatus.Candidate, PanoramaGroupStatus.Dismissed])
  .describe('Dismiss a candidate group, or restore a dismissed one')
  .meta({ id: 'PanoramaGroupUpdateStatus' });

const PanoramaGroupUpdateSchema = z
  .object({
    status: PanoramaGroupUpdateStatusSchema,
  })
  .meta({ id: 'PanoramaGroupUpdateDto' });

export class PanoramaGroupResponseDto extends createZodDto(PanoramaGroupResponseSchema) {}
export class PanoramaGroupSearchDto extends createZodDto(PanoramaGroupSearchSchema) {}
export class PanoramaGroupUpdateDto extends createZodDto(PanoramaGroupUpdateSchema) {}
