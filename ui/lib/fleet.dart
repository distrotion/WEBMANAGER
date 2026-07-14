import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';
import 'api.dart';

/// Fleet page: choose this server's role (แม่ hub / ลูก agent).
/// - agent: shows the service token to paste into the hub.
/// - hub: manage the server registry + live fleet dashboard.
class FleetPage extends StatefulWidget {
  const FleetPage({super.key});
  @override
  State<FleetPage> createState() => _FleetPageState();
}

class _FleetPageState extends State<FleetPage> {
  String _role = 'agent';
  bool _hasToken = false;
  String? _freshToken; // shown once right after generating
  bool _loading = true;
  String? _error;

  // hub state
  List<Map<String, dynamic>> _remotes = [];
  List<Map<String, dynamic>> _overview = [];
  Timer? _timer;
  final _name = TextEditingController();
  final _url = TextEditingController();
  final _token = TextEditingController();

  // agent join-hub state
  final _hubUrl = TextEditingController();
  final _hubUser = TextEditingController(text: 'admin');
  final _hubPass = TextEditingController();
  final _myName = TextEditingController(text: Uri.base.host);
  final _myUrl = TextEditingController(text: Uri.base.origin);
  bool _joining = false;

  @override
  void initState() {
    super.initState();
    _load();
    _timer = Timer.periodic(const Duration(seconds: 10), (_) => _pollOverview());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final info = await Api.instance.fleetInfo();
      _role = info['role'] ?? 'agent';
      _hasToken = info['hasToken'] == true;
      if (_role == 'hub') {
        _remotes = await Api.instance.fleetRemotes();
        await _pollOverview();
      }
    } catch (e) {
      _error = '$e';
    }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _pollOverview() async {
    if (!mounted || _role != 'hub') return;
    final st = WidgetsBinding.instance.lifecycleState;
    if (st == AppLifecycleState.hidden || st == AppLifecycleState.paused) return;
    try {
      final o = await Api.instance.fleetOverview();
      if (mounted) setState(() => _overview = o);
    } catch (_) {}
  }

  Future<void> _setRole(String role) async {
    await Api.instance.setFleetRole(role);
    setState(() {
      _role = role;
      _loading = true;
    });
    await _load();
  }

  Future<void> _genToken() async {
    final t = await Api.instance.genFleetToken();
    setState(() {
      _freshToken = t;
      _hasToken = true;
    });
  }

  Future<void> _addRemote() async {
    try {
      await Api.instance.addFleetRemote(_name.text.trim(), _url.text.trim(), _token.text.trim());
      _name.clear();
      _url.clear();
      _token.clear();
      _remotes = await Api.instance.fleetRemotes();
      await _pollOverview();
      if (mounted) setState(() {});
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Fleet · แม่/ลูก'), actions: [
        if (_role == 'hub') IconButton(onPressed: _pollOverview, icon: const Icon(Icons.refresh)),
      ]),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                if (_error != null)
                  Text(_error!, style: const TextStyle(color: Colors.redAccent)),
                _roleCard(),
                const SizedBox(height: 12),
                if (_role == 'agent') ...[
                  _joinCard(),
                  const SizedBox(height: 12),
                  _agentCard(),
                ],
                if (_role == 'hub') ...[
                  _serversCard(),
                  const SizedBox(height: 12),
                  ..._overview.map(_serverTile),
                  if (_remotes.isEmpty)
                    const Padding(
                      padding: EdgeInsets.all(24),
                      child: Center(
                          child: Text('ยังไม่มี server ลูก — เพิ่มด้านบน (เอา token จากหน้า Fleet ของเครื่องลูก)',
                              style: TextStyle(color: Colors.white54))),
                    ),
                ],
              ],
            ),
    );
  }

  Widget _roleCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('บทบาทของเครื่องนี้', style: TextStyle(fontWeight: FontWeight.bold)),
          const SizedBox(height: 10),
          SegmentedButton<String>(
            segments: const [
              ButtonSegment(value: 'agent', icon: Icon(Icons.dns), label: Text('ลูก (agent)')),
              ButtonSegment(value: 'hub', icon: Icon(Icons.hub), label: Text('แม่ (hub)')),
            ],
            selected: {_role},
            onSelectionChanged: (s) => _setRole(s.first),
          ),
          const SizedBox(height: 8),
          Text(
            _role == 'hub'
                ? 'เครื่องนี้เป็นศูนย์กลาง: เห็นสถานะทุก server ลูกในหน้าเดียว'
                : 'เครื่องนี้เป็นลูก: สร้าง token ด้านล่างไปกรอกที่เครื่องแม่',
            style: const TextStyle(fontSize: 12, color: Colors.white54),
          ),
        ]),
      ),
    );
  }

  Future<void> _join() async {
    setState(() => _joining = true);
    try {
      await Api.instance.fleetJoin(
        _hubUrl.text.trim(),
        _hubUser.text.trim(),
        _hubPass.text,
        _myName.text.trim(),
        _myUrl.text.trim(),
      );
      _hubPass.clear();
      setState(() => _hasToken = true);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('สมัครเข้ากับเครื่องแม่สำเร็จ ✓ — ไปดูที่ Fleet dashboard ของแม่ได้เลย')));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
      }
    } finally {
      if (mounted) setState(() => _joining = false);
    }
  }

  Widget _joinCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('สมัครเข้ากับเครื่องแม่ (ทางลัด — ไม่ต้อง copy token เอง)',
              style: TextStyle(fontWeight: FontWeight.bold)),
          const SizedBox(height: 4),
          const Text('กรอกที่อยู่เครื่องแม่ + รหัส admin ของแม่ครั้งเดียว เครื่องนี้จะสร้าง token และลงทะเบียนตัวเองให้เสร็จ (รหัสไม่ถูกเก็บ)',
              style: TextStyle(fontSize: 11, color: Colors.white54)),
          const SizedBox(height: 10),
          Row(children: [
            Expanded(
                flex: 3,
                child: TextField(
                    controller: _hubUrl,
                    decoration: const InputDecoration(
                        labelText: 'URL เครื่องแม่', hintText: 'http://172.23.10.99:8088', isDense: true))),
            const SizedBox(width: 8),
            Expanded(
                flex: 2,
                child: TextField(
                    controller: _hubUser,
                    decoration: const InputDecoration(labelText: 'admin ของแม่', isDense: true))),
            const SizedBox(width: 8),
            Expanded(
                flex: 2,
                child: TextField(
                    controller: _hubPass,
                    obscureText: true,
                    decoration: const InputDecoration(labelText: 'รหัสผ่านแม่', isDense: true))),
          ]),
          const SizedBox(height: 8),
          Row(children: [
            Expanded(
                flex: 2,
                child: TextField(
                    controller: _myName,
                    decoration: const InputDecoration(labelText: 'ชื่อเครื่องนี้ (โชว์ที่แม่)', isDense: true))),
            const SizedBox(width: 8),
            Expanded(
                flex: 3,
                child: TextField(
                    controller: _myUrl,
                    decoration: const InputDecoration(
                        labelText: 'URL เครื่องนี้ (ที่แม่มองเห็น)', isDense: true))),
            const SizedBox(width: 8),
            FilledButton.icon(
              onPressed: _joining ? null : _join,
              icon: _joining
                  ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.link, size: 16),
              label: const Text('สมัคร'),
            ),
          ]),
        ]),
      ),
    );
  }

  Widget _agentCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('Service token (ให้เครื่องแม่ใช้)', style: TextStyle(fontWeight: FontWeight.bold)),
          const SizedBox(height: 8),
          if (_freshToken != null) ...[
            Row(children: [
              Expanded(
                child: SelectableText(_freshToken!,
                    style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
              ),
              IconButton(
                tooltip: 'Copy',
                icon: const Icon(Icons.copy, size: 18),
                onPressed: () => Clipboard.setData(ClipboardData(text: _freshToken!)),
              ),
            ]),
            const Text('copy ไปกรอกที่เครื่องแม่ตอนนี้เลย — ปิดหน้าแล้วจะไม่โชว์ซ้ำ',
                style: TextStyle(fontSize: 11, color: Colors.orangeAccent)),
          ] else
            Text(_hasToken ? 'มี token ใช้งานอยู่ (สร้างใหม่ = ตัวเก่าใช้ไม่ได้)' : 'ยังไม่มี token',
                style: const TextStyle(fontSize: 12, color: Colors.white54)),
          const SizedBox(height: 8),
          Row(children: [
            FilledButton.icon(
              onPressed: _genToken,
              icon: const Icon(Icons.key, size: 16),
              label: Text(_hasToken ? 'สร้างใหม่ (rotate)' : 'สร้าง token'),
            ),
            const SizedBox(width: 8),
            if (_hasToken)
              OutlinedButton(
                onPressed: () async {
                  await Api.instance.revokeFleetToken();
                  setState(() {
                    _hasToken = false;
                    _freshToken = null;
                  });
                },
                child: const Text('เพิกถอน'),
              ),
          ]),
        ]),
      ),
    );
  }

  Widget _serversCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('เพิ่ม server ลูก', style: TextStyle(fontWeight: FontWeight.bold)),
          const SizedBox(height: 8),
          Row(children: [
            Expanded(
                flex: 2,
                child: TextField(
                    controller: _name,
                    decoration: const InputDecoration(labelText: 'ชื่อ', isDense: true))),
            const SizedBox(width: 8),
            Expanded(
                flex: 3,
                child: TextField(
                    controller: _url,
                    decoration: const InputDecoration(
                        labelText: 'URL', hintText: 'http://172.23.10.34:8088', isDense: true))),
            const SizedBox(width: 8),
            Expanded(
                flex: 3,
                child: TextField(
                    controller: _token,
                    decoration: const InputDecoration(labelText: 'Token (wmt_…)', isDense: true))),
            const SizedBox(width: 8),
            FilledButton(onPressed: _addRemote, child: const Text('เพิ่ม')),
          ]),
        ]),
      ),
    );
  }

  Widget _serverTile(Map<String, dynamic> s) {
    final up = s['up'] == true;
    final sites = (s['sites'] as List?)?.cast<Map<String, dynamic>>() ?? [];
    final pm2 = (s['pm2'] as List?)?.cast<Map<String, dynamic>>() ?? [];
    final running = sites.where((x) => x['status'] == 'running').length;
    final badProc = pm2.where((p) => p['status'] != 'online').length;
    return Card(
      child: ExpansionTile(
        leading: Icon(Icons.circle, size: 14, color: up ? Colors.greenAccent : Colors.redAccent),
        title: Row(children: [
          Text(s['name'] ?? '', style: const TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(width: 8),
          if (s['version'] != null)
            Text('${s['version']}', style: const TextStyle(fontSize: 11, color: Colors.white38)),
        ]),
        subtitle: Text(
          up
              ? 'sites $running/${sites.length} running · PM2 ${pm2.length - badProc}/${pm2.length} online'
              : 'OFFLINE — ${s['error'] ?? ''}',
          style: TextStyle(fontSize: 12, color: up ? Colors.white54 : Colors.redAccent),
        ),
        trailing: Row(mainAxisSize: MainAxisSize.min, children: [
          IconButton(
            tooltip: 'เปิด panel เครื่องนี้',
            icon: const Icon(Icons.open_in_new, size: 18),
            onPressed: () => launchUrl(Uri.parse(s['url']), webOnlyWindowName: '_blank'),
          ),
          IconButton(
            tooltip: 'เอาออกจาก fleet',
            icon: const Icon(Icons.delete_outline, size: 18),
            onPressed: () async {
              await Api.instance.deleteFleetRemote(s['id']);
              _remotes = await Api.instance.fleetRemotes();
              await _pollOverview();
              if (mounted) setState(() {});
            },
          ),
        ]),
        children: [
          for (final p in pm2)
            ListTile(
              dense: true,
              leading: Icon(Icons.circle,
                  size: 10,
                  color: p['status'] == 'online' ? Colors.greenAccent : Colors.redAccent),
              title: Text('${p['name']}',
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 13)),
              trailing: Text(
                '${p['status']}  ·  ${p['cpu'] ?? '-'}%  ·  ${p['memory'] is num ? ((p['memory'] as num) / 1048576).toStringAsFixed(0) : '-'} MB  ·  ↻${p['restarts'] ?? 0}',
                style: const TextStyle(fontSize: 12, color: Colors.white54),
              ),
            ),
          for (final x in sites.where((x) => x['runtime'] == 'static'))
            ListTile(
              dense: true,
              leading: const Icon(Icons.web, size: 14, color: Colors.white38),
              title: Text('${x['name']}', style: const TextStyle(fontSize: 13)),
              trailing: Text('${x['status']} · :${x['port'] ?? '-'}',
                  style: const TextStyle(fontSize: 12, color: Colors.white54)),
            ),
        ],
      ),
    );
  }
}
