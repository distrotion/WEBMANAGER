import 'dart:convert';
import 'package:flutter/material.dart';
import 'api.dart';

/// Terminal-style panel that subscribes to a log channel over WebSocket and
/// renders streamed command output. Gives the "open console" feel without a shell.
class LogConsole extends StatefulWidget {
  final String channel;
  const LogConsole({super.key, required this.channel});

  @override
  State<LogConsole> createState() => _LogConsoleState();
}

class _LogConsoleState extends State<LogConsole> {
  final _lines = <String>[];
  final _scroll = ScrollController();
  dynamic _sub;

  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    // load persisted history first, then stream live
    final hist = await Api.instance.logHistory(widget.channel, limit: 500);
    if (mounted && hist.isNotEmpty) {
      setState(() {
        _lines.addAll(hist);
        _lines.add('--- live ---');
      });
    }
    _connect();
  }

  void _connect() {
    final ch = Api.instance.logSocket(widget.channel);
    _sub = ch.stream.listen((event) {
      try {
        final m = jsonDecode(event as String);
        _push(m['line']?.toString() ?? '');
      } catch (_) {
        _push(event.toString());
      }
    }, onError: (e) => _push('[ws error] $e'), onDone: () => _push('[disconnected]'));
  }

  void _push(String line) {
    if (!mounted) return;
    setState(() {
      _lines.add(line);
      if (_lines.length > 1000) _lines.removeRange(0, _lines.length - 1000);
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.jumpTo(_scroll.position.maxScrollExtent);
      }
    });
  }

  @override
  void dispose() {
    try {
      _sub?.cancel();
    } catch (_) {}
    _scroll.dispose();
    super.dispose();
  }

  Color _colorFor(String l) {
    if (l.startsWith('\$')) return const Color(0xFF7DD3FC);
    if (l.contains('[error]') || l.contains('[fatal]') || l.contains('failed')) {
      return const Color(0xFFFCA5A5);
    }
    if (l.startsWith('===') || l.contains('Done')) return const Color(0xFF86EFAC);
    return const Color(0xFFD1D5DB);
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: const Color(0xFF0B1020),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: const Color(0xFF1F2937)),
      ),
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.terminal, size: 16, color: Color(0xFF9CA3AF)),
              const SizedBox(width: 6),
              Text('console · ${widget.channel}',
                  style: const TextStyle(color: Color(0xFF9CA3AF), fontSize: 12)),
              const Spacer(),
              IconButton(
                tooltip: 'Clear (also deletes stored history)',
                icon: const Icon(Icons.clear_all, size: 16, color: Color(0xFF9CA3AF)),
                onPressed: () {
                  setState(_lines.clear);
                  Api.instance.clearLogHistory(widget.channel);
                },
              ),
            ],
          ),
          const Divider(height: 8, color: Color(0xFF1F2937)),
          Expanded(
            child: ListView.builder(
              controller: _scroll,
              itemCount: _lines.length,
              itemBuilder: (_, i) => Text(
                _lines[i],
                style: TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 12.5,
                  height: 1.35,
                  color: _colorFor(_lines[i]),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
