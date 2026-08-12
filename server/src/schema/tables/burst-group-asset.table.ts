import { Column, CreateDateColumn, ForeignKeyColumn, Generated, Table, Timestamp } from '@immich/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table';
import { BurstGroupTable } from 'src/schema/tables/burst-group.table';

@Table('burst_group_asset')
export class BurstGroupAssetTable {
  @ForeignKeyColumn(() => BurstGroupTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', primary: true })
  burstGroupId!: string;

  @ForeignKeyColumn(() => AssetTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', primary: true })
  assetId!: string;

  /** Cosine distance from the group's reference frame; 0 for the reference itself. */
  @Column({ type: 'double precision' })
  distance!: number;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
