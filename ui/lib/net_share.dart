import 'package:flutter/material.dart';
import 'api.dart';
import 'timefmt.dart';

/// Network share credentials — lets the manager authenticate SMB shares so the
/// backends it launches can read them. Without this a deployed app runs as
/// LocalSystem, which has no identity on the network, and \\server\share is
/// unreadable even though it opens fine in the operator's own Explorer.
class NetSharePage extends StatefulWidget {
  const NetSharePage({super.key});
  @override
  State<NetSharePage> createState() => _NetSharePageState();
}

class _NetSharePageState extends State<NetSharePage> {
  late Future<List<Map<String, dynamic>>> _future;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  void _reload() => setState(() => _future = Api.instance.netShares());

  Future<void> _reconnect() async {
    setState(() => _busy = true);
    try {
      await Api.instance.reconnectNetShares();
      _reload();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _edit([Map<String, dynamic>? share]) async {
    final ok = await showDialog<bool>(context: context, builder: (_) => NetShareDialog(share: share));
    if (ok == true) _reload();
  }

  Future<void> _delete(Map<String, dynamic> s) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text('ลบ "${s['name']}"?'),
        content: const Text('ลบเฉพาะรหัสที่เก็บไว้ — ไฟล์บน share ไม่ถูกแตะ'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('ยกเลิก')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('ลบ')),
        ],
      ),
    );
    if (ok == true) {
      await Api.instance.deleteNetShare(s['id'] as int);
      _reload();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Network share (รหัสเข้า file share)'),
        actions: [
          IconButton(
            tooltip: 'เชื่อมต่อใหม่ทั้งหมด',
            onPressed: _busy ? null : _reconnect,
            icon: _busy
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.link),
          ),
          IconButton(onPressed: _reload, icon: const Icon(Icons.refresh)),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _edit(),
        icon: const Icon(Icons.add),
        label: const Text('เพิ่ม share'),
      ),
      body: ListView(padding: const EdgeInsets.all(12), children: [
        Card(
          color: Colors.blue.withValues(alpha: 0.08),
          child: const Padding(
            padding: EdgeInsets.all(14),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('ทำไมต้องใส่รหัสตรงนี้', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
              SizedBox(height: 6),
              Text(
                'backend ที่ webmanager รันให้ ทำงานเป็น LocalSystem ซึ่ง "ไม่มีตัวตนบนเครือข่าย" '
                'เปิด \\\\server\\share เองไม่ได้ (ถึงคุณเปิดใน Explorer ได้ก็ตาม)\n'
                'ใส่รหัสไว้ที่นี่ → manager จะ authenticate ให้ แล้ว backend ทุกตัวอ่าน path ได้เลย '
                'โดยไม่ต้องแก้โค้ด app',
                style: TextStyle(fontSize: 12, height: 1.5),
              ),
              SizedBox(height: 6),
              Text('ต้องใช้ \\\\server\\share เท่านั้น — drive letter (Z:) ใช้ไม่ได้ เพราะผูกกับ login session ของคน',
                  style: TextStyle(fontSize: 11.5, color: Colors.orangeAccent)),
            ]),
          ),
        ),
        const SizedBox(height: 8),
        FutureBuilder<List<Map<String, dynamic>>>(
          future: _future,
          builder: (context, snap) {
            if (snap.connectionState != ConnectionState.done) {
              return const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator()));
            }
            if (snap.hasError) return Text('Error: ${snap.error}', style: const TextStyle(color: Colors.redAccent));
            final rows = snap.data ?? [];
            if (rows.isEmpty) {
              return const Padding(
                padding: EdgeInsets.all(24),
                child: Text('ยังไม่มี — กด "เพิ่ม share" แล้วใส่ path + user + รหัส',
                    style: TextStyle(color: Colors.white54)),
              );
            }
            return Column(children: rows.map(_card).toList());
          },
        ),
      ]),
    );
  }

  Widget _card(Map<String, dynamic> s) {
    final ok = s['ok'] == true;
    final enabled = s['enabled'] == true;
    final err = s['error']?.toString();
    return Card(
      color: Colors.white.withValues(alpha: 0.03),
      child: ListTile(
        leading: Icon(
          !enabled ? Icons.pause_circle : (ok ? Icons.cloud_done : Icons.cloud_off),
          color: !enabled ? Colors.white24 : (ok ? Colors.greenAccent : Colors.redAccent),
        ),
        title: Text('${s['name']}', style: const TextStyle(fontWeight: FontWeight.w600)),
        subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('${s['unc_path']}',
              style: const TextStyle(fontFamily: 'monospace', fontSize: 11, color: Colors.white70)),
          Text('user: ${s['username']}', style: const TextStyle(fontSize: 11, color: Colors.white38)),
          if (!ok && err != null && err.isNotEmpty)
            Text(err, style: const TextStyle(fontSize: 11, color: Colors.redAccent)),
          if (ok && s['checkedAt'] != null)
            Text('ตรวจล่าสุด ${localTime(_msToDbUtc(s['checkedAt']))}',
                style: const TextStyle(fontSize: 10, color: Colors.white24)),
        ]),
        isThreeLine: true,
        trailing: Wrap(spacing: 2, children: [
          IconButton(tooltip: 'แก้ไข', icon: const Icon(Icons.edit, size: 18), onPressed: () => _edit(s)),
          IconButton(tooltip: 'ลบ', icon: const Icon(Icons.delete_outline, size: 18), onPressed: () => _delete(s)),
        ]),
      ),
    );
  }
}

String _msToDbUtc(dynamic ms) {
  final n = (ms is num) ? ms.toInt() : 0;
  if (n == 0) return '';
  final d = DateTime.fromMillisecondsSinceEpoch(n, isUtc: true);
  String two(int v) => v.toString().padLeft(2, '0');
  return '${d.year}-${two(d.month)}-${two(d.day)} ${two(d.hour)}:${two(d.minute)}:${two(d.second)}';
}

class NetShareDialog extends StatefulWidget {
  final Map<String, dynamic>? share;
  const NetShareDialog({super.key, this.share});
  @override
  State<NetShareDialog> createState() => _NetShareDialogState();
}

class _NetShareDialogState extends State<NetShareDialog> {
  late final TextEditingController _name;
  late final TextEditingController _path;
  late final TextEditingController _user;
  final _pass = TextEditingController();
  bool _busy = false;
  bool _showPass = false;
  String? _error;
  String? _testResult;

  bool get _isEdit => widget.share != null;

  @override
  void initState() {
    super.initState();
    _name = TextEditingController(text: widget.share?['name']?.toString() ?? '');
    _path = TextEditingController(text: widget.share?['unc_path']?.toString() ?? '');
    _user = TextEditingController(text: widget.share?['username']?.toString() ?? '');
  }

  @override
  void dispose() {
    _name.dispose();
    _path.dispose();
    _user.dispose();
    _pass.dispose();
    super.dispose();
  }

  Map<String, dynamic> _body() => {
        'name': _name.text.trim(),
        'unc_path': _path.text.trim(),
        'username': _user.text.trim(),
        if (_pass.text.isNotEmpty) 'password': _pass.text,
      };

  Future<void> _test() async {
    if (_pass.text.isEmpty) {
      setState(() => _testResult = 'ใส่รหัสผ่านก่อนถึงจะทดสอบได้');
      return;
    }
    setState(() {
      _busy = true;
      _testResult = null;
    });
    try {
      final r = await Api.instance.testNetShare(_body());
      setState(() => _testResult = r['ok'] == true ? '✓ เชื่อมต่อได้ อ่าน path ได้จริง' : '✗ ${r['error'] ?? 'เชื่อมต่อไม่ได้'}');
    } catch (e) {
      setState(() => _testResult = '✗ $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      if (_isEdit) {
        await Api.instance.updateNetShare(widget.share!['id'] as int, _body());
      } else {
        await Api.instance.createNetShare(_body());
      }
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      setState(() => _error = '$e'.replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(_isEdit ? 'แก้ไข network share' : 'เพิ่ม network share'),
      content: SizedBox(
        width: 480,
        child: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            TextField(
              controller: _name,
              decoration: const InputDecoration(labelText: 'ชื่อเรียก', hintText: 'เช่น QC image server'),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _path,
              decoration: const InputDecoration(
                labelText: r'path (\\server\share)',
                hintText: r'\\172.23.10.50\qcimages',
                helperText: 'ใช้ IP หรือชื่อเครื่องก็ได้ — ห้ามใช้ Z:\\',
                helperMaxLines: 2,
              ),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _user,
              decoration: const InputDecoration(
                labelText: 'username',
                hintText: r'DOMAIN\username  หรือ  username',
              ),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _pass,
              obscureText: !_showPass,
              decoration: InputDecoration(
                labelText: _isEdit ? 'รหัสผ่าน (เว้นว่าง = ใช้ของเดิม)' : 'รหัสผ่าน',
                helperText: 'เก็บแบบเข้ารหัส ไม่มีทางเรียกดูกลับได้',
                suffixIcon: IconButton(
                  icon: Icon(_showPass ? Icons.visibility_off : Icons.visibility, size: 18),
                  onPressed: () => setState(() => _showPass = !_showPass),
                ),
              ),
            ),
            if (_testResult != null) ...[
              const SizedBox(height: 10),
              Align(
                alignment: Alignment.centerLeft,
                child: Text(_testResult!,
                    style: TextStyle(
                        fontSize: 12,
                        color: _testResult!.startsWith('✓') ? Colors.greenAccent : Colors.orangeAccent)),
              ),
            ],
            if (_error != null) ...[
              const SizedBox(height: 10),
              Align(
                alignment: Alignment.centerLeft,
                child: Text(_error!, style: const TextStyle(color: Colors.redAccent, fontSize: 12)),
              ),
            ],
          ]),
        ),
      ),
      actions: [
        TextButton(onPressed: _busy ? null : () => Navigator.pop(context, false), child: const Text('ยกเลิก')),
        OutlinedButton.icon(
          onPressed: _busy ? null : _test,
          icon: const Icon(Icons.network_check, size: 16),
          label: const Text('ทดสอบ'),
        ),
        FilledButton(
          onPressed: _busy ? null : _save,
          child: _busy
              ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
              : const Text('บันทึก'),
        ),
      ],
    );
  }
}
