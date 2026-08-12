import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Generated,
  Table,
  Timestamp,
  UpdateDateColumn,
} from '@immich/sql-tools';
import { PrimaryGeneratedUuidV7Column, UpdatedAtTrigger, UpdateIdColumn } from 'src/decorators';
import { BurstGroupStatus } from 'src/enum';
import { UserTable } from 'src/schema/tables/user.table';

/**
 * A run of frames the camera captured within a couple of seconds of each other that also look
 * alike — a candidate multi-shot burst, waiting for the user to accept or dismiss it.
 */
@Table('burst_group')
@UpdatedAtTrigger('burst_group_updatedAt')
export class BurstGroupTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  ownerId!: string;

  @Column({ default: BurstGroupStatus.Candidate })
  status!: Generated<BurstGroupStatus>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;
}
