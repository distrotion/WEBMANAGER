import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'api.dart';
import 'download.dart';
import 'folder_picker.dart';
import 'timefmt.dart';

/// File Share — expose a server folder as a READ-ONLY download tree so an
/// external consumer (typically an ML job pulling QC images to train) can list
/// and fetch files. Admin defines shares here; a script pulls with an x-api-token.
class FileSharePage extends StatefulWidget {
  const FileSharePage({super.key});
  @override
  State<FileSharePage> createState() => _FileSharePageState();
}

class _FileSharePageState extends State<FileSharePage> {
  late Future<List<Map<String, dynamic>>> _future;
  bool _hasToken = false;
  String? _freshToken;

  @override
  void initState() {
    super.initState();
    _reload();
    Api.instance.shareHasToken().then((v) {
      if (mounted) setState(() => _hasToken = v);
    });
  }

  void _reload() => setState(() => _future = Api.instance.shares());

  Future<void> _edit([Map<String, dynamic>? share]) async {
    final ok = await showDialog<bool>(context: context, builder: (_) => ShareDialog(share: share));
    if (ok == true) _reload();
  }

  Future<void> _delete(Map<String, dynamic> s) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text('ลบ share "${s['name']}"?'),
        content: const Text('ลบเฉพาะการแชร์ ไฟล์จริงบน server ไม่ถูกลบ'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('ยกเลิก')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('ลบ')),
        ],
      ),
    );
    if (ok == true) {
      await Api.instance.deleteShare(s['id'] as int);
      _reload();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('File Share (ให้ ML ดึงรูป)'),
        actions: [IconButton(onPressed: _reload, icon: const Icon(Icons.refresh))],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _edit(),
        icon: const Icon(Icons.create_new_folder),
        label: const Text('เพิ่ม share'),
      ),
      body: ListView(padding: const EdgeInsets.all(12), children: [
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
                child: Text('ยังไม่มี share — กด "เพิ่ม share" แล้วเลือกโฟลเดอร์รูปบน server',
                    style: TextStyle(color: Colors.white54)),
              );
            }
            return Column(children: rows.map(_shareCard).toList());
          },
        ),
        const SizedBox(height: 8),
        _tokenCard(),
      ]),
    );
  }

  Widget _shareCard(Map<String, dynamic> s) {
    final enabled = s['enabled'] == 1 || s['enabled'] == true;
    return Card(
      color: Colors.white.withValues(alpha: 0.03),
      child: ListTile(
        leading: Icon(enabled ? Icons.folder_shared : Icons.folder_off,
            color: enabled ? Colors.amber : Colors.white24),
        title: Text('${s['name']}', style: const TextStyle(fontWeight: FontWeight.w600)),
        subtitle: Text('${s['root_path']}',
            style: const TextStyle(fontFamily: 'monospace', fontSize: 11, color: Colors.white54)),
        trailing: Wrap(spacing: 2, children: [
          IconButton(
            tooltip: 'เปิดดู / ดาวน์โหลด',
            icon: const Icon(Icons.folder_open, size: 20),
            onPressed: enabled
                ? () => Navigator.of(context).push(MaterialPageRoute(
                    builder: (_) => ShareBrowsePage(shareId: s['id'] as int, shareName: '${s['name']}')))
                : null,
          ),
          IconButton(tooltip: 'แก้ไข', icon: const Icon(Icons.edit, size: 18), onPressed: () => _edit(s)),
          IconButton(tooltip: 'ลบ', icon: const Icon(Icons.delete_outline, size: 18), onPressed: () => _delete(s)),
        ]),
      ),
    );
  }

  Widget _tokenCard() {
    final origin = Api.instance.serverOrigin;
    final example = 'TOKEN=${_freshToken ?? 'fst_...'}\n'
        'BASE=$origin\n'
        '# 1) list ทุกไฟล์ใน share (recursive) เอา path ไปวน\n'
        'curl -s -H "x-api-token: \$TOKEN" "\$BASE/api/shares/<id>/list?recursive=1"\n'
        '# 2) โหลดทีละไฟล์ตาม path ที่ได้\n'
        'curl -s -H "x-api-token: \$TOKEN" "\$BASE/api/shares/<id>/file?path=2026-07/img001.jpg" -o img001.jpg';
    return Card(
      color: Colors.white.withValues(alpha: 0.03),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            const Icon(Icons.vpn_key, size: 16),
            const SizedBox(width: 6),
            const Text('API token — ให้ ML/สคริปต์เครื่องอื่นดึงไฟล์',
                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
            const Spacer(),
            Text(_hasToken ? 'มี token' : 'ยังไม่มี', style: const TextStyle(fontSize: 11, color: Colors.white54)),
          ]),
          const SizedBox(height: 4),
          const Text('token นี้ให้สิทธิ์ "อ่าน/ดาวน์โหลดไฟล์" ทุก share เท่านั้น — เพิ่ม/แก้ share ทำได้จากที่ login เท่านั้น',
              style: TextStyle(fontSize: 11, color: Colors.white38)),
          if (_freshToken != null) ...[
            const SizedBox(height: 8),
            Row(children: [
              Expanded(child: SelectableText(_freshToken!, style: const TextStyle(fontFamily: 'monospace', fontSize: 12))),
              IconButton(
                  icon: const Icon(Icons.copy, size: 16),
                  onPressed: () => Clipboard.setData(ClipboardData(text: _freshToken!))),
            ]),
            const Text('copy เก็บไว้ — ปิดหน้าแล้วไม่โชว์ซ้ำ',
                style: TextStyle(fontSize: 11, color: Colors.orangeAccent)),
          ],
          const SizedBox(height: 8),
          Row(children: [
            FilledButton.tonalIcon(
              onPressed: () async {
                final t = await Api.instance.genShareToken();
                setState(() {
                  _freshToken = t;
                  _hasToken = true;
                });
              },
              icon: const Icon(Icons.key, size: 15),
              label: Text(_hasToken ? 'สร้างใหม่' : 'สร้าง token'),
            ),
            const SizedBox(width: 8),
            if (_hasToken)
              OutlinedButton(
                onPressed: () async {
                  await Api.instance.revokeShareToken();
                  setState(() {
                    _hasToken = false;
                    _freshToken = null;
                  });
                },
                child: const Text('เพิกถอน'),
              ),
          ]),
          const SizedBox(height: 12),
          const Text('ตัวอย่างดึงจากเครื่อง ML:', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
          const SizedBox(height: 4),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(color: Colors.black26, borderRadius: BorderRadius.circular(6)),
            child: SelectableText(example, style: const TextStyle(fontFamily: 'monospace', fontSize: 11.5)),
          ),
        ]),
      ),
    );
  }
}

/// Add / edit a share: a name + a folder on the server (picked with the browser).
class ShareDialog extends StatefulWidget {
  final Map<String, dynamic>? share;
  const ShareDialog({super.key, this.share});
  @override
  State<ShareDialog> createState() => _ShareDialogState();
}

class _ShareDialogState extends State<ShareDialog> {
  late final TextEditingController _name;
  late final TextEditingController _path;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _name = TextEditingController(text: widget.share?['name']?.toString() ?? '');
    _path = TextEditingController(text: widget.share?['root_path']?.toString() ?? '');
  }

  @override
  void dispose() {
    _name.dispose();
    _path.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final body = {'name': _name.text.trim(), 'root_path': _path.text.trim()};
      if (widget.share == null) {
        await Api.instance.createShare(body);
      } else {
        await Api.instance.updateShare(widget.share!['id'] as int, body);
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
      title: Text(widget.share == null ? 'เพิ่ม share' : 'แก้ไข share'),
      content: SizedBox(
        width: 460,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(
            controller: _name,
            decoration: const InputDecoration(labelText: 'ชื่อ share', hintText: 'เช่น QC images line B'),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _path,
            decoration: InputDecoration(
              labelText: 'โฟลเดอร์บน server (absolute path)',
              hintText: r'เช่น C:\qc\images  หรือ  /data/qc/images',
              suffixIcon: IconButton(
                tooltip: 'เลือกโฟลเดอร์',
                icon: const Icon(Icons.folder_open),
                onPressed: () async {
                  final p = await FolderPicker.show(context,
                      start: _path.text.trim().isEmpty ? null : _path.text.trim());
                  if (p != null) setState(() => _path.text = p);
                },
              ),
            ),
          ),
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(_error!, style: const TextStyle(color: Colors.redAccent, fontSize: 12)),
          ],
        ]),
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

/// Navigate one share's folders and download files (admin, in-panel).
class ShareBrowsePage extends StatefulWidget {
  final int shareId;
  final String shareName;
  const ShareBrowsePage({super.key, required this.shareId, required this.shareName});
  @override
  State<ShareBrowsePage> createState() => _ShareBrowsePageState();
}

class _ShareBrowsePageState extends State<ShareBrowsePage> {
  String _path = '';
  bool _busy = false;
  String? _error;
  List<Map<String, dynamic>> _entries = [];
  bool _capped = false;
  int? _downloading; // index being downloaded

  @override
  void initState() {
    super.initState();
    _load('');
  }

  Future<void> _load(String path) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final d = await Api.instance.shareList(widget.shareId, path: path);
      setState(() {
        _path = path;
        _entries = ((d['entries'] as List?) ?? []).cast<Map<String, dynamic>>();
        _capped = d['capped'] == true;
      });
    } catch (e) {
      setState(() => _error = '$e'.replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _up() {
    if (_path.isEmpty) return;
    final i = _path.lastIndexOf('/');
    _load(i < 0 ? '' : _path.substring(0, i));
  }

  Future<void> _download(int index, Map<String, dynamic> e) async {
    setState(() => _downloading = index);
    try {
      final bytes = await Api.instance.shareFileBytes(widget.shareId, e['path'] as String);
      downloadBytes(e['name'] as String, bytes);
    } catch (err) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('โหลดไม่ได้: $err')));
      }
    } finally {
      if (mounted) setState(() => _downloading = null);
    }
  }

  String _fmtSize(int n) {
    if (n < 1024) return '$n B';
    if (n < 1024 * 1024) return '${(n / 1024).toStringAsFixed(1)} KB';
    if (n < 1024 * 1024 * 1024) return '${(n / 1024 / 1024).toStringAsFixed(1)} MB';
    return '${(n / 1024 / 1024 / 1024).toStringAsFixed(2)} GB';
  }

  @override
  Widget build(BuildContext context) {
    final dirs = _entries.where((e) => e['isDir'] == true).toList();
    final files = _entries.where((e) => e['isDir'] != true).toList();
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.shareName),
        actions: [IconButton(onPressed: () => _load(_path), icon: const Icon(Icons.refresh))],
      ),
      body: Column(children: [
        Container(
          color: Colors.white.withValues(alpha: 0.04),
          child: Row(children: [
            IconButton(tooltip: 'ขึ้นบน', onPressed: _path.isEmpty ? null : _up, icon: const Icon(Icons.arrow_upward)),
            Expanded(
              child: Text('/$_path',
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 12), overflow: TextOverflow.ellipsis),
            ),
            Padding(
              padding: const EdgeInsets.only(right: 12),
              child: Text('${dirs.length} โฟลเดอร์ · ${files.length} ไฟล์',
                  style: const TextStyle(fontSize: 11, color: Colors.white54)),
            ),
          ]),
        ),
        if (_capped)
          const Padding(
            padding: EdgeInsets.all(8),
            child: Text('รายการเยอะเกิน แสดงบางส่วน — ใช้ recursive ผ่าน API สำหรับดึงทั้งหมด',
                style: TextStyle(fontSize: 11, color: Colors.orangeAccent)),
          ),
        if (_error != null)
          Padding(padding: const EdgeInsets.all(8), child: Text(_error!, style: const TextStyle(color: Colors.redAccent))),
        Expanded(
          child: _busy
              ? const Center(child: CircularProgressIndicator())
              : ListView(children: [
                  ...dirs.map((e) => ListTile(
                        dense: true,
                        leading: const Icon(Icons.folder, color: Colors.amber),
                        title: Text('${e['name']}'),
                        onTap: () => _load(e['path'] as String),
                      )),
                  ...files.asMap().entries.map((entry) {
                    final i = entry.key;
                    final e = entry.value;
                    return ListTile(
                      dense: true,
                      leading: const Icon(Icons.insert_drive_file, color: Colors.white38, size: 20),
                      title: Text('${e['name']}'),
                      subtitle: Text('${_fmtSize((e['size'] as num).toInt())} · ${localTime(_epochToDbUtc(e['mtime']))}',
                          style: const TextStyle(fontSize: 11, color: Colors.white38)),
                      trailing: _downloading == i
                          ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                          : IconButton(
                              tooltip: 'ดาวน์โหลด',
                              icon: const Icon(Icons.download, size: 20),
                              onPressed: () => _download(i, e),
                            ),
                    );
                  }),
                ]),
        ),
      ]),
    );
  }
}

// mtime comes back as epoch-ms; localTime() wants the DB's UTC "YYYY-MM-DD
// HH:MM:SS" shape (no zone). Format it that way so the conversion is consistent.
String _epochToDbUtc(dynamic ms) {
  final n = (ms is num) ? ms.toInt() : 0;
  if (n == 0) return '';
  final d = DateTime.fromMillisecondsSinceEpoch(n, isUtc: true);
  String two(int v) => v.toString().padLeft(2, '0');
  return '${d.year}-${two(d.month)}-${two(d.day)} ${two(d.hour)}:${two(d.minute)}:${two(d.second)}';
}
