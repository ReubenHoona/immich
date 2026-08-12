import { createZodDto } from 'nestjs-zod';
import { AssetResponseSchema, MapAsset, mapAsset } from 'src/dtos/asset-response.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { BurstGroupStatus, BurstGroupStatusSchema } from 'src/enum';
import z from 'zod';

const BurstGroupSearchSchema = z
  .object({
    status: BurstGroupStatusSchema.optional().describe('Filter by status'),
  })
  .meta({ id: 'BurstGroupSearchDto' });

const BurstGroupResponseSchema = z
  .object({
    id: z.uuidv7().describe('Burst group ID'),
    status: BurstGroupStatusSchema,
    createdAt: z.string().describe('Creation date'),
    assets: z.array(AssetResponseSchema).describe('Frames in the burst, closest to the reference first'),
    distances: z
      .array(z.number().meta({ format: 'double' }))
      .describe('Embedding distance of each frame from the reference, aligned with `assets`'),
  })
  .describe('Burst group response')
  .meta({ id: 'BurstGroupResponseDto' });

export class BurstGroupSearchDto extends createZodDto(BurstGroupSearchSchema) {}
export class BurstGroupResponseDto extends createZodDto(BurstGroupResponseSchema) {}

type BurstGroup = {
  id: string;
  status: BurstGroupStatus;
  createdAt: Date;
  members: { assetId: string; distance: number }[];
};

export const mapBurstGroup = (
  group: BurstGroup,
  assetById: Map<string, MapAsset>,
  auth: AuthDto,
): BurstGroupResponseDto => {
  const present = group.members.filter(({ assetId }) => assetById.has(assetId));

  return {
    id: group.id,
    status: group.status,
    createdAt: group.createdAt.toISOString(),
    assets: present.map(({ assetId }) => mapAsset(assetById.get(assetId)!, { auth })),
    distances: present.map(({ distance }) => distance),
  };
};
