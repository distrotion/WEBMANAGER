import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'api.dart';

/// Remote Gateway: raw-TCP port forwarders in a compact inline table — one row
/// per forward with editable name/dest/ports (Enter to save), plus an add row.
/// ต้นทาง(A) = พอร์ตที่ server นี้เปิด · ปลายทาง(B) = พอร์ตของเครื่องปลายทาง.
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

  // per-row inline-edit controllers, keyed by gateway id
  final Map<int, Map<String, TextEditingController>> _ctrls = {};
  // add-row controllers
  final _nName = TextEditingController();
  final _nHost = TextEditingController();
  final _nListen = TextEditingController();
  final _nDest = TextEditingController();

  @override
  void initState() {
    super.initState();
    _reloadFull();
    Api.instance.gatewayHasToken().then((v) {
      if (mounted) setState(() => _hasToken = v);
    });
    _timer = Timer.periodic(const Duration(seconds: 4), (_) => _pollStatus());
  }

  @override
  void dispose() {
    _timer?.cancel();
    _disposeRowCtrls();
    _nName.dispose();
    _nHost.dispose();
    _nListen.dispose();
    _nDest.dispose();
    super.dispose();
  }

  void _disposeRowCtrls() {
    for (final m in _ctrls.values) {
      for (final c in m.values) c.dispose();
    }
    _ctrls.clear();
  }

  Map<String, TextEditingController> _rowCtrls(Map<String, dynamic> g) {
    final id = g['id'] as int;
    return _ctrls.putIfAbsent(id, () => {
          'name': TextEditingController(text: g['name']?.toString() ?? ''),
          'host': TextEditingController(text: g['dest_host']?.toString() ?? ''),
          'listen': TextEditingController(text: '${g['listen_port']}'),
          'dest': TextEditingController(text: '${g['dest_port']}'),
        });
  }

  // Full reload rebuilds inline controllers from fresh server data.
  Future<void> _reloadFull() async {
    try {
      final r = await Api.instance.gateways();
      if (!mounted) return;
      setState(() {
        _disposeRowCtrls();
        _rows = r;
        _loading = false;
      });
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  // Silent poll updates status only — leaves inline controllers untouched so
  // typing isn't interrupted; disposes controllers for rows that vanished.
  Future<void> _pollStatus() async {
    if (!mounted) return;
    try {
      final r = await Api.instance.gateways();
      if (!mounted) return;
      final ids = r.map((g) => g['id'] as int).toSet();
      for (final id in _ctrls.keys.where((id) => !ids.contains(id)).toList()) {
        for (final c in _ctrls[id]!.values) c.dispose();
        _ctrls.remove(id);
      }
      setState(() => _rows = r);
    } catch (_) {}
  }

  void _toast(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(m), duration: const Duration(milliseconds: 900)),
    );
  }

  Future<void> _saveRow(Map<String, dynamic> g) async {
    final c = _rowCtrls(g);
    final listen = int.tryParse(c['listen']!.text.trim());
    final dest = int.tryParse(c['dest']!.text.trim());
    if (c['name']!.text.trim().isEmpty || c['host']!.text.trim().isEmpty || listen == null || dest == null) {
      _toast('กรอกชื่อ / IP / พอร์ต ให้ครบ');
      return;
    }
    try {
      await Api.instance.updateGateway(g['id'], {
        'name': c['name']!.text.trim(),
        'dest_host': c['host']!.text.trim(),
        'listen_port': listen,
        'dest_port': dest,
      });
      _toast('บันทึกแล้ว');
      await _reloadFull();
    } catch (e) {
      _toast('$e');
    }
  }

  Future<void> _add() async {
    final listen = int.tryParse(_nListen.text.trim());
    final dest = int.tryParse(_nDest.text.trim());
    if (_nName.text.trim().isEmpty || _nHost.text.trim().isEmpty || listen == null || dest == null) {
      _toast('กรอกชื่อ / IP ปลายทาง / พอร์ต ให้ครบ');
      return;
    }
    try {
      await Api.instance.createGateway({
        'name': _nName.text.trim(),
        'dest_host': _nHost.text.trim(),
        'listen_port': listen,
        'dest_port': dest,
      });
      _nName.clear();
      _nHost.clear();
      _nListen.clear();
      _nDest.clear();
      await _reloadFull();
    } catch (e) {
      _toast('$e');
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Remote Gateway · port forward'), actions: [
        IconButton(onPressed: _reloadFull, icon: const Icon(Icons.refresh)),
      ]),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(padding: const EdgeInsets.all(12), children: [
              _tableCard(),
              const SizedBox(height: 16),
              _tokenCard(),
            ]),
    );
  }

  // small dense text field for inline cells
  Widget _cell(TextEditingController c, {String? hint, double? width, bool number = false, VoidCallback? onSubmit}) {
    final field = TextField(
      controller: c,
      keyboardType: number ? TextInputType.number : null,
      textAlign: number ? TextAlign.center : TextAlign.start,
      onSubmitted: onSubmit == null ? null : (_) => onSubmit(),
      style: const TextStyle(fontSize: 13),
      decoration: InputDecoration(
        isDense: true,
        hintText: hint,
        contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
        border: const OutlineInputBorder(),
      ),
    );
    return width == null ? Expanded(child: field) : SizedBox(width: width, child: field);
  }

  Widget _ports(TextEditingController listen, TextEditingController dest, {VoidCallback? onSubmit}) {
    return SizedBox(
      width: 150,
      child: Row(children: [
        _cell(listen, width: 60, number: true, onSubmit: onSubmit),
        const Padding(padding: EdgeInsets.symmetric(horizontal: 4), child: Text('→', style: TextStyle(color: Colors.white54))),
        _cell(dest, width: 60, number: true, onSubmit: onSubmit),
      ]),
    );
  }

  Widget _tableCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: const [
            Icon(Icons.swap_horiz, size: 18),
            SizedBox(width: 8),
            Text('Remote forward', style: TextStyle(fontWeight: FontWeight.bold)),
            SizedBox(width: 8),
            Expanded(
              child: Text('เครื่องนี้เปิด ต้นทาง(A) → ส่งต่อไป ปลายทาง(B) ของเครื่อง IP ที่ระบุ',
                  style: TextStyle(fontSize: 11, color: Colors.white54)),
            ),
          ]),
          const SizedBox(height: 10),
          // header
          Row(children: const [
            Expanded(flex: 3, child: Text('ชื่อ', style: TextStyle(fontSize: 12, color: Colors.white54))),
            Expanded(flex: 4, child: Text('IP ปลายทาง', style: TextStyle(fontSize: 12, color: Colors.white54))),
            SizedBox(width: 150, child: Text('ต้นทาง(A) → ปลายทาง(B)', style: TextStyle(fontSize: 11, color: Colors.white54))),
            SizedBox(width: 128, child: Text('สถานะ', style: TextStyle(fontSize: 12, color: Colors.white54))),
            SizedBox(width: 96, child: Text('จัดการ', style: TextStyle(fontSize: 12, color: Colors.white54))),
          ]),
          const Divider(height: 14),
          if (_rows.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 18),
              child: Center(child: Text('— ยังไม่มี forward · เพิ่มด้านล่าง —', style: TextStyle(color: Colors.white38))),
            ),
          for (final g in _rows) _dataRow(g),
          const Divider(height: 18),
          _addRow(),
          const SizedBox(height: 8),
          const Text(
            'ต้นทาง(A) = พอร์ตบนเครื่องนี้ที่ user เข้า (http://เครื่องนี้:A) · ปลายทาง(B) = พอร์ตของเครื่อง IP ปลายทาง · '
            'แก้ในตารางแล้วกด Enter เพื่อบันทึก',
            style: TextStyle(fontSize: 11, color: Colors.white54),
          ),
        ]),
      ),
    );
  }

  Widget _dataRow(Map<String, dynamic> g) {
    final c = _rowCtrls(g);
    final status = g['status'] as String? ?? '?';
    final conns = g['conns'] ?? 0;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(children: [
        Expanded(flex: 3, child: _cell(c['name']!, onSubmit: () => _saveRow(g))),
        const SizedBox(width: 8),
        Expanded(flex: 4, child: _cell(c['host']!, hint: '10.20.0.5', onSubmit: () => _saveRow(g))),
        const SizedBox(width: 8),
        _ports(c['listen']!, c['dest']!, onSubmit: () => _saveRow(g)),
        SizedBox(
          width: 128,
          child: Row(children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(4),
                border: Border.all(color: _statusColor(status)),
                color: _statusColor(status).withValues(alpha: 0.12),
              ),
              child: Text(conns is int && conns > 0 ? '$status·$conns' : status,
                  style: TextStyle(fontSize: 10, color: _statusColor(status))),
            ),
            Switch(
              value: g['enabled'] == true,
              onChanged: (v) async {
                await Api.instance.updateGateway(g['id'], {'enabled': v});
                await _reloadFull();
              },
            ),
          ]),
        ),
        SizedBox(
          width: 96,
          child: Row(children: [
            IconButton(
              tooltip: 'ตั้งค่าเพิ่ม (bind/limit/หมดเวลา)',
              visualDensity: VisualDensity.compact,
              icon: const Icon(Icons.tune, size: 18),
              onPressed: () async {
                final ok = await showDialog<bool>(context: context, builder: (_) => GatewayDialog(gateway: g));
                if (ok == true) _reloadFull();
              },
            ),
            IconButton(
              tooltip: 'ลบ',
              visualDensity: VisualDensity.compact,
              icon: const Icon(Icons.delete, size: 18, color: Colors.redAccent),
              onPressed: () async {
                await Api.instance.deleteGateway(g['id']);
                await _reloadFull();
              },
            ),
          ]),
        ),
      ]),
    );
  }

  Widget _addRow() {
    return Row(children: [
      Expanded(flex: 3, child: _cell(_nName, hint: 'ชื่อ (เช่น Line B)', onSubmit: _add)),
      const SizedBox(width: 8),
      Expanded(flex: 4, child: _cell(_nHost, hint: 'IP ปลายทาง (10.20.0.5)', onSubmit: _add)),
      const SizedBox(width: 8),
      _ports(_nListen, _nDest, onSubmit: _add),
      SizedBox(
        width: 128,
        child: FilledButton.icon(
          onPressed: _add,
          icon: const Icon(Icons.add, size: 16),
          label: const Text('เพิ่ม'),
        ),
      ),
      const SizedBox(width: 96),
    ]);
  }

  Widget _tokenCard() {
    return Card(
      color: Colors.white.withValues(alpha: 0.03),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            const Icon(Icons.vpn_key, size: 16),
            const SizedBox(width: 6),
            const Text('API token (เฉพาะสั่งจาก CLI/เครื่องอื่น — ปกติไม่ต้องใช้)',
                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
            const Spacer(),
            Text(_hasToken ? 'มี token' : 'ยังไม่มี', style: const TextStyle(fontSize: 11, color: Colors.white54)),
          ]),
          if (_freshToken != null) ...[
            const SizedBox(height: 8),
            Row(children: [
              Expanded(child: SelectableText(_freshToken!, style: const TextStyle(fontFamily: 'monospace', fontSize: 12))),
              IconButton(icon: const Icon(Icons.copy, size: 16), onPressed: () => Clipboard.setData(ClipboardData(text: _freshToken!))),
            ]),
            const Text('copy เก็บไว้ — ปิดหน้าแล้วไม่โชว์ซ้ำ', style: TextStyle(fontSize: 11, color: Colors.orangeAccent)),
          ],
          const SizedBox(height: 8),
          Row(children: [
            FilledButton.tonalIcon(
              onPressed: () async {
                final t = await Api.instance.genGatewayToken();
                setState(() { _freshToken = t; _hasToken = true; });
              },
              icon: const Icon(Icons.key, size: 15),
              label: Text(_hasToken ? 'สร้างใหม่' : 'สร้าง token'),
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
}

// Advanced edit (bind host / max conns / auto-expiry) — opened via the gear icon.
class GatewayDialog extends StatefulWidget {
  final Map<String, dynamic>? gateway;
  const GatewayDialog({super.key, this.gateway});
  @override
  State<GatewayDialog> createState() => _GatewayDialogState();
}

class _GatewayDialogState extends State<GatewayDialog> {
  final _bind = TextEditingController(text: '0.0.0.0');
  final _max = TextEditingController();
  int? _expiresHours;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    final g = widget.gateway;
    if (g != null) {
      _bind.text = g['bind_host'] ?? '0.0.0.0';
      _max.text = (g['max_conns'] ?? 0) == 0 ? '' : '${g['max_conns']}';
    }
  }

  Future<void> _save() async {
    setState(() { _busy = true; _error = null; });
    try {
      final body = {
        'bind_host': _bind.text.trim().isEmpty ? '0.0.0.0' : _bind.text.trim(),
        'max_conns': int.tryParse(_max.text.trim()) ?? 0,
        if (_expiresHours != null)
          'expires_at': DateTime.now().add(Duration(hours: _expiresHours!)).millisecondsSinceEpoch,
      };
      await Api.instance.updateGateway(widget.gateway!['id'], body);
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
      title: Text('ตั้งค่าเพิ่ม · ${widget.gateway?['name'] ?? ''}'),
      content: SizedBox(
        width: 380,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(
            controller: _bind,
            decoration: const InputDecoration(labelText: 'Bind host (จำกัด interface)', hintText: '0.0.0.0 = ทุก interface'),
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
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
        FilledButton(
          onPressed: _busy ? null : _save,
          child: _busy
              ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
              : const Text('Save'),
        ),
      ],
    );
  }
}
