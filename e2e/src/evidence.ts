/**
 * Evidence harness for the missing-file self-healing feature.
 *
 * Two responsibilities:
 *  1. Snapshot the full FK-attached graph of an asset straight from Postgres, so a spec can prove
 *     that an in-place restore preserved every attached row byte-for-byte (the headline
 *     "no-data-loss" claim that refutes delete-and-reupload).
 *  2. Accumulate a correlated, cross-layer timeline (server log by correlation id | on-disk
 *     file + sha1 | DB row diff | PASS/FAIL) and emit it as a markdown report per scenario. This
 *     bundle is the PR's reproducible proof artifact.
 *
 * Output lands in `e2e/evidence/<scenario>.md` (git-ignored; produced when the specs run against
 * the merged image).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Client } from 'pg';
import type { ServerLogLine } from 'src/utils';

export const evidenceDir = resolve(import.meta.dirname, '../evidence');

// ---------------------------------------------------------------------------
// DB graph snapshot + diff
// ---------------------------------------------------------------------------

export type Row = Record<string, unknown>;

/**
 * A snapshot of every DB row FK-attached to a single asset. Everything a same-row restore must
 * leave untouched. `files` (derivative thumbnails) is expected to change on restore — the original
 * file's derivatives are regenerated — so it is captured for evidence but excluded from the
 * byte-identity comparison.
 */
export type AssetGraphSnapshot = {
  asset: Row | null;
  exif: Row | null;
  faces: Row[];
  tags: Row[];
  albums: Row[];
  activities: Row[];
  files: Row[];
  stack: Row | null;
};

const one = async (client: Client, sql: string, params: unknown[]): Promise<Row | null> => {
  const { rows } = await client.query(sql, params);
  return rows[0] ?? null;
};

const many = async (client: Client, sql: string, params: unknown[]): Promise<Row[]> => {
  const { rows } = await client.query(sql, params);
  return rows;
};

export const snapshotAssetGraph = async (client: Client, assetId: string): Promise<AssetGraphSnapshot> => {
  const asset = await one(
    client,
    `SELECT id,
            "originalPath",
            encode(checksum, 'hex') AS checksum,
            "checksumAlgorithm",
            "isOffline",
            "isFavorite",
            "deletedAt"::text          AS "deletedAt",
            "stackId",
            "duplicateId",
            visibility,
            status,
            "createdAt"::text          AS "createdAt",
            "localDateTime"::text      AS "localDateTime",
            "fileCreatedAt"::text      AS "fileCreatedAt"
     FROM asset
     WHERE id = $1`,
    [assetId],
  );

  const exif = await one(
    client,
    `SELECT description, rating, "lockedProperties" FROM asset_exif WHERE "assetId" = $1`,
    [assetId],
  );

  const faces = await many(
    client,
    `SELECT id, "personId", "boundingBoxX1", "boundingBoxY1", "boundingBoxX2", "boundingBoxY2",
            "sourceType", "isVisible", "updateId"
     FROM asset_face
     WHERE "assetId" = $1
     ORDER BY id`,
    [assetId],
  );

  const tags = await many(client, `SELECT "tagId" FROM tag_asset WHERE "assetId" = $1 ORDER BY "tagId"`, [assetId]);

  const albums = await many(
    client,
    `SELECT "albumId" FROM album_asset WHERE "assetId" = $1 ORDER BY "albumId"`,
    [assetId],
  );

  const activities = await many(
    client,
    `SELECT id, comment, "isLiked" FROM activity WHERE "assetId" = $1 ORDER BY id`,
    [assetId],
  );

  const files = await many(
    client,
    `SELECT type, path FROM asset_file WHERE "assetId" = $1 ORDER BY type, path`,
    [assetId],
  );

  const stack = await one(
    client,
    `SELECT id, "primaryAssetId", "ownerId" FROM stack WHERE id = (SELECT "stackId" FROM asset WHERE id = $1)`,
    [assetId],
  );

  return { asset, exif, faces, tags, albums, activities, files, stack };
};

const stable = (value: unknown): string => JSON.stringify(value ?? null);

/** Fields on the asset row that a same-row restore legitimately mutates (offline is cleared). */
export const VOLATILE_ASSET_FIELDS = new Set(['isOffline']);

export type FieldDiff = { key: string; before: unknown; after: unknown; changed: boolean };

/** Diff the `asset` row across two snapshots, key by key. */
export const diffAssetRow = (before: AssetGraphSnapshot, after: AssetGraphSnapshot): FieldDiff[] => {
  const keys = new Set([...Object.keys(before.asset ?? {}), ...Object.keys(after.asset ?? {})]);
  return [...keys].sort().map((key) => {
    const b = before.asset?.[key];
    const a = after.asset?.[key];
    return { key, before: b, after: a, changed: stable(b) !== stable(a) };
  });
};

export type GraphComparison = {
  /** True when every attached collection (faces/tags/albums/activities/exif/stack) is byte-identical. */
  attachedIdentical: boolean;
  /** Per-collection identity result. */
  collections: Record<string, { identical: boolean; before: number; after: number }>;
  /** Asset-row fields that changed AND are not in the volatile allow-list. */
  unexpectedAssetChanges: FieldDiff[];
};

/**
 * Compare two snapshots for the no-data-loss claim: all attached collections must be identical, and
 * the only asset-row fields allowed to change are the volatile ones (isOffline / deleteReason).
 * `files` (thumbnails) are intentionally NOT part of the identity check.
 */
export const compareAssetGraphs = (before: AssetGraphSnapshot, after: AssetGraphSnapshot): GraphComparison => {
  const collectionKeys: Array<keyof AssetGraphSnapshot> = ['faces', 'tags', 'albums', 'activities'];
  const collections: GraphComparison['collections'] = {};

  for (const key of collectionKeys) {
    const b = before[key] as Row[];
    const a = after[key] as Row[];
    collections[key] = { identical: stable(b) === stable(a), before: b.length, after: a.length };
  }

  collections.exif = {
    identical: stable(before.exif) === stable(after.exif),
    before: before.exif ? 1 : 0,
    after: after.exif ? 1 : 0,
  };
  collections.stack = {
    identical: stable(before.stack) === stable(after.stack),
    before: before.stack ? 1 : 0,
    after: after.stack ? 1 : 0,
  };

  const unexpectedAssetChanges = diffAssetRow(before, after).filter(
    (diff) => diff.changed && !VOLATILE_ASSET_FIELDS.has(diff.key),
  );

  const attachedIdentical = Object.values(collections).every((entry) => entry.identical);

  return { attachedIdentical, collections, unexpectedAssetChanges };
};

// ---------------------------------------------------------------------------
// File + sha1 state (for the "on-disk" evidence column)
// ---------------------------------------------------------------------------

export type FileState = { path: string; present: boolean; sha1?: string | null };

export const formatFileState = (state?: FileState): string => {
  if (!state) {
    return '';
  }
  if (!state.present) {
    return `absent \`${state.path}\``;
  }
  return `present sha1=\`${state.sha1 ?? '?'}\``;
};

// ---------------------------------------------------------------------------
// Evidence report (correlated markdown timeline)
// ---------------------------------------------------------------------------

export type EvidenceResult = 'PASS' | 'FAIL' | 'INFO';

export type EvidenceRow = {
  event: string;
  /** Correlated server log line(s). */
  serverLog?: string;
  /** On-disk file + sha1 state. */
  fileState?: string;
  /** DB row diff / snapshot summary. */
  dbDiff?: string;
  result?: EvidenceResult;
};

export type EvidenceMeta = {
  title: string;
  description?: string;
  assetId?: string;
  correlationId?: string;
};

const cell = (value?: string): string =>
  (value ?? '')
    .replaceAll('|', '\\|')
    .replaceAll('\n', '<br>')
    .trim() || '—';

/**
 * Reduce captured server logs to a compact one-cell summary (level + message, most recent first,
 * capped) for a timeline row.
 */
export const summarizeLogs = (logs: ServerLogLine[], limit = 3): string => {
  if (logs.length === 0) {
    return '';
  }
  return logs
    .slice(-limit)
    .map((line) => {
      const level = typeof line.json?.level === 'string' ? `[${line.json.level}] ` : '';
      const message = line.message.length > 160 ? `${line.message.slice(0, 157)}…` : line.message;
      return `${level}${message}`;
    })
    .join('\n');
};

export class EvidenceReport {
  private readonly rows: EvidenceRow[] = [];
  private failures = 0;

  constructor(
    private readonly scenario: string,
    private readonly meta: EvidenceMeta,
  ) {}

  /** Append a raw timeline row. */
  row(row: EvidenceRow): this {
    if (row.result === 'FAIL') {
      this.failures++;
    }
    this.rows.push(row);
    return this;
  }

  /** Append an informational (non-assertion) timeline row. */
  info(event: string, extra: Omit<EvidenceRow, 'event' | 'result'> = {}): this {
    return this.row({ event, result: 'INFO', ...extra });
  }

  /** Record an assertion as a PASS/FAIL row without throwing (so a report is always complete). */
  assert(event: string, condition: boolean, extra: Omit<EvidenceRow, 'event' | 'result'> = {}): boolean {
    this.row({ event, result: condition ? 'PASS' : 'FAIL', ...extra });
    return condition;
  }

  get passed(): boolean {
    return this.failures === 0;
  }

  private toMarkdown(): string {
    const lines: string[] = [];
    lines.push(`# Evidence — ${this.meta.title}`);
    lines.push('');
    lines.push(`- **Scenario:** \`${this.scenario}\``);
    lines.push(`- **Result:** ${this.passed ? '✅ PASS' : '❌ FAIL'}`);
    if (this.meta.assetId) {
      lines.push(`- **Asset id:** \`${this.meta.assetId}\``);
    }
    if (this.meta.correlationId) {
      lines.push(`- **Correlation id:** \`${this.meta.correlationId}\``);
    }
    lines.push(`- **Generated:** ${new Date().toISOString()}`);
    if (this.meta.description) {
      lines.push('');
      lines.push(this.meta.description);
    }
    lines.push('');
    lines.push('| # | Event | Server log (by correlation id) | On-disk file + sha1 | DB diff | Result |');
    lines.push('| - | ----- | ------------------------------ | ------------------- | ------- | ------ |');
    for (const [index, row] of this.rows.entries()) {
      const badge = row.result === 'PASS' ? '✅' : row.result === 'FAIL' ? '❌' : 'ℹ️';
      lines.push(
        `| ${index + 1} | ${cell(row.event)} | ${cell(row.serverLog)} | ${cell(row.fileState)} | ${cell(
          row.dbDiff,
        )} | ${badge} |`,
      );
    }
    lines.push('');
    return lines.join('\n');
  }

  /** Write the markdown report to `e2e/evidence/<scenario>.md` and return the absolute path. */
  write(): string {
    mkdirSync(evidenceDir, { recursive: true });
    const path = resolve(evidenceDir, `${this.scenario}.md`);
    writeFileSync(path, this.toMarkdown());
    return path;
  }
}
