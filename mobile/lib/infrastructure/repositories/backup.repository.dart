import 'dart:async';

import 'package:drift/drift.dart';
import 'package:immich_mobile/data/db/main/database.dart';
import 'package:immich_mobile/data/db/main/table/local/album_asset.drift.dart';
import 'package:immich_mobile/data/db/main/table/local/asset.dart';
import 'package:immich_mobile/domain/models/album/local_album.model.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/infrastructure/repositories/backup.repository.drift.dart';

@DriftAccessor()
class BackupRepository extends DatabaseAccessor<Drift> with $BackupRepositoryMixin {
  BackupRepository(super.attachedDatabase);

  Drift get _db => attachedDatabase;

  JoinedSelectStatement<$LocalAlbumAssetEntityTable, LocalAlbumAssetEntityData> _getExcludedSubquery() {
    return _db.localAlbumAssetEntity.selectOnly()
      ..addColumns([_db.localAlbumAssetEntity.assetId])
      ..join([
        innerJoin(
          _db.localAlbumEntity,
          _db.localAlbumAssetEntity.albumId.equalsExp(_db.localAlbumEntity.id),
          useColumns: false,
        ),
      ])
      ..where(_db.localAlbumEntity.backupSelection.equalsValue(BackupSelection.excluded));
  }

  /// Returns all backup-related counts in a single query.
  ///
  /// - total:     number of distinct assets in selected albums, excluding those that are also in excluded albums
  /// - backup:    number of those assets that already exist on the server for [userId]
  /// - remainder: number of those assets that do not yet exist on the server for [userId]
  ///              (includes processing)
  /// - processing: number of those assets that are still preparing/have a null checksum
  Future<({int total, int remainder, int processing})> getAllCounts(String userId) async {
    const sql = '''
        SELECT
        COUNT(*) AS total_count,
        COUNT(*) FILTER (WHERE lae.checksum IS NULL) AS processing_count,
        COUNT(*) FILTER (WHERE rae.id IS NULL) AS remainder_count
        FROM local_asset_entity lae
        LEFT JOIN main.remote_asset_entity rae
            ON lae.checksum = rae.checksum AND rae.owner_id = ?1
            AND (rae.is_offline = 0 OR rae.library_id IS NOT NULL)
        WHERE EXISTS (
            SELECT 1
            FROM local_album_asset_entity laa
            INNER JOIN main.local_album_entity la on laa.album_id = la.id
            WHERE laa.asset_id = lae.id
                AND la.backup_selection = ?2
        )
        AND NOT EXISTS (
            SELECT 1
            FROM local_album_asset_entity laa
            INNER JOIN main.local_album_entity la on laa.album_id = la.id
            WHERE laa.asset_id = lae.id
                AND la.backup_selection = ?3
        );
      ''';

    final row = await _db
        .customSelect(
          sql,
          variables: [
            Variable.withString(userId),
            Variable.withInt(BackupSelection.selected.index),
            Variable.withInt(BackupSelection.excluded.index),
          ],
          readsFrom: {_db.localAlbumAssetEntity, _db.localAlbumEntity, _db.localAssetEntity, _db.remoteAssetEntity},
        )
        .getSingle();

    final data = row.data;
    return (
      total: (data['total_count'] as int?) ?? 0,
      remainder: (data['remainder_count'] as int?) ?? 0,
      processing: (data['processing_count'] as int?) ?? 0,
    );
  }

  Future<List<LocalAsset>> getCandidates(String userId, {bool onlyHashed = true}) async {
    final selectedAlbumIds = _db.localAlbumEntity.selectOnly(distinct: true)
      ..addColumns([_db.localAlbumEntity.id])
      ..where(_db.localAlbumEntity.backupSelection.equalsValue(BackupSelection.selected));

    final lae = _db.localAssetEntity;
    // Aliased so the offline-target left join below does not collide with the online-match
    // anti-join subquery (both reference remote_asset_entity).
    final offlineRemote = _db.remoteAssetEntity.createAlias('offline_remote');

    var predicate =
        existsQuery(
          _db.localAlbumAssetEntity.selectOnly()
            ..addColumns([_db.localAlbumAssetEntity.assetId])
            ..where(
              _db.localAlbumAssetEntity.albumId.isInQuery(selectedAlbumIds) &
                  _db.localAlbumAssetEntity.assetId.equalsExp(lae.id),
            ),
        ) &
        // Exclude only checksums the server currently holds ONLINE. An offline (file-missing)
        // upload asset no longer counts as present, so its matching local copy re-qualifies as a
        // backup candidate and is healed in place (see the left join below) instead of being
        // excluded forever by the per-owner (ownerId, checksum) uniqueness index.
        notExistsQuery(
          _db.remoteAssetEntity.selectOnly()
            ..addColumns([_db.remoteAssetEntity.checksum])
            ..where(
              _db.remoteAssetEntity.checksum.equalsExp(lae.checksum) &
                  _db.remoteAssetEntity.ownerId.equals(userId) &
                  // A row still "counts as present" unless it is an offline UPLOAD asset
                  // (libraryId IS NULL). Offline external-library assets stay excluded — the
                  // phone must never re-upload externally-managed files.
                  (_db.remoteAssetEntity.isOffline.equals(false) | _db.remoteAssetEntity.libraryId.isNotNull()),
            ),
        ) &
        lae.id.isNotInQuery(_getExcludedSubquery());

    if (onlyHashed) {
      predicate = predicate & lae.checksum.isNotNull();
    }

    final query = _db.select(lae).join([
      leftOuterJoin(
        offlineRemote,
        offlineRemote.checksum.equalsExp(lae.checksum) &
            offlineRemote.ownerId.equals(userId) &
            offlineRemote.isOffline.equals(true) &
            offlineRemote.libraryId.isNull(),
      ),
    ])
      ..where(predicate)
      ..orderBy([OrderingTerm.desc(lae.createdAt)]);

    final rows = await query.get();
    // A non-null joined id is the offline asset to heal in place (upload targets
    // PUT /assets/:id/original); a null id is a fresh candidate that uploads via POST /assets.
    return rows.map((row) => row.readTable(lae).toDto(remoteId: row.readTableOrNull(offlineRemote)?.id)).toList();
  }
}
