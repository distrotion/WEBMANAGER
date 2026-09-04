import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'api.dart';
import 'download.dart';
import 'timefmt.dart';

/// In-panel folder browser over one FTP account's root — the "FileZilla view"
/// without leaving the panel: browse, upload, download, mkdir, rename, delete
/// (empty folders only), image preview. Admin-only, same jail as the FTP side.
class FtpBrowserPage extends StatefulWidget {
  final int userId;
  final String username;
  final String rootPath;
  const FtpBrowserPage({super.key, required this.userId, required this.username, required this.rootPath});
  @override
  State<FtpBrowserPage> createState() => _FtpBrowserPageState();
}

class _FtpBrowserPageState extends State<FtpBrowserPage> {
  String _path = '';
  bool _busy = false;
  String? _error;
  List<Map<String, dynamic>> _entries = [];
  bool _capped = false;
  int? _downloading;
  String? _uploadingName; // file currently being uploaded (progress label)
  int _uploadDone = 0;
  int _uploadTotal = 0;

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
      final d = await Api.instance.ftpList(widget.userId, path: path);
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

  void _snack(String msg) {
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  // ---- actions ----

  Future<void> _upload() async {
    final files = await pickFilesBytes();
    if (files.isEmpty) return;
    setState(() {
      _uploadTotal = files.length;
      _uploadDone = 0;
    });
    var failed = 0;
    for (final f in files) {
      setState(() => _uploadingName = f.name);
      try {
        await Api.instance.ftpUpload(widget.userId, _path, f.name, f.bytes);
      } catch (e) {
        failed++;
        _snack('อัพโหลด ${f.name} ไม่สำเร็จ: $e');
      }
      if (mounted) setState(() => _uploadDone++);
    }
    if (mounted) {
      setState(() {
        _uploadingName = null;
        _uploadTotal = 0;
      });
      if (failed == 0) _snack('อัพโหลดครบ ${files.length} ไฟล์ ✓');
      _load(_path);
    }
  }

  Future<void> _mkdir() async {
    final name = await _askText('สร้างโฟลเดอร์ใหม่', 'ชื่อโฟลเดอร์');
    if (name == null || name.isEmpty) return;
    try {
      await Api.instance.ftpMkdir(widget.userId, _path, name);
      _load(_path);
    } catch (e) {
      _snack('$e'.replaceFirst('Exception: ', ''));
    }
  }

  Future<void> _rename(Map<String, dynamic> e) async {
    final name = await _askText('เปลี่ยนชื่อ "${e['name']}"', 'ชื่อใหม่', initial: e['name'] as String?);
    if (name == null || name.isEmpty || name == e['name']) return;
    try {
      await Api.instance.ftpRename(widget.userId, e['path'] as String, name);
      _load(_path);
    } catch (err) {
      _snack('$err'.replaceFirst('Exception: ', ''));
    }
  }

  Future<void> _delete(Map<String, dynamic> e) async {
    final isDir = e['isDir'] == true;
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text('ลบ${isDir ? 'โฟลเดอร์' : 'ไฟล์'} "${e['name']}"?'),
        content: Text(isDir ? 'ลบได้เฉพาะโฟลเดอร์ว่างเท่านั้น' : 'ลบแล้วกู้คืนไม่ได้'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('ยกเลิก')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('ลบ')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await Api.instance.ftpDeleteEntry(widget.userId, e['path'] as String);
      _load(_path);
    } catch (err) {
      _snack('$err'.replaceFirst('Exception: ', ''));
    }
  }

  Future<void> _download(int index, Map<String, dynamic> e) async {
    setState(() => _downloading = index);
    try {
      final bytes = await Api.instance.ftpFileBytes(widget.userId, e['path'] as String);
      downloadBytes(e['name'] as String, bytes);
    } catch (err) {
      _snack('โหลดไม่ได้: $err');
    } finally {
      if (mounted) setState(() => _downloading = null);
    }
  }

  bool _isImage(String name) {
    final n = name.toLowerCase();
    return n.endsWith('.jpg') || n.endsWith('.jpeg') || n.endsWith('.png') || n.endsWith('.gif') || n.endsWith('.webp') || n.endsWith('.bmp');
  }

  Future<void> _preview(Map<String, dynamic> e) async {
    List<int> bytes;
    try {
      bytes = await Api.instance.ftpFileBytes(widget.userId, e['path'] as String);
    } catch (err) {
      _snack('เปิดรูปไม่ได้: $err');
      return;
    }
    if (!mounted) return;
    await showDialog(
      context: context,
      builder: (_) => Dialog(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(
            padding: const EdgeInsets.all(10),
            child: Text('${e['name']}', style: const TextStyle(fontWeight: FontWeight.w600)),
          ),
          Flexible(
            child: InteractiveViewer(
              maxScale: 8,
              child: Image.memory(Uint8List.fromList(bytes), fit: BoxFit.contain),
            ),
          ),
          Row(mainAxisAlignment: MainAxisAlignment.end, children: [
            TextButton.icon(
              icon: const Icon(Icons.download, size: 16),
              label: const Text('ดาวน์โหลด'),
              onPressed: () => downloadBytes(e['name'] as String, bytes),
            ),
            TextButton(onPressed: () => Navigator.pop(context), child: const Text('ปิด')),
          ]),
        ]),
      ),
    );
  }

  Future<String?> _askText(String title, String label, {String? initial}) {
    final c = TextEditingController(text: initial ?? '');
    return showDialog<String>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text(title),
        content: TextField(
          controller: c,
          autofocus: true,
          decoration: InputDecoration(labelText: label),
          onSubmitted: (v) => Navigator.pop(context, v.trim()),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('ยกเลิก')),
          FilledButton(onPressed: () => Navigator.pop(context, c.text.trim()), child: const Text('ตกลง')),
        ],
      ),
    );
  }

  String _fmtSize(int n) {
    if (n < 1024) return '$n B';
    if (n < 1024 * 1024) return '${(n / 1024).toStringAsFixed(1)} KB';
    if (n < 1024 * 1024 * 1024) return '${(n / 1024 / 1024).toStringAsFixed(1)} MB';
    return '${(n / 1024 / 1024 / 1024).toStringAsFixed(2)} GB';
  }

  // Breadcrumb: root / seg1 / seg2 … each segment clickable.
  Widget _breadcrumb() {
    final segs = _path.isEmpty ? <String>[] : _path.split('/');
    final crumbs = <Widget>[
      InkWell(
        onTap: () => _load(''),
        child: const Padding(
          padding: EdgeInsets.symmetric(horizontal: 4, vertical: 6),
          child: Icon(Icons.home, size: 16),
        ),
      ),
    ];
    var acc = '';
    for (final s in segs) {
      acc = acc.isEmpty ? s : '$acc/$s';
      final target = acc;
      crumbs.add(const Text('/', style: TextStyle(color: Colors.white38)));
      crumbs.add(InkWell(
        onTap: () => _load(target),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 6),
          child: Text(s, style: const TextStyle(fontSize: 12)),
        ),
      ));
    }
    return Wrap(crossAxisAlignment: WrapCrossAlignment.center, children: crumbs);
  }

  @override
  Widget build(BuildContext context) {
    final dirs = _entries.where((e) => e['isDir'] == true).toList();
    final files = _entries.where((e) => e['isDir'] != true).toList();
    return Scaffold(
      appBar: AppBar(
        title: Text('📂 ${widget.username}'),
        actions: [
          IconButton(tooltip: 'สร้างโฟลเดอร์', onPressed: _mkdir, icon: const Icon(Icons.create_new_folder_outlined)),
          IconButton(onPressed: () => _load(_path), icon: const Icon(Icons.refresh)),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _uploadingName != null ? null : _upload,
        icon: const Icon(Icons.upload_file),
        label: Text(_uploadingName != null ? 'กำลังอัพโหลด…' : 'อัพโหลดไฟล์'),
      ),
      body: Column(children: [
        Container(
          color: Colors.white.withValues(alpha: 0.04),
          padding: const EdgeInsets.symmetric(horizontal: 8),
          child: Row(children: [
            IconButton(tooltip: 'ขึ้นบน', onPressed: _path.isEmpty ? null : _up, icon: const Icon(Icons.arrow_upward)),
            Expanded(child: _breadcrumb()),
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: Text('${dirs.length} โฟลเดอร์ · ${files.length} ไฟล์',
                  style: const TextStyle(fontSize: 11, color: Colors.white54)),
            ),
          ]),
        ),
        if (_uploadTotal > 0)
          Padding(
            padding: const EdgeInsets.all(8),
            child: Row(children: [
              Expanded(
                child: LinearProgressIndicator(value: _uploadTotal == 0 ? null : _uploadDone / _uploadTotal),
              ),
              const SizedBox(width: 10),
              Text('$_uploadDone/$_uploadTotal  ${_uploadingName ?? ''}',
                  style: const TextStyle(fontSize: 11, color: Colors.white70)),
            ]),
          ),
        if (_capped)
          const Padding(
            padding: EdgeInsets.all(8),
            child: Text('รายการเยอะเกิน แสดงบางส่วน', style: TextStyle(fontSize: 11, color: Colors.orangeAccent)),
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
                        trailing: _entryMenu(e),
                      )),
                  ...files.asMap().entries.map((entry) {
                    final i = entry.key;
                    final e = entry.value;
                    final img = _isImage(e['name'] as String);
                    return ListTile(
                      dense: true,
                      leading: Icon(img ? Icons.image : Icons.insert_drive_file,
                          color: img ? Colors.lightBlueAccent : Colors.white38, size: 20),
                      title: Text('${e['name']}'),
                      subtitle: Text('${_fmtSize((e['size'] as num).toInt())} · ${localTime(_epochToDbUtc(e['mtime']))}',
                          style: const TextStyle(fontSize: 11, color: Colors.white38)),
                      onTap: () => img ? _preview(e) : _download(i, e),
                      trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                        _downloading == i
                            ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                            : IconButton(
                                tooltip: 'ดาวน์โหลด',
                                icon: const Icon(Icons.download, size: 20),
                                onPressed: () => _download(i, e),
                              ),
                        _entryMenu(e),
                      ]),
                    );
                  }),
                  if (dirs.isEmpty && files.isEmpty)
                    const Padding(
                      padding: EdgeInsets.all(24),
                      child: Center(child: Text('โฟลเดอร์ว่าง', style: TextStyle(color: Colors.white38))),
                    ),
                ]),
        ),
      ]),
    );
  }

  Widget _entryMenu(Map<String, dynamic> e) {
    return PopupMenuButton<String>(
      tooltip: 'เพิ่มเติม',
      icon: const Icon(Icons.more_vert, size: 18),
      onSelected: (v) {
        if (v == 'rename') _rename(e);
        if (v == 'delete') _delete(e);
      },
      itemBuilder: (_) => const [
        PopupMenuItem(value: 'rename', child: ListTile(leading: Icon(Icons.drive_file_rename_outline), title: Text('เปลี่ยนชื่อ'), dense: true)),
        PopupMenuItem(value: 'delete', child: ListTile(leading: Icon(Icons.delete_outline), title: Text('ลบ'), dense: true)),
      ],
    );
  }
}

String _epochToDbUtc(dynamic ms) {
  final n = (ms is num) ? ms.toInt() : 0;
  if (n == 0) return '';
  final d = DateTime.fromMillisecondsSinceEpoch(n, isUtc: true);
  String two(int v) => v.toString().padLeft(2, '0');
  return '${d.year}-${two(d.month)}-${two(d.day)} ${two(d.hour)}:${two(d.minute)}:${two(d.second)}';
}
