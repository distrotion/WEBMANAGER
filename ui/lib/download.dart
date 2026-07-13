// This app targets Flutter web only; dart:html is the simplest way to save a file.
// ignore_for_file: deprecated_member_use, avoid_web_libraries_in_flutter
import 'dart:async';
import 'dart:convert';
import 'dart:html' as html;

/// Trigger a browser "save as" download of [content] as [filename] (web only).
/// Open the browser's file picker and return the chosen file's text content
/// (read locally in the browser — the file itself is never uploaded or changed).
/// Returns null if the user cancels.
Future<String?> pickTextFile({String accept = ''}) {
  final completer = Completer<String?>();
  final input = html.FileUploadInputElement()..accept = accept;
  input.onChange.listen((_) {
    final files = input.files;
    if (files == null || files.isEmpty) {
      completer.complete(null);
      return;
    }
    final reader = html.FileReader();
    reader.onLoad.listen((_) => completer.complete(reader.result as String?));
    reader.onError.listen((_) => completer.complete(null));
    reader.readAsText(files.first);
  });
  input.click();
  return completer.future;
}

void downloadText(String filename, String content) {
  final bytes = utf8.encode(content);
  final blob = html.Blob([bytes], 'text/plain');
  final url = html.Url.createObjectUrlFromBlob(blob);
  html.AnchorElement(href: url)
    ..setAttribute('download', filename)
    ..click();
  html.Url.revokeObjectUrl(url);
}
