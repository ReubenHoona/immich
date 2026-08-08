import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_job_status" ADD "panoramaAt" timestamp with time zone;`.execute(db);
  await sql`CREATE TABLE "panorama_group" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updateId" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "ownerId" uuid NOT NULL,
  "status" character varying NOT NULL,
  "score" real NOT NULL,
  "linkStats" jsonb,
  "resultAssetId" uuid,
  CONSTRAINT "panorama_group_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "panorama_group_resultAssetId_fkey" FOREIGN KEY ("resultAssetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "panorama_group_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "panorama_group_ownerId_idx" ON "panorama_group" ("ownerId");`.execute(db);
  await sql`CREATE INDEX "panorama_group_resultAssetId_idx" ON "panorama_group" ("resultAssetId");`.execute(db);
  await sql`CREATE OR REPLACE TRIGGER "panorama_group_updatedAt"
  BEFORE UPDATE ON "panorama_group"
  FOR EACH ROW
  EXECUTE FUNCTION updated_at();`.execute(db);
  await sql`CREATE TABLE "panorama_group_asset" (
  "groupId" uuid NOT NULL,
  "assetId" uuid NOT NULL,
  "sortOrder" integer NOT NULL,
  CONSTRAINT "panorama_group_asset_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "panorama_group" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "panorama_group_asset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "panorama_group_asset_pkey" PRIMARY KEY ("groupId", "assetId")
);`.execute(db);
  await sql`CREATE INDEX "panorama_group_asset_groupId_idx" ON "panorama_group_asset" ("groupId");`.execute(db);
  await sql`CREATE INDEX "panorama_group_asset_assetId_idx" ON "panorama_group_asset" ("assetId");`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_panorama_group_updatedAt', '{"type":"trigger","name":"panorama_group_updatedAt","sql":"CREATE OR REPLACE TRIGGER \\"panorama_group_updatedAt\\"\\n  BEFORE UPDATE ON \\"panorama_group\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION updated_at();"}'::jsonb);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_job_status" DROP COLUMN "panoramaAt";`.execute(db);
  await sql`DROP TRIGGER "panorama_group_updatedAt" ON "panorama_group";`.execute(db);
  await sql`DROP TABLE "panorama_group_asset";`.execute(db);
  await sql`DROP TABLE "panorama_group";`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_panorama_group_updatedAt';`.execute(db);
}
