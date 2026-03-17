import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/entities/asset.entity.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/providers/background_sync.provider.dart';
import 'package:immich_mobile/providers/infrastructure/asset.provider.dart';
import 'package:immich_mobile/repositories/file_media.repository.dart';
import 'package:immich_mobile/routing/router.dart';
import 'package:photo_manager/photo_manager.dart' hide AssetType;
import 'package:immich_mobile/services/foreground_upload.service.dart';
import 'package:immich_mobile/services/stack.service.dart';
import 'package:immich_mobile/utils/image_converter.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:logging/logging.dart';
import 'package:path/path.dart' as p;

final _log = Logger("DriftEditImagePage");

/// A stateless widget that provides functionality for editing an image.
///
/// This widget allows users to edit an image provided either as an [Asset] or
/// directly as an [Image]. It ensures that exactly one of these is provided.
///
/// It also includes a conversion method to convert an [Image] to a [Uint8List] to save the image on the user's phone
/// They automatically navigate to the [HomePage] with the edited image saved and they eventually get backed up to the server.
@immutable
@RoutePage()
class DriftEditImagePage extends ConsumerWidget {
  final BaseAsset asset;
  final Image image;
  final bool isEdited;

  const DriftEditImagePage({super.key, required this.asset, required this.image, required this.isEdited});

  void _exitEditing(BuildContext context) {
    _log.info("Exiting editing, popping back to asset viewer then closing it");
    // Pop all editing pages (DriftEditImageRoute, DriftCropImageRoute) back to AssetViewerRoute,
    // then pop the viewer itself to land on the timeline. MainTimelineRoute is a nested tab
    // route and won't appear in the top-level navigator stack, so we can't popUntil it directly.
    context.navigator.popUntil(
      (route) => route.data?.name == AssetViewerRoute.name || route.isFirst,
    );
    if (context.navigator.canPop()) {
      context.navigator.pop();
    }
  }

  Future<String?> _getRelativePath(BaseAsset asset) async {
    String? localId;
    if (asset is LocalAsset) {
      localId = asset.id;
    } else if (asset is RemoteAsset && asset.localId != null) {
      localId = asset.localId;
    }
    if (localId == null) return null;
    final entity = await AssetEntity.fromId(localId);
    _log.fine("Original asset relative path: ${entity?.relativePath}");
    return entity?.relativePath;
  }

  Future<void> _saveEditedImage(BuildContext context, BaseAsset asset, Image image, WidgetRef ref) async {
    final title = "${p.withoutExtension(asset.name)}_edited.png";
    _log.info("Starting save of edited image: $title (asset: ${asset.name})");
    try {
      _log.fine("Converting Image widget to PNG bytes");
      final Uint8List imageData = await imageToUint8List(image);
      _log.info("Converted image to ${imageData.lengthInBytes} bytes");

      final relativePath = await _getRelativePath(asset);
      _log.fine("Saving to: ${relativePath ?? 'default (Pictures/)'}");

      LocalAsset? localAsset;
      try {
        localAsset = await ref
            .read(fileMediaRepositoryProvider)
            .saveLocalAsset(imageData, title: title, relativePath: relativePath, createdAt: asset.createdAt);
        _log.info("Saved to gallery — localAsset id: ${localAsset?.id}, name: ${localAsset?.name}");
      } on PlatformException catch (e) {
        // OS might not return the saved image back, so we handle that gracefully
        // This can happen if app does not have full library access
        _log.warning("OS did not return saved asset back (PlatformException) — file may still be saved", e);
      }

      _log.fine("Syncing local assets");
      await ref.read(backgroundSyncProvider).syncLocal(full: true);

      if (localAsset != null) {
        _log.fine("Marking asset ${localAsset.id} as edited in DB");
        await ref.read(localAssetRepository).updateIsEdited(localAsset.id, createdAt: asset.createdAt);
      }

      ImmichToast.show(durationInSecond: 3, context: context, msg: 'image_saved_as_new_copy'.tr());
      _exitEditing(context);

      if (localAsset == null) {
        _log.warning("localAsset is null — skipping upload");
        return;
      }

      final originalRemoteId = switch (asset) {
        RemoteAsset a => a.id,
        LocalAsset a => a.remoteId,
        _ => null,
      };

      _log.info("Uploading new asset to server: ${localAsset.id}");
      await ref.read(foregroundUploadServiceProvider).uploadManual(
        [localAsset],
        callbacks: UploadCallbacks(
          onSuccess: (_, editedRemoteId) async {
            if (originalRemoteId == null) {
              _log.info("Original has no remote ID — skipping stack creation");
              return;
            }
            _log.info("Creating stack: original=$originalRemoteId, edited=$editedRemoteId");
            final stack = await ref
                .read(stackServiceProvider)
                .createStack([originalRemoteId, editedRemoteId]);
            if (stack != null) {
              await ref.read(stackServiceProvider).updateStack(stack.id, editedRemoteId);
              _log.info("Stack created: ${stack.id}, primary=$editedRemoteId");
            }
          },
        ),
      );
      _log.info("Upload complete for: ${localAsset.id}");
    } catch (e, stack) {
      _log.severe("Failed to save edited image: $title", e, stack);
      ImmichToast.show(
        durationInSecond: 6,
        context: context,
        msg: "error_saving_image".tr(namedArgs: {'error': e.toString()}),
      );
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      appBar: AppBar(
        title: Text("edit".tr()),
        backgroundColor: context.scaffoldBackgroundColor,
        leading: IconButton(
          icon: Icon(Icons.close_rounded, color: context.primaryColor, size: 24),
          onPressed: () => _exitEditing(context),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: isEdited ? () => _saveEditedImage(context, asset, image, ref) : null,
            child: Text("save_to_gallery".tr(), style: TextStyle(color: isEdited ? context.primaryColor : Colors.grey)),
          ),
        ],
      ),
      backgroundColor: context.scaffoldBackgroundColor,
      body: Center(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: context.height * 0.7, maxWidth: context.width * 0.9),
          child: Container(
            decoration: BoxDecoration(
              borderRadius: const BorderRadius.all(Radius.circular(7)),
              boxShadow: [
                BoxShadow(
                  color: Colors.black.withValues(alpha: 0.2),
                  spreadRadius: 2,
                  blurRadius: 10,
                  offset: const Offset(0, 3),
                ),
              ],
            ),
            child: ClipRRect(
              borderRadius: const BorderRadius.all(Radius.circular(7)),
              child: Image(image: image.image, fit: BoxFit.contain),
            ),
          ),
        ),
      ),
      bottomNavigationBar: Container(
        height: 70,
        margin: const EdgeInsets.only(bottom: 60, right: 10, left: 10, top: 10),
        decoration: BoxDecoration(
          color: context.scaffoldBackgroundColor,
          borderRadius: const BorderRadius.all(Radius.circular(30)),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceEvenly,
          children: <Widget>[
            Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: <Widget>[
                IconButton(
                  icon: Icon(Icons.crop_rotate_rounded, color: context.themeData.iconTheme.color, size: 25),
                  onPressed: () {
                    context.pushRoute(DriftCropImageRoute(asset: asset, image: image));
                  },
                ),
                Text("crop".tr(), style: context.textTheme.displayMedium),
              ],
            ),
            Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: <Widget>[
                IconButton(
                  icon: Icon(Icons.filter, color: context.themeData.iconTheme.color, size: 25),
                  onPressed: () {
                    context.pushRoute(DriftFilterImageRoute(asset: asset, image: image));
                  },
                ),
                Text("filter".tr(), style: context.textTheme.displayMedium),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
