import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:xterm/xterm.dart';
import 'api.dart';
import 'web_clipboard.dart';

/// A real interactive shell on the server (admin only), rendered with xterm and
/// bridged to a node-pty process over WebSocket (/pty).
///
/// Copy/paste works even over plain http://<ip> (insecure origin), where the
/// async Clipboard API is blocked: Copy uses execCommand, Paste uses the native
/// browser paste event (Cmd/Ctrl+V or right-click Paste) plus a dialog fallback.
class ShellConsolePage extends StatefulWidget {
  final String? cwd;
  final String? site;
  final String title;
  const ShellConsolePage({super.key, this.cwd, this.site, this.title = 'Server console'});

  @override
  State<ShellConsolePage> createState() => _ShellConsolePageState();
}

class _ShellConsolePageState extends State<ShellConsolePage> {
  final terminal = Terminal(maxLines: 10000);
  final _controller = TerminalController();
  WebSocketChannel? _ch;
  bool _closed = false;
  void Function()? _pasteDisposer;

  @override
  void initState() {
    super.initState();
    _connect();
    // Native browser paste (Cmd/Ctrl+V, right-click Paste) → shell. Works on http.
    _pasteDisposer = onWebPaste((text) => terminal.paste(text));
  }

  void _connect() {
    final ch = Api.instance.ptySocket(cwd: widget.cwd, site: widget.site);
    _ch = ch;

    // user keystrokes → server
    terminal.onOutput = (data) => _send({'type': 'input', 'data': data});
    terminal.onResize = (w, h, pw, ph) => _send({'type': 'resize', 'cols': w, 'rows': h});

    // server output → terminal
    ch.stream.listen(
      (event) => terminal.write(event is String ? event : utf8.decode(event as List<int>)),
      onDone: () {
        if (!_closed) terminal.write('\r\n\x1b[31m[disconnected]\x1b[0m\r\n');
      },
      onError: (e) => terminal.write('\r\n\x1b[31m[error] $e\x1b[0m\r\n'),
    );
  }

  void _send(Map<String, dynamic> m) {
    try {
      _ch?.sink.add(jsonEncode(m));
    } catch (_) {}
  }

  // Copy the current mouse selection to the clipboard (execCommand — http-safe).
  void _copy() {
    final sel = _controller.selection;
    final text = sel == null ? null : terminal.buffer.getText(sel);
    if (text == null || text.isEmpty) {
      _toast('เลือกข้อความก่อน (ลากเมาส์คลุม) แล้วค่อย Copy');
      return;
    }
    final ok = webCopy(text);
    _controller.clearSelection();
    _toast(ok ? 'คัดลอกแล้ว (${text.length} ตัวอักษร)' : 'คัดลอกไม่สำเร็จ');
  }

  // Fallback paste that always works on http: user pastes into a text field
  // (native paste into an input is allowed), then it's sent to the shell.
  Future<void> _pasteDialog() async {
    final ctrl = TextEditingController();
    final text = await showDialog<String>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Paste'),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          minLines: 1,
          maxLines: 8,
          decoration: const InputDecoration(
            border: OutlineInputBorder(),
            hintText: 'กด Cmd+V (⌘V) หรือคลิกขวา → Paste ที่นี่ แล้วกด Send',
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, ctrl.text), child: const Text('Send')),
        ],
      ),
    );
    if (text != null && text.isNotEmpty) terminal.paste(text);
  }

  void _toast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), duration: const Duration(milliseconds: 900)),
    );
  }

  void _reconnect() {
    _closed = true;
    _ch?.sink.close();
    terminal.write('\r\n\x1b[33m[reconnecting…]\x1b[0m\r\n');
    _closed = false;
    _connect();
  }

  @override
  void dispose() {
    _closed = true;
    _pasteDisposer?.call();
    _ch?.sink.close();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.title),
        actions: [
          IconButton(tooltip: 'Copy selection (Cmd/Ctrl+Shift+C)', onPressed: _copy, icon: const Icon(Icons.copy)),
          IconButton(tooltip: 'Paste (หรือกด Cmd/Ctrl+V ในหน้าจอ)', onPressed: _pasteDialog, icon: const Icon(Icons.paste)),
          IconButton(tooltip: 'Reconnect', onPressed: _reconnect, icon: const Icon(Icons.refresh)),
        ],
      ),
      body: CallbackShortcuts(
        bindings: {
          // Copy: Cmd+C (mac) / Ctrl+Shift+C (win/linux). Paste is handled by the
          // native browser paste event (onWebPaste), so V is intentionally NOT
          // bound here — binding it would swallow the native paste.
          const SingleActivator(LogicalKeyboardKey.keyC, meta: true): _copy,
          const SingleActivator(LogicalKeyboardKey.keyC, control: true, shift: true): _copy,
        },
        child: Container(
          color: const Color(0xFF0B1020),
          padding: const EdgeInsets.all(8),
          child: TerminalView(
            terminal,
            controller: _controller,
            autofocus: true,
          ),
        ),
      ),
    );
  }
}
