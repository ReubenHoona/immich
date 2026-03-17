import 'dart:async';
import 'dart:typed_data';
import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:logging/logging.dart';

final _log = Logger("ImageConverter");

/// Converts a Flutter [Image] widget to a [Uint8List] in PNG format.
///
/// This function resolves the image stream and converts it to byte data.
/// Returns a [Future] that completes with the image bytes or completes with an error
/// if the conversion fails.
Future<Uint8List> imageToUint8List(Image image) async {
  _log.fine("Resolving image stream from provider: ${image.image.runtimeType}");
  final Completer<Uint8List> completer = Completer();
  final stream = image.image.resolve(const ImageConfiguration());
  late ImageStreamListener listener;
  listener = ImageStreamListener(
    (ImageInfo info, bool _) {
      stream.removeListener(listener);
      _log.fine("Image stream resolved — size: ${info.image.width}x${info.image.height}, converting to PNG bytes");
      info.image.toByteData(format: ImageByteFormat.png).then((byteData) {
        if (byteData != null) {
          _log.info("PNG conversion complete — ${byteData.lengthInBytes} bytes");
          completer.complete(byteData.buffer.asUint8List());
        } else {
          _log.severe("toByteData() returned null");
          completer.completeError('Failed to convert image to bytes');
        }
      });
    },
    onError: (exception, stackTrace) {
      stream.removeListener(listener);
      _log.severe("Image stream error", exception, stackTrace);
      completer.completeError(exception, stackTrace);
    },
  );
  stream.addListener(listener);
  return completer.future;
}
