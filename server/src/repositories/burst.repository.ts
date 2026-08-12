import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import { Chunked, DummyValue, GenerateSql } from 'src/decorators';
import { AssetType, BurstGroupStatus } from 'src/enum';
import { DB } from 'src/schema';
import { anyUuid, asUuid, withDefaultVisibility } from 'src/utils/database';

export interface BurstMemberInput {
  assetId: string;
  distance: number;
}

@Injectable()
export class BurstRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /**
   * Un-stacked images in capture order. The detector walks this once and cuts it into runs, so it
   * deliberately carries no similarity information — that costs a vector read and is only worth
   * paying for frames that already passed the cheap time/camera gate.
   */
  @GenerateSql({ params: [], stream: true })
  streamForBurstDetection() {
    return (
      this.db
        .selectFrom('asset')
        .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
        .select([
          'asset.id as id',
          'asset.ownerId as ownerId',
          'asset.originalFileName as originalFileName',
          'asset_exif.dateTimeOriginal as dateTimeOriginal',
          'asset_exif.make as make',
          'asset_exif.model as model',
        ])
        .where('asset.type', '=', AssetType.Image)
        .where('asset.deletedAt', 'is', null)
        // an asset that is already stacked (manually, or as a RAW+JPEG pair) is spoken for
        .where('asset.stackId', 'is', null)
        .where('asset_exif.dateTimeOriginal', 'is not', null)
        .$call(withDefaultVisibility)
        // camera-major so two bodies shooting at the same time partition into separate runs
        // instead of terminating each other's; no index can serve this sort anyway (the columns
        // span two tables), so the extra keys are free
        .orderBy('ownerId')
        .orderBy('make')
        .orderBy('model')
        .orderBy('dateTimeOriginal')
        .orderBy('id')
        .stream()
    );
  }

  /**
   * Cosine distance from `referenceId` to each of `assetIds`, for assets that have an embedding.
   * Unlike duplicate detection this is not a nearest-neighbour search — the candidate set is
   * already known, so it is a plain join and needs no index probe tuning.
   */
  @GenerateSql({ params: [{ referenceId: DummyValue.UUID, assetIds: [DummyValue.UUID] }] })
  async getEmbeddingDistances({ referenceId, assetIds }: { referenceId: string; assetIds: string[] }) {
    return this.db
      .selectFrom('smart_search')
      .select(['smart_search.assetId as assetId'])
      .select((eb) =>
        sql<number>`smart_search.embedding <=> ${eb
          .selectFrom('smart_search as reference')
          .select('reference.embedding')
          .where('reference.assetId', '=', asUuid(referenceId))}`.as('distance'),
      )
      .where('smart_search.assetId', '=', anyUuid(assetIds))
      .execute();
  }

  async create(ownerId: string, members: BurstMemberInput[]) {
    return this.db.transaction().execute(async (tx) => {
      const group = await tx
        .insertInto('burst_group')
        .values({ ownerId, status: BurstGroupStatus.Candidate })
        .returning('id')
        .executeTakeFirstOrThrow();

      await this.insertMembers(tx, group.id, members);

      return group;
    });
  }

  /** Chunked: each member contributes three bind parameters and Postgres caps a statement at 65535. */
  @Chunked({ paramIndex: 2 })
  private async insertMembers(tx: Kysely<DB>, burstGroupId: string, members: BurstMemberInput[]) {
    if (members.length === 0) {
      return;
    }

    await tx
      .insertInto('burst_group_asset')
      .values(members.map(({ assetId, distance }) => ({ burstGroupId, assetId, distance })))
      .execute();
  }

  /**
   * The members of a group that can still be stacked right now — not trashed, not already part of
   * some other stack, and visible. The stored member list is a snapshot from detection time.
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  getStackableMembers(burstGroupId: string) {
    return this.db
      .selectFrom('burst_group_asset')
      .innerJoin('asset', 'asset.id', 'burst_group_asset.assetId')
      .select(['burst_group_asset.assetId as assetId', 'burst_group_asset.distance as distance'])
      .where('burst_group_asset.burstGroupId', '=', asUuid(burstGroupId))
      .where('asset.deletedAt', 'is', null)
      .where('asset.stackId', 'is', null)
      .$call(withDefaultVisibility)
      .orderBy('distance')
      .execute();
  }

  /**
   * Filenames of assets that already belong to a group, so a re-run neither duplicates a candidate
   * nor resurrects one the user dismissed. Filenames rather than ids because the caller matches by
   * normalized stem: a group holds one frame per shot, and the RAW twin of an already-handled shot
   * must not come back as a burst of its own.
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  getGroupedAssetNames(ownerId: string) {
    return this.db
      .selectFrom('burst_group_asset')
      .innerJoin('burst_group', 'burst_group.id', 'burst_group_asset.burstGroupId')
      .innerJoin('asset', 'asset.id', 'burst_group_asset.assetId')
      .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select([
        'asset.id as id',
        'asset.originalFileName as originalFileName',
        'asset_exif.dateTimeOriginal as dateTimeOriginal',
        'asset_exif.make as make',
        'asset_exif.model as model',
      ])
      .where('burst_group.ownerId', '=', asUuid(ownerId))
      .execute();
  }

  /**
   * Un-stacked images of one owner captured inside a window — used when accepting a group, to pull
   * in the RAW twin of each frame so the stack holds every file of the shot rather than leaving the
   * RAWs loose in the timeline.
   */
  @GenerateSql({ params: [{ ownerId: DummyValue.UUID, from: DummyValue.DATE, to: DummyValue.DATE }] })
  getUnstackedInRange({ ownerId, from, to }: { ownerId: string; from: Date; to: Date }) {
    return this.db
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select(['asset.id as id', 'asset.originalFileName as originalFileName'])
      .where('asset.ownerId', '=', asUuid(ownerId))
      .where('asset.type', '=', AssetType.Image)
      .where('asset.deletedAt', 'is', null)
      .where('asset.stackId', 'is', null)
      .where('asset_exif.dateTimeOriginal', '>=', from)
      .where('asset_exif.dateTimeOriginal', '<=', to)
      .$call(withDefaultVisibility)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, BurstGroupStatus.Candidate] })
  getAllForUser(ownerId: string, status?: BurstGroupStatus) {
    return this.db
      .selectFrom('burst_group')
      .selectAll('burst_group')
      .select((eb) =>
        jsonArrayFrom(
          eb
            .selectFrom('burst_group_asset')
            .select(['burst_group_asset.assetId as assetId', 'burst_group_asset.distance as distance'])
            .whereRef('burst_group_asset.burstGroupId', '=', 'burst_group.id')
            .orderBy('burst_group_asset.distance'),
        ).as('members'),
      )
      .where('burst_group.ownerId', '=', asUuid(ownerId))
      .$if(!!status, (eb) => eb.where('burst_group.status', '=', status!))
      .orderBy('burst_group.createdAt', 'desc')
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getById(id: string) {
    return this.db
      .selectFrom('burst_group')
      .selectAll('burst_group')
      .select((eb) =>
        jsonArrayFrom(
          eb
            .selectFrom('burst_group_asset')
            .select(['burst_group_asset.assetId as assetId', 'burst_group_asset.distance as distance'])
            .whereRef('burst_group_asset.burstGroupId', '=', 'burst_group.id')
            .orderBy('burst_group_asset.distance'),
        ).as('members'),
      )
      .where('burst_group.id', '=', asUuid(id))
      .executeTakeFirst();
  }

  async setStatus(id: string, status: BurstGroupStatus) {
    await this.db.updateTable('burst_group').set({ status }).where('id', '=', asUuid(id)).execute();
  }
}
