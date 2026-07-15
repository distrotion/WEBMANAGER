import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:xterm/xterm.dart';
import 'api.dart';

/// A real interactive shell on the server (admin only), rendered with xterm and
/// bridged to a node-pty process over WebSocket (/pty).
///
/// Copy/paste: drag to select then Copy (or Cmd/Ctrl+Shift+C); Paste button,
/// right-click, or Cmd/Ctrl+Shift+V. Ctrl+C stays SIGINT (unaffected).
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

  @override
  void initState() {
    super.initState();
    _connect();
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

  // Copy the current mouse selection to the clipboard.
  Future<void> _copy() async {
    final sel = _controller.selection;
    final text = sel == null ? null : terminal.buffer.getText(sel);
    if (text == null || text.isEmpty) {
      _toast('เลือกข้อความก่อน (ลากเมาส์คลุม) แล้วค่อย Copy');
      return;
    }
    await Clipboard.setData(ClipboardData(text: text));
    _controller.clearSelection();
    _toast('คัดลอกแล้ว (${text.length} ตัวอักษร)');
  }

  // Paste clipboard text into the shell (goes through onOutput → server).
  Future<void> _paste() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final text = data?.text;
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
          IconButton(tooltip: 'Paste (คลิกขวา / Cmd/Ctrl+Shift+V)', onPressed: _paste, icon: const Icon(Icons.paste)),
          IconButton(tooltip: 'Reconnect', onPressed: _reconnect, icon: const Icon(Icons.refresh)),
        ],
      ),
      body: CallbackShortcuts(
        bindings: {
          // Cmd on macOS, Ctrl+Shift on Windows/Linux (Ctrl+C alone stays SIGINT).
          const SingleActivator(LogicalKeyboardKey.keyC, meta: true): _copy,
          const SingleActivator(LogicalKeyboardKey.keyV, meta: true): _paste,
          const SingleActivator(LogicalKeyboardKey.keyC, control: true, shift: true): _copy,
          const SingleActivator(LogicalKeyboardKey.keyV, control: true, shift: true): _paste,
        },
        child: Container(
          color: const Color(0xFF0B1020),
          padding: const EdgeInsets.all(8),
          child: TerminalView(
            terminal,
            controller: _controller,
            autofocus: true,
            // right-click anywhere pastes the clipboard (classic terminal behaviour)
            onSecondaryTapDown: (_, __) => _paste(),
          ),
        ),
      ),
    );
  }
}
