// Clipboard helpers that work on an INSECURE origin (plain http://<ip>), where
// the async Clipboard API (navigator.clipboard) is blocked by the browser.
// Web-only app (dart:html is already used elsewhere).
// ignore_for_file: deprecated_member_use, avoid_web_libraries_in_flutter
import 'dart:html' as html;

/// Copy [text] using the legacy execCommand path (works over http within a user
/// gesture — a button tap or key handler). Returns true if the command reported
/// success.
bool webCopy(String text) {
  final ta = html.TextAreaElement()
    ..value = text
    ..setAttribute('readonly', '')
    ..style.position = 'fixed'
    ..style.top = '-1000px'
    ..style.opacity = '0';
  html.document.body!.append(ta);
  ta.focus();
  ta.select();
  var ok = false;
  try {
    ok = html.document.execCommand('copy');
  } catch (_) {
    ok = false;
  }
  ta.remove();
  return ok;
}

/// Listen for the browser's native paste event (fires on Cmd/Ctrl+V and the
/// right-click Paste menu). This reads clipboardData from the event itself, so
/// it works on http without any permission prompt. Returns a disposer.
void Function() onWebPaste(void Function(String) cb) {
  void handler(html.Event e) {
    final ce = e as html.ClipboardEvent;
    final t = ce.clipboardData?.getData('text');
    if (t != null && t.isNotEmpty) {
      e.preventDefault();
      cb(t);
    }
  }

  html.document.addEventListener('paste', handler);
  return () => html.document.removeEventListener('paste', handler);
}
