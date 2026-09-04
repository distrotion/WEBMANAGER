import 'package:flutter/material.dart';
import 'api.dart';
import 'folder_picker.dart';
import 'ftp_browser.dart';

/// FTP/FTPS server — general-purpose file access for any standard client
/// (FileZilla, WinSCP), unlike File Share (HTTP, read-only pulls) or Network
/// share (credentials the manager uses for itself). One server for the whole
/// box; each account below is chrooted to its own folder.
class FtpPage extends StatefulWidget {
  const FtpPage({super.key});
  @override
  State<FtpPage> createState() => _FtpPageState();
}

class _FtpPageState extends State<FtpPage> {
  Map<String, dynamic>? _status;
  late Future<List<Map<String, dynamic>>> _users;
  bool _busy = false;
  String? _error;

  late final TextEditingController _port;
  late final TextEditingController _pasvMin;
  late final TextEditingController _pasvMax;
  bool _enabled = false;
  bool _tls = false;

  @override
  void initState() {
    super.initState();
    _port = TextEditingController(text: '21');
    _pasvMin = TextEditingController(text: '50000');
    _pasvMax = TextEditingController(text: '50100');
    _reload();
  }

  @override
  void dispose() {
    _port.dispose();
    _pasvMin.dispose();
    _pasvMax.dispose();
    super.dispose();
  }

  Future<void> _reload() async {
    setState(() => _users = Api.instance.ftpUsers());
    try {
      final s = await Api.instance.ftpStatus();
      setState(() {
        _status = s;
        _enabled = s['enabled'] == true;
        _tls = s['tls'] == true;
        _port.text = '${s['port'] ?? 21}';
        _pasvMin.text = '${s['pasvMin'] ?? 50000}';
        _pasvMax.text = '${s['pasvMax'] ?? 50100}';
      });
    } catch (e) {
      setState(() => _error = '$e');
    }
  }

  Future<void> _saveSettings() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final s = await Api.instance.updateFtpSettings({
        'enabled': _enabled,
        'port': int.tryParse(_port.text) ?? 21,
        'pasv_min': int.tryParse(_pasvMin.text) ?? 50000,
        'pasv_max': int.tryParse(_pasvMax.text) ?? 50100,
        'tls': _tls,
      });
      setState(() => _status = s);
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(_enabled ? 'เปิด FTP server แล้ว ✓' : 'ปิด FTP server แล้ว')));
      }
    } catch (e) {
      setState(() => _error = '$e'.replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _edit([Map<String, dynamic>? user]) async {
    final ok = await showDialog<bool>(context: context, builder: (_) => _FtpUserDialog(user: user));
    if (ok == true) _reload();
  }

  Future<void> _delete(Map<String, dynamic> u) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text('ลบบัญชี "${u['username']}"?'),
        content: const Text('ลบเฉพาะบัญชี FTP — ไฟล์ในโฟลเดอร์ไม่ถูกแตะ'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('ยกเลิก')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('ลบ')),
        ],
      ),
    );
    if (ok == true) {
      await Api.instance.deleteFtpUser(u['id'] as int);
      _reload();
    }
  }

  @override
  Widget build(BuildContext context) {
    final running = _status?['running'] == true;
    return Scaffold(
      appBar: AppBar(
        title: const Text('FTP server'),
        actions: [IconButton(onPressed: _reload, icon: const Icon(Icons.refresh))],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _edit(),
        icon: const Icon(Icons.add),
        label: const Text('เพิ่มบัญชี'),
      ),
      body: ListView(padding: const EdgeInsets.all(12), children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Icon(running ? Icons.wifi_tethering : Icons.wifi_tethering_off,
                    color: running ? Colors.greenAccent : Colors.white38, size: 20),
                const SizedBox(width: 8),
                Text(running ? 'กำลังทำงาน' : (_enabled ? 'เปิดไว้แต่ยังไม่ขึ้น' : 'ปิดอยู่'),
                    style: const TextStyle(fontWeight: FontWeight.bold)),
                const Spacer(),
                Switch(value: _enabled, onChanged: (v) => setState(() => _enabled = v)),
              ]),
              if (_status?['pasvHost'] != null)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text('ต่อจากไคลเอนต์ (เช่น FileZilla) ที่ ${_status!['pasvHost']}:${_status!['port']}',
                      style: const TextStyle(fontSize: 12, color: Colors.white54)),
                ),
              const SizedBox(height: 12),
              Wrap(spacing: 12, runSpacing: 12, children: [
                SizedBox(
                  width: 140,
                  child: TextField(
                    controller: _port,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(labelText: 'port', border: OutlineInputBorder(), isDense: true),
                  ),
                ),
                SizedBox(
                  width: 160,
                  child: TextField(
                    controller: _pasvMin,
                    keyboardType: TextInputType.number,
                    decoration:
                        const InputDecoration(labelText: 'passive port ต่ำสุด', border: OutlineInputBorder(), isDense: true),
                  ),
                ),
                SizedBox(
                  width: 160,
                  child: TextField(
                    controller: _pasvMax,
                    keyboardType: TextInputType.number,
                    decoration:
                        const InputDecoration(labelText: 'passive port สูงสุด', border: OutlineInputBorder(), isDense: true),
                  ),
                ),
                Row(mainAxisSize: MainAxisSize.min, children: [
                  Switch(value: _tls, onChanged: (v) => setState(() => _tls = v)),
                  const Text('FTPS (เข้ารหัส TLS)'),
                ]),
              ]),
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  'passive port ต้องเป็นช่วงว่าง ไม่ทับกับพอร์ตอื่นในระบบ · FTPS ใช้ cert เดียวกับ panel HTTPS '
                  '(ต้องติดตั้ง CA เดียวกันบนเครื่อง client ถ้าไม่อยากให้ FileZilla เตือน cert ไม่รู้จัก)',
                  style: TextStyle(fontSize: 11, color: Colors.white38),
                ),
              ),
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(_error!, style: const TextStyle(color: Colors.redAccent, fontSize: 12)),
                ),
              Align(
                alignment: Alignment.centerRight,
                child: Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: FilledButton(
                    onPressed: _busy ? null : _saveSettings,
                    child: _busy
                        ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                        : const Text('บันทึก'),
                  ),
                ),
              ),
            ]),
          ),
        ),
        const SizedBox(height: 8),
        FutureBuilder<List<Map<String, dynamic>>>(
          future: _users,
          builder: (context, snap) {
            if (snap.connectionState != ConnectionState.done) {
              return const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator()));
            }
            if (snap.hasError) return Text('Error: ${snap.error}', style: const TextStyle(color: Colors.redAccent));
            final rows = snap.data ?? [];
            if (rows.isEmpty) {
              return const Padding(
                padding: EdgeInsets.all(24),
                child: Text('ยังไม่มีบัญชี — กด "เพิ่มบัญชี" แล้วเลือกโฟลเดอร์ที่จะให้เข้าถึง',
                    style: TextStyle(color: Colors.white54)),
              );
            }
            return Column(children: rows.map(_userCard).toList());
          },
        ),
      ]),
    );
  }

  Widget _userCard(Map<String, dynamic> u) {
    final enabled = u['enabled'] == true;
    return Card(
      color: Colors.white.withValues(alpha: 0.03),
      child: ListTile(
        leading: Icon(enabled ? Icons.person : Icons.person_off, color: enabled ? Colors.greenAccent : Colors.white24),
        title: Text('${u['username']}', style: const TextStyle(fontWeight: FontWeight.w600)),
        subtitle: Text('${u['root_path']}', style: const TextStyle(fontFamily: 'monospace', fontSize: 11, color: Colors.white70)),
        trailing: Wrap(spacing: 2, children: [
          IconButton(
            tooltip: 'เปิดดูโฟลเดอร์',
            icon: const Icon(Icons.folder_open, size: 18),
            onPressed: () => Navigator.of(context).push(MaterialPageRoute(
              builder: (_) => FtpBrowserPage(
                userId: u['id'] as int,
                username: u['username'] as String,
                rootPath: u['root_path'] as String,
              ),
            )),
          ),
          IconButton(tooltip: 'แก้ไข', icon: const Icon(Icons.edit, size: 18), onPressed: () => _edit(u)),
          IconButton(tooltip: 'ลบ', icon: const Icon(Icons.delete_outline, size: 18), onPressed: () => _delete(u)),
        ]),
      ),
    );
  }
}

class _FtpUserDialog extends StatefulWidget {
  final Map<String, dynamic>? user;
  const _FtpUserDialog({this.user});
  @override
  State<_FtpUserDialog> createState() => _FtpUserDialogState();
}

class _FtpUserDialogState extends State<_FtpUserDialog> {
  late final TextEditingController _username;
  late final TextEditingController _root;
  final _pass = TextEditingController();
  bool _enabled = true;
  bool _busy = false;
  bool _showPass = false;
  String? _error;

  bool get _isEdit => widget.user != null;

  @override
  void initState() {
    super.initState();
    _username = TextEditingController(text: widget.user?['username']?.toString() ?? '');
    _root = TextEditingController(text: widget.user?['root_path']?.toString() ?? '');
    _enabled = widget.user?['enabled'] != false;
  }

  @override
  void dispose() {
    _username.dispose();
    _root.dispose();
    _pass.dispose();
    super.dispose();
  }

  Future<void> _pickFolder() async {
    final picked = await FolderPicker.show(context, start: _root.text.isNotEmpty ? _root.text : null);
    if (picked != null) setState(() => _root.text = picked);
  }

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final body = {
        'username': _username.text.trim(),
        'root_path': _root.text.trim(),
        'enabled': _enabled,
        if (_pass.text.isNotEmpty) 'password': _pass.text,
      };
      if (_isEdit) {
        await Api.instance.updateFtpUser(widget.user!['id'] as int, body);
      } else {
        await Api.instance.createFtpUser(body);
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
      title: Text(_isEdit ? 'แก้ไขบัญชี FTP' : 'เพิ่มบัญชี FTP'),
      content: SizedBox(
        width: 480,
        child: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            TextField(
              controller: _username,
              decoration: const InputDecoration(labelText: 'username', hintText: 'a-z 0-9 . _ -'),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _root,
              readOnly: true,
              onTap: _pickFolder,
              decoration: InputDecoration(
                labelText: 'โฟลเดอร์ที่ให้เข้าถึง (root)',
                helperText: 'บัญชีนี้จะถูกจำกัดอยู่แค่ในโฟลเดอร์นี้ ออกไปข้างนอกไม่ได้',
                helperMaxLines: 2,
                suffixIcon: const Icon(Icons.folder_open),
              ),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _pass,
              obscureText: !_showPass,
              decoration: InputDecoration(
                labelText: _isEdit ? 'รหัสผ่าน (เว้นว่าง = ใช้ของเดิม)' : 'รหัสผ่าน',
                suffixIcon: IconButton(
                  icon: Icon(_showPass ? Icons.visibility_off : Icons.visibility, size: 18),
                  onPressed: () => setState(() => _showPass = !_showPass),
                ),
              ),
            ),
            const SizedBox(height: 6),
            Row(children: [
              Switch(value: _enabled, onChanged: (v) => setState(() => _enabled = v)),
              const Text('เปิดใช้งาน'),
            ]),
            if (_error != null) ...[
              const SizedBox(height: 6),
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
