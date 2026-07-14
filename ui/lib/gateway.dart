import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'api.dart';

/// Remote Gateway: raw-TCP port forwarders. This server opens a listen port and
/// pipes it to a destination host:port (tunnels HTTP/WS/TLS transparently).
class GatewayPage extends StatefulWidget {
  const GatewayPage({super.key});
  @override
  State<GatewayPage> createState() => _GatewayPageState();
}

class _GatewayPageState extends State<GatewayPage> {
  List<Map<String, dynamic>> _rows = [];
  bool _loading = true;
  bool _hasToken = false;
  String? _freshToken;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _load();
    Api.instance.gatewayHasToken().then((v) {
      if (mounted) setState(() => _hasToken = v);
    });
    _timer = Timer.periodic(const Duration(seconds: 3), (_) => _load(silent: true));
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _load({bool silent = false}) async {
    try {
      final r = await Api.instance.gateways();
      if (mounted) setState(() { _rows = r; _loading = false; });
    } catch (_) {
      if (mounted && !silent) setState(() => _loading = false);
    }
  }

  Color _statusColor(String s) {
    switch (s) {
      case 'listening':
        return Colors.greenAccent;
      case 'disabled':
        return Colors.grey;
      case 'expired':
        return Colors.orangeAccent;
      default:
        return Colors.redAccent;
    }
  }

  Future<void> _edit([Map<String, dynamic>? g]) async {
    final ok = await showDialog<bool>(context: context, builder: (_) => GatewayDialog(gateway: g));
    if (ok == true) _load();
  }

  // API-token card: lets scripts on other machines drive gateways with
  // `x-api-token: <token>` (loopback needs no token).
  Widget _tokenCard() {
    return Card(
      color: Colors.white.withValues(alpha: 0.03),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            const Icon(Icons.vpn_key, size: 16),
            const SizedBox(width: 6),
            const Text('API token (สั่งจาก CLI/เครื่องอื่น)',
                style: TextStyle(fontWeight: FontWeight.bold)),
            const Spacer(),
            Text(_hasToken ? 'มี token อยู่' : 'ยังไม่มี',
                style: const TextStyle(fontSize: 11, color: Colors.white54)),
          ]),
          const SizedBox(height: 6),
          const Text('ส่ง header  x-api-token: <token>  (loopback 127.0.0.1 ไม่ต้องใช้ token)',
              style: TextStyle(fontSize: 11, color: Colors.white54)),
          if (_freshToken != null) ...[
            const SizedBox(height: 8),
            Row(children: [
              Expanded(
                  child: SelectableText(_freshToken!,
                      style: const TextStyle(fontFamily: 'monospace', fontSize: 12))),
              IconButton(
                icon: const Icon(Icons.copy, size: 16),
                onPressed: () => Clipboard.setData(ClipboardData(text: _freshToken!)),
              ),
            ]),
            const Text('copy เก็บไว้เลย — ปิดหน้าแล้วไม่โชว์ซ้ำ',
                style: TextStyle(fontSize: 11, color: Colors.orangeAccent)),
          ],
          const SizedBox(height: 8),
          Row(children: [
            FilledButton.tonalIcon(
              onPressed: () async {
                final t = await Api.instance.genGatewayToken();
                setState(() { _freshToken = t; _hasToken = true; });
              },
              icon: const Icon(Icons.key, size: 15),
              label: Text(_hasToken ? 'สร้างใหม่ (rotate)' : 'สร้าง token'),
            ),
            const SizedBox(width: 8),
            if (_hasToken)
              OutlinedButton(
                onPressed: () async {
                  await Api.instance.revokeGatewayToken();
                  setState(() { _hasToken = false; _freshToken = null; });
                },
                child: const Text('เพิกถอน'),
              ),
          ]),
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Remote Gateway · port forward'), actions: [
        IconButton(onPressed: () => _load(), icon: const Icon(Icons.refresh)),
      ]),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _edit(),
        icon: const Icon(Icons.add),
        label: const Text('New forward'),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView.separated(
                  padding: const EdgeInsets.all(12),
                  itemCount: _rows.length + 1,
                  separatorBuilder: (_, __) => const SizedBox(height: 8),
                  itemBuilder: (_, i) {
                    if (i == 0) return _tokenCard();
                    final g = _rows[i - 1];
                    final status = g['status'] as String;
                    return Card(
                      child: ListTile(
                        leading: Icon(Icons.swap_horiz, color: _statusColor(status)),
                        title: Text('${g['name']}  ·  :${g['listen_port']} → ${g['dest_host']}:${g['dest_port']}',
                            style: const TextStyle(fontWeight: FontWeight.w600)),
                        subtitle: Text([
                          'bind ${g['bind_host']}',
                          if ((g['max_conns'] ?? 0) > 0) 'max ${g['max_conns']} conns',
                          if (g['conns'] != null) '${g['conns']} active',
                          if (g['expires_at'] != null)
                            'expires ${DateTime.fromMillisecondsSinceEpoch(g['expires_at']).toString().substring(0, 16)}',
                        ].join(' · '), style: const TextStyle(fontSize: 12)),
                        trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                          Chip(
                            label: Text(status, style: const TextStyle(fontSize: 11)),
                            backgroundColor: _statusColor(status).withValues(alpha: 0.15),
                            side: BorderSide(color: _statusColor(status)),
                          ),
                          Switch(
                            value: g['enabled'] == true,
                            onChanged: (v) async {
                              await Api.instance.updateGateway(g['id'], {'enabled': v});
                              _load();
                            },
                          ),
                          IconButton(
                            icon: const Icon(Icons.edit, size: 18),
                            onPressed: () => _edit(g),
                          ),
                          IconButton(
                            icon: const Icon(Icons.delete, size: 18, color: Colors.redAccent),
                            onPressed: () async {
                              await Api.instance.deleteGateway(g['id']);
                              _load();
                            },
                          ),
                        ]),
                      ),
                    );
                  },
                ),
    );
  }
}

class GatewayDialog extends StatefulWidget {
  final Map<String, dynamic>? gateway;
  const GatewayDialog({super.key, this.gateway});
  @override
  State<GatewayDialog> createState() => _GatewayDialogState();
}

class _GatewayDialogState extends State<GatewayDialog> {
  final _name = TextEditingController();
  final _listen = TextEditingController();
  final _host = TextEditingController();
  final _dport = TextEditingController();
  final _bind = TextEditingController(text: '0.0.0.0');
  final _max = TextEditingController();
  int? _expiresHours;
  String? _error;
  bool _busy = false;

  bool get _editing => widget.gateway != null;

  @override
  void initState() {
    super.initState();
    final g = widget.gateway;
    if (g != null) {
      _name.text = g['name'] ?? '';
      _listen.text = '${g['listen_port']}';
      _host.text = g['dest_host'] ?? '';
      _dport.text = '${g['dest_port']}';
      _bind.text = g['bind_host'] ?? '0.0.0.0';
      _max.text = (g['max_conns'] ?? 0) == 0 ? '' : '${g['max_conns']}';
    }
  }

  Future<void> _save() async {
    setState(() { _busy = true; _error = null; });
    try {
      final body = {
        'name': _name.text.trim(),
        'listen_port': int.tryParse(_listen.text.trim()),
        'dest_host': _host.text.trim(),
        'dest_port': int.tryParse(_dport.text.trim()),
        'bind_host': _bind.text.trim().isEmpty ? '0.0.0.0' : _bind.text.trim(),
        'max_conns': int.tryParse(_max.text.trim()) ?? 0,
        if (_expiresHours != null)
          'expires_at': DateTime.now().add(Duration(hours: _expiresHours!)).millisecondsSinceEpoch,
      };
      if (_editing) {
        await Api.instance.updateGateway(widget.gateway!['id'], body);
      } else {
        await Api.instance.createGateway(body);
      }
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(_editing ? 'แก้ไข forward' : 'New port forward'),
      content: SizedBox(
        width: 420,
        child: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            TextField(controller: _name, decoration: const InputDecoration(labelText: 'ชื่อ')),
            TextField(
              controller: _listen,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(
                  labelText: 'Listen port (เปิดบนเครื่องนี้)', hintText: 'เช่น 8080, 9022'),
            ),
            const Divider(height: 24),
            TextField(controller: _host, decoration: const InputDecoration(labelText: 'Dest host (ปลายทาง)', hintText: '172.23.10.50')),
            TextField(
              controller: _dport,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Dest port', hintText: '3012'),
            ),
            const Divider(height: 24),
            TextField(
              controller: _bind,
              decoration: const InputDecoration(
                  labelText: 'Bind host (จำกัด interface)', hintText: '0.0.0.0 = ทุก interface'),
            ),
            TextField(
              controller: _max,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Max connections (เว้นว่าง = ไม่จำกัด)'),
            ),
            const SizedBox(height: 8),
            DropdownButtonFormField<int?>(
              value: _expiresHours,
              decoration: const InputDecoration(labelText: 'หมดเวลาอัตโนมัติ'),
              items: const [
                DropdownMenuItem(value: null, child: Text('ไม่หมดเวลา')),
                DropdownMenuItem(value: 1, child: Text('1 ชั่วโมง')),
                DropdownMenuItem(value: 2, child: Text('2 ชั่วโมง')),
                DropdownMenuItem(value: 8, child: Text('8 ชั่วโมง')),
                DropdownMenuItem(value: 24, child: Text('24 ชั่วโมง')),
              ],
              onChanged: (v) => setState(() => _expiresHours = v),
            ),
            if (_error != null) ...[
              const SizedBox(height: 10),
              Text(_error!, style: const TextStyle(color: Colors.redAccent, fontSize: 12)),
            ],
          ]),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
        FilledButton(
          onPressed: _busy ? null : _save,
          child: _busy
              ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
              : Text(_editing ? 'Save' : 'Create'),
        ),
      ],
    );
  }
}
