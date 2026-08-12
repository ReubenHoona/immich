import {
  AssetMediaResponseDto,
  createActivity,
  LoginResponseDto,
  ManualJobName,
  QueueName,
  ReactionType,
} from '@immich/sdk';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Socket } from 'socket.io-client';
import {
  compareAssetGraphs,
  diffAssetRow,
  EvidenceReport,
  type FileState,
  formatFileState,
  snapshotAssetGraph,
  summarizeLogs,
} from 'src/evidence';
import { createUserDto } from 'src/fixtures';
import { makeRandomImage } from 'src/generators';
import { app, asBearerAuth, dockerExec, utils } from 'src/utils';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Missing-file self-healing — in-place, checksum-verified restore.
 *
 * Feature contract exercised here:
 *   - PUT /assets/:id/original (operation restoreAssetOriginal), multipart field `assetData`,
 *     FileUploadInterceptor only. 200 -> { id, status: 'restored' }.
 *   - Gated on the asset being offline + file-missing (never resurrects intentionally-deleted assets).
 *   - Bytes accepted only when their sha1 equals the asset's recorded checksum (400 otherwise).
 *   - Refuses when the file is present (409) and when the caller is not the owner.
 *   - Same asset id + every FK-attached row survive (no delete, no cascade).
 *
 * Each server-observable scenario emits a correlated cross-layer evidence report to
 * e2e/evidence/<scenario>.md. Scenarios that cannot be scripted in e2e (interrupted write,
 * concurrency, mount-down, old-client, phone) are left as documented `it.todo` markers.
 *
 * NOTE: these specs are authored against the merged feature image; they may not execute in the
 * e2e worktree (which has no server build). Assertions use the raw HTTP surface + SQL + dockerExec
 * so they do not depend on a regenerated SDK for the new endpoint.
 */

const RESTORE_FILENAME = 'restore.png';

const sha1Hex = (bytes: Buffer) => createHash('sha1').update(bytes).digest('hex');

// --- in-container file inspection (source of truth for the on-disk layer) --------------------

const fileExists = async (path: string): Promise<boolean> => {
  const { stdout } = await dockerExec([`test -f '${path}' && echo __EXISTS__ || echo __MISSING__`]).promise;
  return stdout.includes('__EXISTS__');
};

const fileSha1Hex = async (path: string): Promise<string | null> => {
  const { stdout } = await dockerExec([`sha1sum '${path}' 2>/dev/null | cut -d' ' -f1`]).promise;
  const hash = stdout.trim();
  return hash.length === 40 ? hash : null;
};

const captureFileState = async (path: string): Promise<FileState> => {
  const present = await fileExists(path);
  return { path, present, sha1: present ? await fileSha1Hex(path) : null };
};

const putBytesInContainer = async (bytes: Buffer, dest: string) => {
  const dir = await mkdtemp(join(tmpdir(), 'mfr-'));
  const fn = join(dir, 'file');
  writeFileSync(fn, bytes);
  await utils.putFile(fn, dest);
};

// --- HTTP helpers ----------------------------------------------------------------------------

/** PUT /assets/:id/original — the restore endpoint (multipart, FileUploadInterceptor only). */
const restore = (token: string, id: string, bytes: Buffer, correlationId?: string) => {
  const req = request(app)
    .put(`/assets/${id}/original`)
    .set('Authorization', `Bearer ${token}`)
    .attach('assetData', bytes, RESTORE_FILENAME);
  if (correlationId) {
    void req.set('X-Correlation-ID', correlationId);
  }
  return req;
};

describe('/assets/:id/original (missing-file self-healing)', () => {
  let admin: LoginResponseDto;
  let user2: LoginResponseDto;
  let ws: Socket;
  let db: Awaited<ReturnType<typeof utils.connectDatabase>>;

  /** Count of open missing-file integrity reports for an asset. */
  const missingReportCount = async (assetId: string): Promise<number> => {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM integrity_report WHERE "assetId" = $1 AND type = 'missing_file'`,
      [assetId],
    );
    return rows[0].n as number;
  };

  /**
   * Upload an asset, let it fully process (metadata + thumbnails), delete only its original file on
   * disk, then run the integrity missing-files scan so the server flips it offline and opens a
   * report. Returns the asset, its exact bytes, and its in-container original path.
   */
  const bringOffline = async (
    ownerToken: string,
  ): Promise<{ asset: AssetMediaResponseDto; bytes: Buffer; originalPath: string }> => {
    const bytes = makeRandomImage();
    const asset = await utils.createAsset(ownerToken, { assetData: { bytes, filename: RESTORE_FILENAME } });

    await utils.waitForQueueFinish(admin.accessToken, QueueName.MetadataExtraction);
    await utils.waitForQueueFinish(admin.accessToken, QueueName.ThumbnailGeneration);

    const info = await utils.getAssetInfo(ownerToken, asset.id);
    const originalPath = info.originalPath;

    await utils.deleteFile(originalPath);

    await utils.createJob(admin.accessToken, { name: ManualJobName.IntegrityMissingFiles });
    await utils.waitForQueueFinish(admin.accessToken, QueueName.IntegrityCheck);

    return { asset, bytes, originalPath };
  };

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    user2 = await utils.userSetup(admin.accessToken, createUserDto.user2);
    ws = await utils.connectWebsocket(admin.accessToken);
    db = await utils.connectDatabase();
  });

  afterAll(() => {
    utils.disconnectWebsocket(ws);
  });

  // ============================ (1) happy path — same id ============================
  it('restores a missing original in place, on the same asset id', async () => {
    const cid = `mfr-happy-${randomUUID()}`;
    const { asset, bytes, originalPath } = await bringOffline(admin.accessToken);
    const ev = new EvidenceReport('01-happy-path', {
      title: 'Happy path — in-place restore keeps the same asset id',
      description: 'Upload → delete original → integrity marks offline → PUT /assets/:id/original → online again.',
      assetId: asset.id,
      correlationId: cid,
    });

    try {
      const offlineInfo = await utils.getAssetInfo(admin.accessToken, asset.id);
      const missingBefore = await captureFileState(originalPath);
      const reportsBefore = await missingReportCount(asset.id);
      ev.assert('scan set asset offline + opened report', offlineInfo.isOffline && reportsBefore === 1, {
        fileState: formatFileState(missingBefore),
        dbDiff: `isOffline=${offlineInfo.isOffline}, missing_file reports=${reportsBefore}`,
        serverLog: summarizeLogs(await utils.captureServerLogs({ assetId: asset.id })),
      });

      const res = await restore(admin.accessToken, asset.id, bytes, cid);
      const restoredInfo = await utils.getAssetInfo(admin.accessToken, asset.id);
      const restoredFile = await captureFileState(originalPath);
      const reportsAfter = await missingReportCount(asset.id);
      const { rows: checksumRows } = await db.query(`SELECT encode(checksum, 'hex') AS c FROM asset WHERE id = $1`, [
        asset.id,
      ]);
      const recordedChecksum = checksumRows[0].c as string;

      ev.assert('PUT /assets/:id/original -> 200 { id, status: restored }', res.status === 200, {
        serverLog: summarizeLogs(await utils.captureServerLogs({ correlationId: cid })),
        dbDiff: `status=${res.status}, body=${JSON.stringify(res.body)}`,
      });
      ev.assert('same asset id returned', res.body?.id === asset.id, { dbDiff: `id=${res.body?.id}` });
      ev.assert('restore status flag = restored', res.body?.status === 'restored');
      ev.assert('asset back online', !restoredInfo.isOffline, {
        dbDiff: `isOffline=${restoredInfo.isOffline}`,
      });
      ev.assert('missing-file report cleared', reportsAfter === 0, { dbDiff: `missing_file reports=${reportsAfter}` });
      ev.assert(
        'restored bytes match recorded checksum',
        restoredFile.present && restoredFile.sha1 === recordedChecksum && restoredFile.sha1 === sha1Hex(bytes),
        { fileState: formatFileState(restoredFile), dbDiff: `db checksum=${recordedChecksum}` },
      );

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: asset.id, status: 'restored' });
      expect(restoredInfo.isOffline).toBe(false);
      expect(reportsAfter).toBe(0);
      expect(restoredFile.present).toBe(true);
      expect(restoredFile.sha1).toBe(recordedChecksum);
    } finally {
      ev.write();
    }
  });

  // ============================ (2) NO-DATA-LOSS proof (headline) ============================
  it('preserves every FK-attached row and the timeline through a restore', async () => {
    const cid = `mfr-nodataloss-${randomUUID()}`;
    const bytes = makeRandomImage();
    const asset = await utils.createAsset(admin.accessToken, { assetData: { bytes, filename: RESTORE_FILENAME } });
    await utils.waitForQueueFinish(admin.accessToken, QueueName.MetadataExtraction);
    await utils.waitForQueueFinish(admin.accessToken, QueueName.ThumbnailGeneration);

    const ev = new EvidenceReport('02-no-data-loss', {
      title: 'No-data-loss proof — same-row restore keeps all attached data',
      description:
        'Attach faces, tags, album, favorite, rating, description, activity (comment + like) and a stack, ' +
        'then lose the file and restore. Every attached row must be byte-identical and id/dates unchanged.',
      assetId: asset.id,
      correlationId: cid,
    });

    try {
      // --- attach the full graph of FK data --------------------------------------------------
      const person = await utils.createPerson(admin.accessToken, { name: 'Restore Subject' });
      await utils.createFace({ assetId: asset.id, personId: person.id });

      const [tag] = await utils.upsertTags(admin.accessToken, ['restore/kept-tag']);
      await utils.tagAssets(admin.accessToken, tag.id, [asset.id]);

      const album = await utils.createAlbum(admin.accessToken, { albumName: 'Restore Album', assetIds: [asset.id] });

      await request(app)
        .put(`/assets/${asset.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ isFavorite: true, rating: 3, description: 'must survive restore' });

      await createActivity(
        { activityCreateDto: { albumId: album.id, assetId: asset.id, type: ReactionType.Comment, comment: 'keep me' } },
        { headers: asBearerAuth(admin.accessToken) },
      );
      await createActivity(
        { activityCreateDto: { albumId: album.id, assetId: asset.id, type: ReactionType.Like } },
        { headers: asBearerAuth(admin.accessToken) },
      );

      const partner = await utils.createAsset(admin.accessToken, { assetData: { filename: 'stack-partner.png' } });
      await utils.waitForQueueFinish(admin.accessToken, QueueName.ThumbnailGeneration);
      await utils.createStack(admin.accessToken, [asset.id, partner.id]);

      const before = await snapshotAssetGraph(db, asset.id);
      ev.info('attached graph snapshotted (before file loss)', {
        dbDiff: `faces=${before.faces.length}, tags=${before.tags.length}, albums=${before.albums.length}, activities=${before.activities.length}, stack=${before.stack ? 'yes' : 'no'}, exif.rating=${before.exif?.rating}`,
      });

      // --- lose the original file, integrity flips offline ----------------------------------
      const originalPath = before.asset!.originalPath as string;
      await utils.deleteFile(originalPath);
      await utils.createJob(admin.accessToken, { name: ManualJobName.IntegrityMissingFiles });
      await utils.waitForQueueFinish(admin.accessToken, QueueName.IntegrityCheck);

      const offlineInfo = await utils.getAssetInfo(admin.accessToken, asset.id);
      ev.assert('offline + report after file loss', offlineInfo.isOffline, {
        fileState: formatFileState(await captureFileState(originalPath)),
        dbDiff: `isOffline=${offlineInfo.isOffline}, reports=${await missingReportCount(asset.id)}`,
      });

      // --- restore in place ------------------------------------------------------------------
      const res = await restore(admin.accessToken, asset.id, bytes, cid);
      await utils.waitForQueueFinish(admin.accessToken, QueueName.ThumbnailGeneration);

      const after = await snapshotAssetGraph(db, asset.id);
      const comparison = compareAssetGraphs(before, after);
      const assetDiffs = diffAssetRow(before, after);
      const changedFields = assetDiffs.filter((d) => d.changed).map((d) => d.key);

      ev.assert('restore -> 200 same id', res.status === 200 && res.body?.id === asset.id, {
        serverLog: summarizeLogs(await utils.captureServerLogs({ correlationId: cid })),
        dbDiff: `status=${res.status}, id=${res.body?.id}`,
      });

      for (const [name, entry] of Object.entries(comparison.collections)) {
        ev.assert(`attached ${name} byte-identical`, entry.identical, {
          dbDiff: `before=${entry.before}, after=${entry.after}, identical=${entry.identical}`,
        });
      }

      ev.assert('no unexpected asset-row mutation', comparison.unexpectedAssetChanges.length === 0, {
        dbDiff:
          comparison.unexpectedAssetChanges.length === 0
            ? `only volatile fields changed (${changedFields.join(', ') || 'none'})`
            : `UNEXPECTED: ${comparison.unexpectedAssetChanges.map((d) => d.key).join(', ')}`,
      });

      ev.assert(
        'id + timeline dates unchanged',
        before.asset!.id === after.asset!.id &&
          before.asset!.createdAt === after.asset!.createdAt &&
          before.asset!.localDateTime === after.asset!.localDateTime &&
          before.asset!.fileCreatedAt === after.asset!.fileCreatedAt,
        {
          dbDiff: `createdAt=${after.asset!.createdAt}, localDateTime=${after.asset!.localDateTime}, fileCreatedAt=${after.asset!.fileCreatedAt}`,
        },
      );

      ev.assert('offline cleared', after.asset!.isOffline === false, {
        fileState: formatFileState(await captureFileState(originalPath)),
        dbDiff: `isOffline=${after.asset!.isOffline}`,
      });

      // hard assertions (fail the test if the headline claim breaks)
      expect(res.status).toBe(200);
      expect(comparison.attachedIdentical).toBe(true);
      expect(comparison.unexpectedAssetChanges).toEqual([]);
      expect(after.asset!.id).toBe(before.asset!.id);
      expect(after.asset!.createdAt).toBe(before.asset!.createdAt);
      expect(after.asset!.localDateTime).toBe(before.asset!.localDateTime);
      expect(after.asset!.fileCreatedAt).toBe(before.asset!.fileCreatedAt);
      expect(after.asset!.isOffline).toBe(false);
    } finally {
      ev.write();
    }
  });

  // ============================ (3) checksum mismatch -> 400 ============================
  it('rejects bytes that do not hash to the recorded checksum (400), leaving the asset offline', async () => {
    const cid = `mfr-mismatch-${randomUUID()}`;
    const { asset, originalPath } = await bringOffline(admin.accessToken);
    const ev = new EvidenceReport('03-checksum-mismatch', {
      title: 'Checksum mismatch rejected — content cannot be swapped',
      description: 'Supplying different bytes for an offline asset is rejected with 400; the file stays absent.',
      assetId: asset.id,
      correlationId: cid,
    });

    try {
      const wrongBytes = makeRandomImage(); // different bytes -> different sha1
      const res = await restore(admin.accessToken, asset.id, wrongBytes, cid);

      const info = await utils.getAssetInfo(admin.accessToken, asset.id);
      const fileAfter = await captureFileState(originalPath);
      const reports = await missingReportCount(asset.id);

      ev.assert('rejected with 400', res.status === 400, {
        serverLog: summarizeLogs(await utils.captureServerLogs({ correlationId: cid })),
        dbDiff: `status=${res.status}, body=${JSON.stringify(res.body)}`,
      });
      ev.assert('file still absent (never written)', !fileAfter.present, {
        fileState: formatFileState(fileAfter),
      });
      ev.assert('asset still offline + report intact', info.isOffline && reports === 1, {
        dbDiff: `isOffline=${info.isOffline}, reports=${reports}`,
      });

      expect(res.status).toBe(400);
      expect(fileAfter.present).toBe(false);
      expect(info.isOffline).toBe(true);
      expect(reports).toBe(1);
    } finally {
      ev.write();
    }
  });

  // ============================ (4) wrong owner -> denied ============================
  it('refuses a restore from a non-owner and makes no changes', async () => {
    const cid = `mfr-owner-${randomUUID()}`;
    const { asset, bytes, originalPath } = await bringOffline(admin.accessToken);
    const ev = new EvidenceReport('04-wrong-owner', {
      title: 'Wrong owner — cross-user restore refused',
      description:
        'User 2 attempts to restore an asset owned by admin. Immich denies cross-owner access ' +
        '(400 "Not found or no ... access" or 403); either way nothing is written and it stays offline.',
      assetId: asset.id,
      correlationId: cid,
    });

    try {
      const res = await restore(user2.accessToken, asset.id, bytes, cid);

      const info = await utils.getAssetInfo(admin.accessToken, asset.id);
      const fileAfter = await captureFileState(originalPath);
      const denied = res.status === 403 || res.status === 400;

      ev.assert('non-owner restore denied (403/400)', denied, {
        serverLog: summarizeLogs(await utils.captureServerLogs({ correlationId: cid })),
        dbDiff: `status=${res.status}, body=${JSON.stringify(res.body)}`,
      });
      ev.assert('no bytes written for non-owner', !fileAfter.present, {
        fileState: formatFileState(fileAfter),
      });
      ev.assert('asset unchanged (still offline)', info.isOffline, {
        dbDiff: `isOffline=${info.isOffline}`,
      });

      expect(denied).toBe(true);
      expect(res.status).not.toBe(200);
      expect(fileAfter.present).toBe(false);
      expect(info.isOffline).toBe(true);
    } finally {
      ev.write();
    }
  });

  // ============================ (5) file present -> 409 ============================
  it('refuses to overwrite when the original file is present (409)', async () => {
    const cid = `mfr-present-${randomUUID()}`;
    const { asset, bytes, originalPath } = await bringOffline(admin.accessToken);
    const ev = new EvidenceReport('05-file-present', {
      title: 'File-present refusal — restore never overwrites an existing file',
      description: 'The asset is offline in the DB but its file has reappeared on disk; restore is refused with 409.',
      assetId: asset.id,
      correlationId: cid,
    });

    try {
      // put the original file back on disk WITHOUT clearing the offline flag
      await putBytesInContainer(bytes, originalPath);
      const present = await captureFileState(originalPath);

      const res = await restore(admin.accessToken, asset.id, bytes, cid);
      const fileAfter = await captureFileState(originalPath);

      ev.assert('file is present before restore attempt', present.present, {
        fileState: formatFileState(present),
      });
      ev.assert('restore refused with 409', res.status === 409, {
        serverLog: summarizeLogs(await utils.captureServerLogs({ correlationId: cid })),
        dbDiff: `status=${res.status}, body=${JSON.stringify(res.body)}`,
      });
      ev.assert('existing file left byte-identical (not overwritten)', fileAfter.sha1 === sha1Hex(bytes), {
        fileState: formatFileState(fileAfter),
      });

      expect(res.status).toBe(409);
      expect(fileAfter.present).toBe(true);
      expect(fileAfter.sha1).toBe(sha1Hex(bytes));
    } finally {
      ev.write();
    }
  });

  // ============================ (9) idempotency ============================
  it('is idempotent — a second restore is a no-op with no duplicate rows', async () => {
    const cid = `mfr-idempotent-${randomUUID()}`;
    const { asset, bytes, originalPath } = await bringOffline(admin.accessToken);
    const ev = new EvidenceReport('09-idempotency', {
      title: 'Idempotency — second restore creates no duplicates',
      description:
        'After a successful restore the file is present again, so a second restore is refused; crucially it ' +
        'produces no duplicate asset_file / asset_face rows and no second asset.',
      assetId: asset.id,
      correlationId: cid,
    });

    try {
      const first = await restore(admin.accessToken, asset.id, bytes, cid);
      await utils.waitForQueueFinish(admin.accessToken, QueueName.ThumbnailGeneration);
      const afterFirst = await snapshotAssetGraph(db, asset.id);

      const second = await restore(admin.accessToken, asset.id, bytes, cid);
      await utils.waitForQueueFinish(admin.accessToken, QueueName.ThumbnailGeneration);
      const afterSecond = await snapshotAssetGraph(db, asset.id);

      const { rows: assetRowCount } = await db.query(`SELECT count(*)::int AS n FROM asset WHERE id = $1`, [asset.id]);
      const assetRows = assetRowCount[0].n as number;

      ev.assert('first restore succeeded (200)', first.status === 200, {
        dbDiff: `status=${first.status}`,
        fileState: formatFileState(await captureFileState(originalPath)),
      });
      ev.assert('second restore is a no-op (not 200)', second.status !== 200, {
        serverLog: summarizeLogs(await utils.captureServerLogs({ correlationId: cid })),
        dbDiff: `status=${second.status}, body=${JSON.stringify(second.body)}`,
      });
      ev.assert(
        'no duplicate asset_file rows',
        afterSecond.files.length === afterFirst.files.length && afterFirst.files.length > 0,
        { dbDiff: `asset_file: first=${afterFirst.files.length}, second=${afterSecond.files.length}` },
      );
      ev.assert('no duplicate asset_face rows', afterSecond.faces.length === afterFirst.faces.length, {
        dbDiff: `asset_face: first=${afterFirst.faces.length}, second=${afterSecond.faces.length}`,
      });
      ev.assert('still exactly one asset row for this id', assetRows === 1, { dbDiff: `asset rows=${assetRows}` });

      expect(first.status).toBe(200);
      expect(second.status).not.toBe(200);
      expect(afterSecond.files.length).toBe(afterFirst.files.length);
      expect(afterSecond.faces.length).toBe(afterFirst.faces.length);
      expect(assetRows).toBe(1);
    } finally {
      ev.write();
    }
  });

  // ============================ (11) intentional-delete guardrail (#23897) ============================
  it('never flips a trashed asset offline and refuses to restore it', async () => {
    const cid = `mfr-guardrail-${randomUUID()}`;
    const bytes = makeRandomImage();
    const asset = await utils.createAsset(admin.accessToken, { assetData: { bytes, filename: RESTORE_FILENAME } });
    await utils.waitForQueueFinish(admin.accessToken, QueueName.MetadataExtraction);
    await utils.waitForQueueFinish(admin.accessToken, QueueName.ThumbnailGeneration);

    const ev = new EvidenceReport('11-intentional-delete-guardrail', {
      title: 'Intentional-delete guardrail — trashed assets never self-heal',
      description:
        'A trashed asset whose file is gone must NOT be marked offline (integrity skips deletedAt IS NOT NULL), ' +
        'and a restore must be refused, so we can never resurrect an intentionally-deleted asset.',
      assetId: asset.id,
      correlationId: cid,
    });

    try {
      const info = await utils.getAssetInfo(admin.accessToken, asset.id);
      const originalPath = info.originalPath;

      // trash the asset (intentional delete) then remove its file, then scan
      await utils.deleteAssets(admin.accessToken, [asset.id]);
      await utils.deleteFile(originalPath);
      await utils.createJob(admin.accessToken, { name: ManualJobName.IntegrityMissingFiles });
      await utils.waitForQueueFinish(admin.accessToken, QueueName.IntegrityCheck);

      const trashed = await utils.getAssetInfo(admin.accessToken, asset.id);
      const reports = await missingReportCount(asset.id);

      ev.assert('trashed asset not scanned -> not offline, no report', !trashed.isOffline && reports === 0, {
        fileState: formatFileState(await captureFileState(originalPath)),
        dbDiff: `isTrashed=${trashed.isTrashed}, isOffline=${trashed.isOffline}, reports=${reports}`,
      });

      const res = await restore(admin.accessToken, asset.id, bytes, cid);
      ev.assert('restore of intentionally-deleted asset refused (not 200)', res.status !== 200, {
        serverLog: summarizeLogs(await utils.captureServerLogs({ correlationId: cid })),
        dbDiff: `status=${res.status}, body=${JSON.stringify(res.body)}`,
      });
      const fileAfter = await captureFileState(originalPath);
      ev.assert('file remains absent', !fileAfter.present, {
        fileState: formatFileState(fileAfter),
      });

      expect(trashed.isTrashed).toBe(true);
      expect(trashed.isOffline).toBe(false);
      expect(reports).toBe(0);
      expect(res.status).not.toBe(200);
    } finally {
      ev.write();
    }
  });

  // ============================ (13) timeline / date stability ============================
  it('leaves id, createdAt, localDateTime and fileCreatedAt unchanged (unlike delete+reupload)', async () => {
    const cid = `mfr-timeline-${randomUUID()}`;
    const { asset, bytes } = await bringOffline(admin.accessToken);
    const ev = new EvidenceReport('13-timeline-date-stability', {
      title: 'Timeline / date stability — same-row restore preserves position',
      description: 'Delete+reupload would reset id and dates; same-row restore leaves them all intact.',
      assetId: asset.id,
      correlationId: cid,
    });

    try {
      const before = await snapshotAssetGraph(db, asset.id);
      const res = await restore(admin.accessToken, asset.id, bytes, cid);
      const after = await snapshotAssetGraph(db, asset.id);

      const stable =
        after.asset!.id === before.asset!.id &&
        after.asset!.createdAt === before.asset!.createdAt &&
        after.asset!.localDateTime === before.asset!.localDateTime &&
        after.asset!.fileCreatedAt === before.asset!.fileCreatedAt;

      ev.assert('restore succeeded', res.status === 200, {
        serverLog: summarizeLogs(await utils.captureServerLogs({ correlationId: cid })),
        dbDiff: `status=${res.status}`,
      });
      ev.assert('id + all timeline dates unchanged', stable, {
        dbDiff:
          `id ${before.asset!.id === after.asset!.id ? '=' : '≠'}, ` +
          `createdAt ${before.asset!.createdAt === after.asset!.createdAt ? '=' : '≠'}, ` +
          `localDateTime ${before.asset!.localDateTime === after.asset!.localDateTime ? '=' : '≠'}, ` +
          `fileCreatedAt ${before.asset!.fileCreatedAt === after.asset!.fileCreatedAt ? '=' : '≠'}`,
      });

      expect(res.status).toBe(200);
      expect(after.asset!.id).toBe(before.asset!.id);
      expect(after.asset!.createdAt).toBe(before.asset!.createdAt);
      expect(after.asset!.localDateTime).toBe(before.asset!.localDateTime);
      expect(after.asset!.fileCreatedAt).toBe(before.asset!.fileCreatedAt);
    } finally {
      ev.write();
    }
  });

  // ============================ documented TODOs (not scriptable in e2e) ============================
  // These belong to the matrix but cannot be reliably driven from the e2e harness; they are proven
  // out-of-band (interrupted/concurrent/mount-down need fault injection; old-client & phone are
  // client-side). Left as explicit markers so the matrix stays visible.
  it.todo('(6) interrupted/partial write: kill mid-move -> stays offline, no half-file accepted');
  it.todo('(7) concurrent re-supply: two clients same asset -> one wins, other no-ops safely');
  it.todo('(8) mount-down mid-restore: /data unavailable -> fails safe, stays offline, no partial state');
  it.todo('(10) old-client compat: a stock app syncing an isOffline asset ignores the field and does not crash');
  it.todo('(12) phone-safety: manage-local-media ON never trashes the local copy (proven on the Pixel via adb)');
});
