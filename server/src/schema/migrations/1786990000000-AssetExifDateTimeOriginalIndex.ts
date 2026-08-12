import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE INDEX "asset_exif_dateTimeOriginal_idx" ON "asset_exif" ("dateTimeOriginal");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX "asset_exif_dateTimeOriginal_idx";`.execute(db);
}
