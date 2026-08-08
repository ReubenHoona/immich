import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Updateable } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators';
import { PanoramaGroupStatus } from 'src/enum';
import { DB } from 'src/schema';
import { PanoramaGroupTable } from 'src/schema/tables/panorama-group.table';

const PENDING_STATUSES = [PanoramaGroupStatus.Candidate, PanoramaGroupStatus.Failed];

@Injectable()
export class PanoramaRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  async create(group: Insertable<PanoramaGroupTable>, assetIds: string[]) {
    return this.db.transaction().execute(async (tx) => {
      const newGroup = await tx.insertInto('panorama_group').values(group).returningAll().executeTakeFirstOrThrow();
      await tx
        .insertInto('panorama_group_asset')
        .values(assetIds.map((assetId, sortOrder) => ({ groupId: newGroup.id, assetId, sortOrder })))
        .execute();
      return newGroup;
    });
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getById(id: string) {
    return this.db
      .selectFrom('panorama_group')
      .selectAll('panorama_group')
      .select((eb) =>
        jsonArrayFrom(
          eb
            .selectFrom('panorama_group_asset')
            .select(['panorama_group_asset.assetId', 'panorama_group_asset.sortOrder'])
            .whereRef('panorama_group_asset.groupId', '=', 'panorama_group.id')
            .orderBy('panorama_group_asset.sortOrder'),
        ).as('members'),
      )
      .where('panorama_group.id', '=', id)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  getAllForUser(ownerId: string, status?: PanoramaGroupStatus) {
    return this.db
      .selectFrom('panorama_group')
      .selectAll('panorama_group')
      .select((eb) =>
        jsonArrayFrom(
          eb
            .selectFrom('panorama_group_asset')
            .select(['panorama_group_asset.assetId', 'panorama_group_asset.sortOrder'])
            .whereRef('panorama_group_asset.groupId', '=', 'panorama_group.id')
            .orderBy('panorama_group_asset.sortOrder'),
        ).as('members'),
      )
      .where('panorama_group.ownerId', '=', ownerId)
      .$if(!!status, (qb) => qb.where('panorama_group.status', '=', status!))
      .orderBy('panorama_group.score', 'desc')
      .execute();
  }

  async update(id: string, group: Updateable<PanoramaGroupTable>) {
    return this.db
      .updateTable('panorama_group')
      .set({ ...group, updatedAt: new Date() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** Wipe pending (candidate/failed) groups, e.g. on a force re-run. */
  async deletePending(): Promise<void> {
    await this.db.deleteFrom('panorama_group').where('status', 'in', PENDING_STATUSES).execute();
  }

  /** Wipe pending groups that touch any of the given assets (the cluster is being re-evaluated). */
  async deletePendingByAssetIds(assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }
    await this.db
      .deleteFrom('panorama_group')
      .where('status', 'in', PENDING_STATUSES)
      .where('id', 'in', (eb) =>
        eb.selectFrom('panorama_group_asset').select('groupId').where('assetId', 'in', assetIds),
      )
      .execute();
  }

  /** Member sets of settled (dismissed/completed) groups touching the given assets. */
  async getSettledMemberSets(assetIds: string[]): Promise<string[][]> {
    if (assetIds.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom('panorama_group')
      .innerJoin('panorama_group_asset', 'panorama_group_asset.groupId', 'panorama_group.id')
      .select((eb) => [
        'panorama_group.id',
        eb.fn
          .agg<string[]>('array_agg', ['panorama_group_asset.assetId'])
          .orderBy('panorama_group_asset.assetId', 'asc')
          .as('assetIds'),
      ])
      .where('panorama_group.status', 'in', [PanoramaGroupStatus.Dismissed, PanoramaGroupStatus.Completed])
      .where('panorama_group.id', 'in', (eb) =>
        eb.selectFrom('panorama_group_asset').select('groupId').where('assetId', 'in', assetIds),
      )
      .groupBy('panorama_group.id')
      .execute();
    return rows.map((row) => row.assetIds);
  }
}
