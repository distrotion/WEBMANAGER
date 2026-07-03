import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:xterm/xterm.dart';
import 'api.dart';

/// A real interactive shell on the server (admin only), rendered with xterm and
/// bridged to a node-pty process over WebSocket (/pty).
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
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.title),
        actions: [
          IconButton(tooltip: 'Reconnect', onPressed: _reconnect, icon: const Icon(Icons.refresh)),
        ],
      ),
      body: Container(
        color: const Color(0xFF0B1020),
        padding: const EdgeInsets.all(8),
        child: TerminalView(terminal, autofocus: true),
      ),
    );
  }
}
