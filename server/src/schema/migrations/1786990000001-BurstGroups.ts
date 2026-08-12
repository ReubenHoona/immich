import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "burst_group" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "ownerId" uuid NOT NULL,
  "status" character varying NOT NULL DEFAULT 'candidate',
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updateId" uuid NOT NULL DEFAULT immich_uuid_v7(),
  CONSTRAINT "burst_group_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "burst_group_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "burst_group_ownerId_idx" ON "burst_group" ("ownerId");`.execute(db);
  await sql`CREATE INDEX "burst_group_updateId_idx" ON "burst_group" ("updateId");`.execute(db);
  await sql`CREATE OR REPLACE TRIGGER "burst_group_updatedAt"
  BEFORE UPDATE ON "burst_group"
  FOR EACH ROW
  EXECUTE FUNCTION updated_at();`.execute(db);
  await sql`CREATE TABLE "burst_group_asset" (
  "burstGroupId" uuid NOT NULL,
  "assetId" uuid NOT NULL,
  "distance" double precision NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "burst_group_asset_burstGroupId_fkey" FOREIGN KEY ("burstGroupId") REFERENCES "burst_group" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "burst_group_asset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "burst_group_asset_pkey" PRIMARY KEY ("burstGroupId", "assetId")
);`.execute(db);
  await sql`CREATE INDEX "burst_group_asset_burstGroupId_idx" ON "burst_group_asset" ("burstGroupId");`.execute(db);
  await sql`CREATE INDEX "burst_group_asset_assetId_idx" ON "burst_group_asset" ("assetId");`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_burst_group_updatedAt', '{"type":"trigger","name":"burst_group_updatedAt","sql":"CREATE OR REPLACE TRIGGER \\"burst_group_updatedAt\\"\\n  BEFORE UPDATE ON \\"burst_group\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION updated_at();"}'::jsonb);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TRIGGER "burst_group_updatedAt" ON "burst_group";`.execute(db);
  await sql`DROP TABLE "burst_group_asset";`.execute(db);
  await sql`DROP TABLE "burst_group";`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_burst_group_updatedAt';`.execute(db);
}
