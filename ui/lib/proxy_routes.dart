import 'package:flutter/material.dart';
import 'api.dart';

/// Reverse-proxy routes for one static site's own direct port (#436) — the
/// mechanism behind the "one HTTPS edge" migration: a path prefix on this
/// site proxies to any host:port, plain http backend included, so the
/// browser only ever sees this site's single origin and mixed-content
/// blocking never triggers once the site is https.
class ProxyRoutesPage extends StatefulWidget {
  final int siteId;
  final String siteName;
  const ProxyRoutesPage({super.key, required this.siteId, required this.siteName});
  @override
  State<ProxyRoutesPage> createState() => _ProxyRoutesPageState();
}

class _ProxyRoutesPageState extends State<ProxyRoutesPage> {
  late Future<List<Map<String, dynamic>>> _future;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  void _reload() => setState(() => _future = Api.instance.proxyRoutes(widget.siteId));

  Future<void> _edit([Map<String, dynamic>? route]) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => _RouteDialog(siteId: widget.siteId, route: route),
    );
    if (ok == true) _reload();
  }

  Future<void> _delete(Map<String, dynamic> r) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text('ลบเส้นทาง "${r['path_prefix']}"?'),
        content: const Text('เส้นทางนี้จะหายจาก nginx ทันที (ผ่าน nginx -t ก่อนเสมอ)'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('ยกเลิก')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('ลบ')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await Api.instance.deleteProxyRoute(widget.siteId, r['id'] as int);
      _reload();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('$e'.replaceFirst('Exception: ', ''))));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('เส้นทาง proxy · ${widget.siteName}'),
        actions: [IconButton(onPressed: _reload, icon: const Icon(Icons.refresh))],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _edit(),
        icon: const Icon(Icons.add),
        label: const Text('เพิ่มเส้นทาง'),
      ),
      body: ListView(padding: const EdgeInsets.all(12), children: [
        Card(
          color: Colors.blue.withValues(alpha: 0.08),
          child: const Padding(
            padding: EdgeInsets.all(14),
            child: Text(
              'แต่ละเส้นทางเพิ่ม location ใน nginx ของพอร์ตตรงของไซต์นี้ ให้ path ที่ระบุ proxy ไปยัง host:port '
              'อะไรก็ได้ (ไม่จำกัด 127.0.0.1) — ทุกครั้งที่บันทึก ระบบรัน nginx -t ก่อนเสมอ ถ้าพังจะคืนไฟล์เดิมทันที',
              style: TextStyle(fontSize: 12, height: 1.5),
            ),
          ),
        ),
        const SizedBox(height: 8),
        FutureBuilder<List<Map<String, dynamic>>>(
          future: _future,
          builder: (context, snap) {
            if (snap.connectionState != ConnectionState.done) {
              return const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator()));
            }
            if (snap.hasError) {
              return Padding(
                padding: const EdgeInsets.all(16),
                child: Text('${snap.error}'.replaceFirst('Exception: ', ''),
                    style: const TextStyle(color: Colors.redAccent)),
              );
            }
            final rows = snap.data ?? [];
            if (rows.isEmpty) {
              return const Padding(
                padding: EdgeInsets.all(24),
                child: Text('ยังไม่มีเส้นทาง — กด "เพิ่มเส้นทาง"', style: TextStyle(color: Colors.white54)),
              );
            }
            return Column(children: rows.map(_card).toList());
          },
        ),
      ]),
    );
  }

  Widget _card(Map<String, dynamic> r) {
    final enabled = r['enabled'] == true;
    final sse = r['sse'] == true;
    final strip = r['strip_prefix'] == true;
    return Card(
      color: Colors.white.withValues(alpha: 0.03),
      child: ListTile(
        leading: Icon(enabled ? Icons.alt_route : Icons.block, color: enabled ? Colors.greenAccent : Colors.white24),
        title: Text('${r['path_prefix']}', style: const TextStyle(fontWeight: FontWeight.w600, fontFamily: 'monospace')),
        subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('-> ${r['target_url']}', style: const TextStyle(fontSize: 12, fontFamily: 'monospace', color: Colors.white70)),
          Text(
            '${strip ? 'ตัด prefix ก่อนส่ง' : 'ส่ง path เดิมทั้งหมด'}${sse ? ' · SSE (buffering off)' : ''}',
            style: const TextStyle(fontSize: 11, color: Colors.white38),
          ),
        ]),
        isThreeLine: true,
        trailing: Wrap(spacing: 2, children: [
          IconButton(tooltip: 'แก้ไข', icon: const Icon(Icons.edit, size: 18), onPressed: () => _edit(r)),
          IconButton(tooltip: 'ลบ', icon: const Icon(Icons.delete_outline, size: 18), onPressed: () => _delete(r)),
        ]),
      ),
    );
  }
}

class _RouteDialog extends StatefulWidget {
  final int siteId;
  final Map<String, dynamic>? route;
  const _RouteDialog({required this.siteId, this.route});
  @override
  State<_RouteDialog> createState() => _RouteDialogState();
}

class _RouteDialogState extends State<_RouteDialog> {
  late final TextEditingController _prefix;
  late final TextEditingController _target;
  bool _strip = true;
  bool _sse = false;
  bool _enabled = true;
  bool _busy = false;
  String? _error;

  bool get _isEdit => widget.route != null;

  @override
  void initState() {
    super.initState();
    _prefix = TextEditingController(text: widget.route?['path_prefix']?.toString() ?? '');
    _target = TextEditingController(text: widget.route?['target_url']?.toString() ?? '');
    _strip = widget.route?['strip_prefix'] != false;
    _sse = widget.route?['sse'] == true;
    _enabled = widget.route?['enabled'] != false;
  }

  @override
  void dispose() {
    _prefix.dispose();
    _target.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final body = {
      'path_prefix': _prefix.text.trim(),
      'target_url': _target.text.trim(),
      'strip_prefix': _strip,
      'sse': _sse,
      'enabled': _enabled,
    };
    try {
      if (_isEdit) {
        await Api.instance.updateProxyRoute(widget.siteId, widget.route!['id'] as int, body);
      } else {
        await Api.instance.createProxyRoute(widget.siteId, body);
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
      title: Text(_isEdit ? 'แก้ไขเส้นทาง' : 'เพิ่มเส้นทาง proxy'),
      content: SizedBox(
        width: 480,
        child: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            TextField(
              controller: _prefix,
              decoration: const InputDecoration(labelText: 'path prefix', hintText: '/api/gw'),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _target,
              decoration: const InputDecoration(
                labelText: 'target_url',
                hintText: 'http://172.23.10.34:15000',
                helperText: 'host:port อะไรก็ได้ ไม่จำกัด 127.0.0.1',
              ),
            ),
            const SizedBox(height: 6),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              dense: true,
              value: _strip,
              onChanged: (v) => setState(() => _strip = v),
              title: const Text('ตัด prefix ก่อนส่งต่อ', style: TextStyle(fontSize: 13)),
              subtitle: const Text('เช่น /api/gw/tags -> /tags ที่ปลายทาง', style: TextStyle(fontSize: 11)),
            ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              dense: true,
              value: _sse,
              onChanged: (v) => setState(() => _sse = v),
              title: const Text('SSE (event stream)', style: TextStyle(fontSize: 13)),
              subtitle: const Text('ปิด buffering ไม่งั้น event จะมาทีเดียวตอนปิดสาย', style: TextStyle(fontSize: 11)),
            ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              dense: true,
              value: _enabled,
              onChanged: (v) => setState(() => _enabled = v),
              title: const Text('เปิดใช้งาน', style: TextStyle(fontSize: 13)),
            ),
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
