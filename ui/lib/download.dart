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

/// Open the browser's file picker (multi-select) and read each chosen file's
/// raw bytes locally. Returns an empty list if the user cancels.
Future<List<({String name, List<int> bytes})>> pickFilesBytes() {
  final completer = Completer<List<({String name, List<int> bytes})>>();
  final input = html.FileUploadInputElement()..multiple = true;
  input.onChange.listen((_) async {
    final files = input.files;
    if (files == null || files.isEmpty) {
      completer.complete(const []);
      return;
    }
    final out = <({String name, List<int> bytes})>[];
    for (final f in files) {
      final reader = html.FileReader();
      final done = Completer<void>();
      reader.onLoad.listen((_) => done.complete());
      reader.onError.listen((_) => done.complete());
      reader.readAsArrayBuffer(f);
      await done.future;
      final r = reader.result;
      if (r is List<int>) out.add((name: f.name, bytes: r));
    }
    completer.complete(out);
  });
  input.click();
  return completer.future;
}

/// Trigger a browser "save as" of raw [bytes] (e.g. a file fetched with an auth
/// header, which a plain <a download> link can't send).
void downloadBytes(String filename, List<int> bytes) {
  final blob = html.Blob([bytes]);
  final url = html.Url.createObjectUrlFromBlob(blob);
  html.AnchorElement(href: url)
    ..setAttribute('download', filename)
    ..click();
  html.Url.revokeObjectUrl(url);
}
