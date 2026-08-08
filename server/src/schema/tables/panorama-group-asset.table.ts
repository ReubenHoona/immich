import { Column, ForeignKeyColumn, Table } from '@immich/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table';
import { PanoramaGroupTable } from 'src/schema/tables/panorama-group.table';

@Table({ name: 'panorama_group_asset' })
export class PanoramaGroupAssetTable {
  @ForeignKeyColumn(() => PanoramaGroupTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false, primary: true })
  groupId!: string;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false, primary: true })
  assetId!: string;

  @Column({ type: 'integer' })
  sortOrder!: number;
}
