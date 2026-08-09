import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'api.dart';

/// Message Queue — a durable buffer between a producer and a consumer that
/// cannot keep up. The motivating loss: Node-RED drops PLC readings when its
/// in-memory buffer overflows ("Discarding queued 'read' item, max age 2000ms").
/// A producer that POSTs a message and gets a 201 has handed it to something on
/// disk, and the consumer takes it at its own pace.
///
/// HTTP only — no AMQP/MQTT. Everything here already speaks HTTP, and a broker
/// daemon to install and keep alive on four servers costs more than it buys.
class MqPage extends StatefulWidget {
  const MqPage({super.key});
  @override
  State<MqPage> createState() => _MqPageState();
}

class _MqPageState extends State<MqPage> {
  List<Map<String, dynamic>> _rows = [];
  bool _loading = true;
  bool _hasToken = false;
  String? _freshToken;
  Timer? _timer;
  final _newName = TextEditingController();

  @override
  void initState() {
    super.initState();
    _reload();
    if (Api.instance.isAdmin) {
      Api.instance.mqHasToken().then((v) {
        if (mounted) setState(() => _hasToken = v);
      });
    }
    _timer = Timer.periodic(const Duration(seconds: 4), (_) => _reload(silent: true));
  }

  @override
  void dispose() {
    _timer?.cancel();
    _newName.dispose();
    super.dispose();
  }

  Future<void> _reload({bool silent = false}) async {
    try {
      final r = await Api.instance.mqQueues();
      if (!mounted) return;
      setState(() {
        _rows = r;
        _loading = false;
      });
    } catch (_) {
      if (!silent && mounted) setState(() => _loading = false);
    }
  }

  void _toast(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m), duration: const Duration(seconds: 2)));
  }

  Future<void> _add() async {
    final name = _newName.text.trim();
    if (name.isEmpty) return;
    try {
      await Api.instance.createQueue({'name': name});
      _newName.clear();
      await _reload();
    } catch (e) {
      _toast('$e'.replaceFirst('Exception: ', ''));
    }
  }

  Future<bool> _confirm(String title, String body, String action) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text(title),
        content: Text(body),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('ยกเลิก')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: Text(action)),
        ],
      ),
    );
    return ok == true;
  }

  Future<void> _delete(Map<String, dynamic> q) async {
    final ready = (q['ready'] as num?)?.toInt() ?? 0;
    final ok = await _confirm(
      'ลบคิว "${q['name']}"?',
      ready > 0
          // Deleting a queue with a backlog throws away work nobody has done yet
          // — say the number out loud rather than let it vanish quietly.
          ? 'ยังมีข้อความค้างอยู่ $ready ข้อความ ลบคิวแล้วข้อความเหล่านี้จะหายไปด้วย กู้คืนไม่ได้'
          : 'ลบคิวและข้อความทั้งหมดในคิวนี้',
      'ลบ',
    );
    if (!ok) return;
    try {
      await Api.instance.deleteQueue(q['name'] as String);
      await _reload();
    } catch (e) {
      _toast('$e'.replaceFirst('Exception: ', ''));
    }
  }

  Future<void> _purge(Map<String, dynamic> q, String? state) async {
    final label = state ?? 'ทุกสถานะ';
    if (!await _confirm('ล้างข้อความในคิว "${q['name']}"?', 'ลบข้อความสถานะ $label ทิ้ง กู้คืนไม่ได้', 'ล้าง')) return;
    try {
      final n = await Api.instance.purgeQueue(q['name'] as String, state: state);
      _toast('ลบไป $n ข้อความ');
      await _reload();
    } catch (e) {
      _toast('$e'.replaceFirst('Exception: ', ''));
    }
  }

  Future<void> _requeue(Map<String, dynamic> q) async {
    try {
      final n = await Api.instance.requeueDead(q['name'] as String);
      _toast('ส่งกลับเข้าคิว $n ข้อความ');
      await _reload();
    } catch (e) {
      _toast('$e'.replaceFirst('Exception: ', ''));
    }
  }

  Future<void> _peek(Map<String, dynamic> q, String state) =>
      showDialog<void>(context: context, builder: (_) => _PeekDialog(name: q['name'] as String, state: state));

  Future<void> _settings(Map<String, dynamic> q) async {
    final ok = await showDialog<bool>(context: context, builder: (_) => _QueueSettingsDialog(queue: q));
    if (ok == true) _reload();
  }

  Future<void> _publish(Map<String, dynamic> q) async {
    final ok = await showDialog<bool>(context: context, builder: (_) => _PublishDialog(name: q['name'] as String));
    if (ok == true) _reload();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Message Queue (คิวข้อมูล)'),
        actions: [IconButton(onPressed: () => _reload(), icon: const Icon(Icons.refresh))],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(padding: const EdgeInsets.all(12), children: [
              _contractCard(),
              const SizedBox(height: 10),
              if (Api.instance.isAdmin) ...[_addCard(), const SizedBox(height: 10)],
              if (_rows.isEmpty)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 40),
                  child: Center(
                    child: Text('ยังไม่มีคิว — สร้างที่ช่องด้านบน หรือแค่ publish เข้าไป คิวจะถูกสร้างให้เอง',
                        style: TextStyle(color: Colors.white54)),
                  ),
                )
              else
                ..._rows.map(_queueCard),
              if (Api.instance.isAdmin) ...[const SizedBox(height: 16), _tokenCard()],
            ]),
    );
  }

  // The one thing a consumer author must know before writing any code.
  Widget _contractCard() {
    return Card(
      color: Colors.orangeAccent.withValues(alpha: 0.08),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Icon(Icons.info_outline, size: 18, color: Colors.orangeAccent),
          const SizedBox(width: 10),
          const Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('at-least-once — ข้อความอาจถูกส่งซ้ำได้',
                  style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
              SizedBox(height: 4),
              Text(
                'ถ้าผู้บริโภคดึงไปแล้วดับก่อน ack ข้อความจะกลับเข้าคิวและถูกส่งใหม่ (ไม่หาย) '
                'ผู้บริโภคจึงต้อง idempotent — ทำซ้ำแล้วผลต้องเหมือนเดิม '
                'และต้อง ack "หลัง" ประมวลผลเสร็จเท่านั้น ไม่ใช่ทันทีที่ดึงมา',
                style: TextStyle(fontSize: 11, height: 1.5),
              ),
            ]),
          ),
        ]),
      ),
    );
  }

  Widget _addCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
        child: Row(children: [
          Expanded(
            child: TextField(
              controller: _newName,
              onSubmitted: (_) => _add(),
              style: const TextStyle(fontSize: 13),
              decoration: const InputDecoration(
                isDense: true,
                labelText: 'สร้างคิวใหม่',
                hintText: 'plc-line1',
                helperText: 'ตัวอักษร/ตัวเลข . _ - เท่านั้น · จะถูกสร้างอัตโนมัติอยู่แล้วเมื่อมีคน publish เข้ามา',
                helperMaxLines: 2,
                border: OutlineInputBorder(),
              ),
            ),
          ),
          const SizedBox(width: 10),
          FilledButton.icon(onPressed: _add, icon: const Icon(Icons.add, size: 16), label: const Text('สร้าง')),
        ]),
      ),
    );
  }

  Widget _chip(String label, int n, Color color, {String? tooltip, VoidCallback? onTap}) {
    final w = Container(
      margin: const EdgeInsets.only(right: 8),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.15), borderRadius: BorderRadius.circular(999)),
      child: Text('$label $n', style: TextStyle(fontSize: 12, color: color, fontWeight: FontWeight.w600)),
    );
    final tapped = onTap == null ? w : InkWell(onTap: onTap, borderRadius: BorderRadius.circular(999), child: w);
    return tooltip == null ? tapped : Tooltip(message: tooltip, child: tapped);
  }

  String _age(dynamic sec) {
    final s = (sec is num) ? sec.toInt() : null;
    if (s == null) return '';
    if (s < 60) return '$s วินาที';
    if (s < 3600) return '${(s / 60).round()} นาที';
    if (s < 86400) return '${(s / 3600).round()} ชั่วโมง';
    return '${(s / 86400).round()} วัน';
  }

  Widget _queueCard(Map<String, dynamic> q) {
    final ready = (q['ready'] as num?)?.toInt() ?? 0;
    final delivered = (q['delivered'] as num?)?.toInt() ?? 0;
    final dead = (q['dead'] as num?)?.toInt() ?? 0;
    final age = q['oldest_ready_age'];
    // A backlog is only a problem when it is also OLD: 500 messages that arrived
    // this second is a burst, 5 messages sitting for an hour is a dead consumer.
    final stale = (age is num) && age > 300 && ready > 0;

    return Card(
      color: Colors.white.withValues(alpha: 0.03),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 10, 8, 10),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            const Icon(Icons.low_priority, size: 16),
            const SizedBox(width: 8),
            Text('${q['name']}', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
            const SizedBox(width: 10),
            Text('มองไม่เห็น ${q['visibility_timeout']}s · ลองสูงสุด ${q['max_attempts']} ครั้ง',
                style: const TextStyle(fontSize: 11, color: Colors.white38)),
            const Spacer(),
            if (Api.instance.isAdmin) ...[
              IconButton(
                tooltip: 'ส่งข้อความทดสอบ',
                icon: const Icon(Icons.send, size: 17),
                onPressed: () => _publish(q),
              ),
              IconButton(
                tooltip: 'ตั้งค่าคิว',
                icon: const Icon(Icons.tune, size: 17),
                onPressed: () => _settings(q),
              ),
              PopupMenuButton<String>(
                tooltip: 'จัดการ',
                icon: const Icon(Icons.more_vert, size: 17),
                onSelected: (v) {
                  if (v == 'requeue') _requeue(q);
                  if (v == 'purge-ready') _purge(q, 'ready');
                  if (v == 'purge-dead') _purge(q, 'dead');
                  if (v == 'delete') _delete(q);
                },
                itemBuilder: (_) => [
                  PopupMenuItem(
                    value: 'requeue',
                    enabled: dead > 0,
                    child: Text('ส่ง dead กลับเข้าคิว ($dead)'),
                  ),
                  const PopupMenuItem(value: 'purge-ready', child: Text('ล้างข้อความที่รออยู่')),
                  const PopupMenuItem(value: 'purge-dead', child: Text('ล้างกอง dead')),
                  const PopupMenuDivider(),
                  const PopupMenuItem(value: 'delete', child: Text('ลบคิวนี้')),
                ],
              ),
            ],
          ]),
          const SizedBox(height: 8),
          _flowRow(q),
          const SizedBox(height: 8),
          Row(children: [
            _chip('รออยู่', ready, ready == 0 ? Colors.white38 : Colors.greenAccent,
                tooltip: 'ยังไม่มีใครดึงไป — กดเพื่อดูข้อความ', onTap: () => _peek(q, 'ready')),
            _chip('กำลังทำ', delivered, delivered == 0 ? Colors.white38 : Colors.orangeAccent,
                tooltip: 'ถูกดึงไปแล้ว รอ ack — กดเพื่อดู', onTap: () => _peek(q, 'delivered')),
            _chip('dead', dead, dead == 0 ? Colors.white38 : Colors.redAccent,
                tooltip: 'ล้มเหลวจนครบจำนวนครั้งที่ลอง — กดเพื่อดูสาเหตุ', onTap: () => _peek(q, 'dead')),
            if (ready > 0 && age != null)
              Text('เก่าสุดค้างมา ${_age(age)}',
                  style: TextStyle(fontSize: 11, color: stale ? Colors.orangeAccent : Colors.white38)),
          ]),
          if (stale)
            const Padding(
              padding: EdgeInsets.only(top: 6),
              child: Text('ค้างนาน — ผู้บริโภคอาจหยุดทำงานหรือตามไม่ทัน',
                  style: TextStyle(fontSize: 11, color: Colors.orangeAccent)),
            ),
        ]),
      ),
    );
  }

  /// ต้นทาง → ปลายทาง on one line, the same shape the Gateway page uses.
  ///
  /// ต้นทาง is not a setting: it is wherever producers have to POST, which the
  /// queue's own port (or its API path) already determines. Showing it — and
  /// making it copyable — is the difference between "where do I point Node-RED"
  /// and reading the docs.
  Widget _flowRow(Map<String, dynamic> q) {
    final port = q['listen_port'];
    final origin = Api.instance.serverOrigin;
    // A queue's own port is a plain HTTP listener (mq.js startListener). The
    // panel itself may be served over https once the operator turns it on, and
    // inheriting that scheme here would hand producers an https:// URL that
    // fails the TLS handshake — so pin http:// for the queue port.
    final inbound = port == null
        ? '$origin/api/mq/q/${q['name']}'
        : 'http://${Uri.parse(origin).host}:${(port as num).toInt()}/';
    final forward = q['forward_url']?.toString() ?? '';
    final listening = q['listening'] == true;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.18),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          SizedBox(
            width: 74,
            child: Text('ต้นทาง', style: TextStyle(fontSize: 11, color: Colors.white54)),
          ),
          const Text('POST ', style: TextStyle(fontSize: 11, color: Colors.white38)),
          Flexible(
            child: SelectableText(inbound,
                maxLines: 1, style: const TextStyle(fontFamily: 'monospace', fontSize: 11)),
          ),
          IconButton(
            tooltip: 'copy',
            visualDensity: VisualDensity.compact,
            icon: const Icon(Icons.copy, size: 13),
            onPressed: () {
              Clipboard.setData(ClipboardData(text: inbound));
              _toast('copy แล้ว');
            },
          ),
          if (port != null)
            Tooltip(
              message: listening
                  ? 'พอร์ต $port เปิดอยู่'
                  : 'ตั้งพอร์ต $port ไว้ แต่เปิดไม่ได้ — ดู log ระบบ (พอร์ตอาจถูกใช้อยู่)',
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(Icons.circle, size: 8, color: listening ? Colors.greenAccent : Colors.redAccent),
                const SizedBox(width: 4),
                Text(listening ? 'พอร์ตของคิวเอง' : 'พอร์ตเปิดไม่ได้',
                    style: TextStyle(fontSize: 10, color: listening ? Colors.greenAccent : Colors.redAccent)),
              ]),
            )
          else
            const Text('ใช้พอร์ตเดียวกับ panel', style: TextStyle(fontSize: 10, color: Colors.white38)),
        ]),
        const Padding(
          padding: EdgeInsets.only(left: 74, top: 2, bottom: 2),
          child: Text('↓', style: TextStyle(fontSize: 11, color: Colors.white38)),
        ),
        Row(children: [
          SizedBox(
            width: 74,
            child: Text('ปลายทาง', style: TextStyle(fontSize: 11, color: Colors.white54)),
          ),
          Flexible(
            child: forward.isEmpty
                // No destination is a valid mode, not an error — say which mode
                // it is, so nobody sits waiting for a delivery that will never
                // come because nothing is polling.
                ? const Text('ยังไม่ตั้ง — โหมดให้ผู้รับดึงเอง (POST …/pull แล้ว …/ack)',
                    style: TextStyle(fontSize: 11, color: Colors.white38))
                : SelectableText('POST $forward',
                    maxLines: 1, style: const TextStyle(fontFamily: 'monospace', fontSize: 11)),
          ),
          if (forward.isNotEmpty)
            Text('  ตอบ 2xx = ack ให้เลย', style: TextStyle(fontSize: 10, color: Colors.white38)),
        ]),
      ]),
    );
  }

  Widget _tokenCard() {
    final origin = Api.instance.serverOrigin;
    return Card(
      color: Colors.white.withValues(alpha: 0.03),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            const Icon(Icons.vpn_key, size: 16),
            const SizedBox(width: 6),
            const Text('API token (ให้ Node-RED / สคริปต์ ใช้ยิงเข้าคิว)',
                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
            const Spacer(),
            Text(_hasToken ? 'มี token' : 'ยังไม่มี', style: const TextStyle(fontSize: 11, color: Colors.white54)),
          ]),
          const SizedBox(height: 4),
          const Text(
            'token นี้ publish/pull/ack ได้อย่างเดียว — เปิดดูข้อความ ล้างคิว หรือออก token ใหม่ไม่ได้ '
            '(ต้อง login จริงเท่านั้น) หลุดออกไปจึงเสียหายจำกัด',
            style: TextStyle(fontSize: 11, color: Colors.white54, height: 1.5),
          ),
          if (_freshToken != null) ...[
            const SizedBox(height: 8),
            Row(children: [
              Expanded(child: SelectableText(_freshToken!, style: const TextStyle(fontFamily: 'monospace', fontSize: 12))),
              IconButton(
                icon: const Icon(Icons.copy, size: 16),
                onPressed: () => Clipboard.setData(ClipboardData(text: _freshToken!)),
              ),
            ]),
            const Text('copy เก็บไว้ — ปิดหน้าแล้วไม่โชว์ซ้ำ', style: TextStyle(fontSize: 11, color: Colors.orangeAccent)),
          ],
          const SizedBox(height: 8),
          Row(children: [
            FilledButton.tonalIcon(
              onPressed: () async {
                try {
                  final t = await Api.instance.genMqToken();
                  setState(() {
                    _freshToken = t;
                    _hasToken = true;
                  });
                } catch (e) {
                  _toast('$e'.replaceFirst('Exception: ', ''));
                }
              },
              icon: const Icon(Icons.key, size: 15),
              label: Text(_hasToken ? 'สร้างใหม่' : 'สร้าง token'),
            ),
            const SizedBox(width: 8),
            if (_hasToken)
              OutlinedButton(
                onPressed: () async {
                  await Api.instance.revokeMqToken();
                  setState(() {
                    _hasToken = false;
                    _freshToken = null;
                  });
                },
                child: const Text('เพิกถอน'),
              ),
          ]),
          const Divider(height: 24),
          const Text('ตัวอย่างการใช้', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12)),
          const SizedBox(height: 6),
          _code('# ส่งเข้าคิว (producer เช่น Node-RED)\n'
              'curl -X POST $origin/api/mq/q/plc-line1 \\\n'
              '  -H "x-api-token: mqt_xxx" -H "Content-Type: application/json" \\\n'
              '  -d \'{"body":{"tag":"temp","v":72.4}}\'\n\n'
              '# ถ้าคิวตั้ง "พอร์ตของคิวเอง" ไว้ ยิงสั้นๆ แบบนี้ได้เลย\n'
              '# curl -X POST http://<server>:12001/ -d \'{"tag":"temp","v":72.4}\'\n\n'
              '# ---- ข้างล่างนี้ใช้เฉพาะโหมด "ให้ผู้รับดึงเอง" ----\n'
              '# ถ้าตั้ง "ปลายทาง" ไว้แล้ว ไม่ต้องเขียน pull/ack เอง\n'
              '# คิวจะ POST ไปให้ปลายทางเอง และถือว่าตอบ 2xx = ack\n\n'
              '# ดึงไปทำ (consumer) — ได้ ack token มาด้วย\n'
              'curl -X POST $origin/api/mq/q/plc-line1/pull \\\n'
              '  -H "x-api-token: mqt_xxx" -H "Content-Type: application/json" \\\n'
              '  -d \'{"max":10}\'\n\n'
              '# ทำเสร็จแล้วค่อย ack (ถ้าไม่ ack ข้อความจะกลับเข้าคิว)\n'
              'curl -X POST $origin/api/mq/q/plc-line1/ack \\\n'
              '  -H "x-api-token: mqt_xxx" -H "Content-Type: application/json" \\\n'
              '  -d \'{"id":12,"ack":"<ack ที่ได้จาก pull>"}\'\n\n'
              '# ทำไม่สำเร็จ ให้ส่งกลับเข้าคิวเพื่อลองใหม่\n'
              'curl -X POST $origin/api/mq/q/plc-line1/nack \\\n'
              '  -H "x-api-token: mqt_xxx" -H "Content-Type: application/json" \\\n'
              '  -d \'{"id":12,"ack":"...","delay_s":30,"error":"parse ไม่ผ่าน"}\''),
        ]),
      ),
    );
  }

  Widget _code(String text) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(color: Colors.black.withValues(alpha: 0.3), borderRadius: BorderRadius.circular(6)),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(
          child: SelectableText(text, style: const TextStyle(fontFamily: 'monospace', fontSize: 11, height: 1.5)),
        ),
        IconButton(
          tooltip: 'copy',
          icon: const Icon(Icons.copy, size: 14),
          onPressed: () => Clipboard.setData(ClipboardData(text: text)),
        ),
      ]),
    );
  }
}

// ---------------- dialogs ----------------

/// Read messages without claiming them. Bodies come back truncated to 500 chars
/// — this is "what is stuck in here", not a data browser.
class _PeekDialog extends StatefulWidget {
  final String name;
  final String state;
  const _PeekDialog({required this.name, required this.state});
  @override
  State<_PeekDialog> createState() => _PeekDialogState();
}

class _PeekDialogState extends State<_PeekDialog> {
  late String _state = widget.state;
  bool _busy = true;
  String? _error;
  List<Map<String, dynamic>> _rows = [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final r = await Api.instance.peekQueue(widget.name, state: _state, limit: 50);
      if (!mounted) return;
      setState(() {
        _rows = r;
        _busy = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e'.replaceFirst('Exception: ', '');
        _busy = false;
      });
    }
  }

  String _time(dynamic ms) {
    final n = (ms is num) ? ms.toInt() : 0;
    if (n == 0) return '';
    final d = DateTime.fromMillisecondsSinceEpoch(n);
    String two(int v) => v.toString().padLeft(2, '0');
    return '${two(d.day)}/${two(d.month)} ${two(d.hour)}:${two(d.minute)}:${two(d.second)}';
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Row(children: [
        Expanded(child: Text('ดูข้อความ · ${widget.name}', overflow: TextOverflow.ellipsis)),
        DropdownButton<String>(
          value: _state,
          underline: const SizedBox.shrink(),
          items: const [
            DropdownMenuItem(value: 'ready', child: Text('รออยู่')),
            DropdownMenuItem(value: 'delivered', child: Text('กำลังทำ')),
            DropdownMenuItem(value: 'dead', child: Text('dead')),
          ],
          onChanged: _busy
              ? null
              : (v) {
                  if (v == null) return;
                  setState(() => _state = v);
                  _load();
                },
        ),
      ]),
      content: SizedBox(
        width: 640,
        height: 440,
        child: _busy
            ? const Center(child: CircularProgressIndicator())
            : _error != null
                ? Center(child: Text(_error!, style: const TextStyle(color: Colors.redAccent)))
                : _rows.isEmpty
                    ? const Center(child: Text('ไม่มีข้อความในสถานะนี้', style: TextStyle(color: Colors.white54)))
                    : ListView.separated(
                        itemCount: _rows.length,
                        separatorBuilder: (_, __) => const Divider(height: 12),
                        itemBuilder: (_, i) {
                          final m = _rows[i];
                          final err = m['last_error']?.toString();
                          return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Row(children: [
                              Text('#${m['id']}',
                                  style: const TextStyle(fontFamily: 'monospace', fontSize: 12, fontWeight: FontWeight.bold)),
                              const SizedBox(width: 10),
                              Text('ส่งเข้ามา ${_time(m['created_at'])}',
                                  style: const TextStyle(fontSize: 11, color: Colors.white54)),
                              const SizedBox(width: 10),
                              Text('ลองไป ${m['attempts']} ครั้ง',
                                  style: TextStyle(
                                      fontSize: 11,
                                      color: (m['attempts'] as num? ?? 0) > 1 ? Colors.orangeAccent : Colors.white54)),
                              if (m['truncated'] == true) ...[
                                const SizedBox(width: 10),
                                Text('(ตัดแสดง จาก ${m['body_len']} ตัวอักษร)',
                                    style: const TextStyle(fontSize: 11, color: Colors.white38)),
                              ],
                            ]),
                            const SizedBox(height: 4),
                            SelectableText('${m['body']}',
                                style: const TextStyle(fontFamily: 'monospace', fontSize: 11, height: 1.4)),
                            if (err != null && err.isNotEmpty)
                              Padding(
                                padding: const EdgeInsets.only(top: 4),
                                child: Text('สาเหตุล่าสุด: $err',
                                    style: const TextStyle(fontSize: 11, color: Colors.redAccent)),
                              ),
                          ]);
                        },
                      ),
      ),
      actions: [
        TextButton(onPressed: _busy ? null : _load, child: const Text('รีเฟรช')),
        FilledButton(onPressed: () => Navigator.pop(context), child: const Text('ปิด')),
      ],
    );
  }
}

class _QueueSettingsDialog extends StatefulWidget {
  final Map<String, dynamic> queue;
  const _QueueSettingsDialog({required this.queue});
  @override
  State<_QueueSettingsDialog> createState() => _QueueSettingsDialogState();
}

class _QueueSettingsDialogState extends State<_QueueSettingsDialog> {
  late final _vis = TextEditingController(text: '${widget.queue['visibility_timeout']}');
  late final _max = TextEditingController(text: '${widget.queue['max_attempts']}');
  late final _forward = TextEditingController(text: widget.queue['forward_url']?.toString() ?? '');
  late final _timeout = TextEditingController(text: '${widget.queue['forward_timeout_ms'] ?? 15000}');
  late final _headers = TextEditingController(text: widget.queue['forward_headers']?.toString() ?? '');
  late final _port = TextEditingController(text: widget.queue['listen_port']?.toString() ?? '');
  late bool _listenAuth = widget.queue['listen_auth'] != false;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _vis.dispose();
    _max.dispose();
    _forward.dispose();
    _timeout.dispose();
    _headers.dispose();
    _port.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final port = _port.text.trim();
      await Api.instance.updateQueue(widget.queue['name'] as String, {
        'visibility_timeout': int.tryParse(_vis.text.trim()),
        'max_attempts': int.tryParse(_max.text.trim()),
        'forward_url': _forward.text.trim(),
        'forward_timeout_ms': int.tryParse(_timeout.text.trim()),
        // Send null, not '', so clearing the box actually clears the column.
        'forward_headers': _headers.text.trim().isEmpty ? null : _headers.text.trim(),
        'listen_port': port.isEmpty ? null : int.tryParse(port),
        'listen_auth': _listenAuth,
      });
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
      title: Text('ตั้งค่าคิว · ${widget.queue['name']}'),
      content: SizedBox(
        width: 520,
        child: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
          // ---- ต้นทาง ----
          const Align(
            alignment: Alignment.centerLeft,
            child: Text('ต้นทาง — ที่ให้ผู้ส่งยิงเข้ามา',
                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
          ),
          const SizedBox(height: 8),
          TextField(
            controller: _port,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(
              labelText: 'พอร์ตของคิวนี้เอง (เว้นว่าง = ใช้พอร์ตเดียวกับ panel)',
              hintText: '12001',
              helperText: 'ตั้งแล้วผู้ส่งยิงมาที่ http://<server>:<พอร์ต>/ ตรงๆ ไม่ต้องผ่าน path ของ panel · '
                  'หมายเหตุ: แยกแค่ "ที่อยู่" ไม่ได้แยกภาระเครื่อง — ยังเป็นโปรเซสเดียวกับ panel',
              helperMaxLines: 3,
            ),
          ),
          CheckboxListTile(
            dense: true,
            contentPadding: EdgeInsets.zero,
            controlAffinity: ListTileControlAffinity.leading,
            value: _listenAuth,
            title: const Text('พอร์ตนี้ต้องส่ง x-api-token', style: TextStyle(fontSize: 13)),
            subtitle: const Text('ปิดได้เฉพาะกรณีอุปกรณ์ส่ง header ไม่ได้ — แล้วต้องล็อกพอร์ตนี้ที่ firewall แทน',
                style: TextStyle(fontSize: 11)),
            onChanged: (v) => setState(() => _listenAuth = v ?? true),
          ),
          const Divider(height: 22),
          // ---- ปลายทาง ----
          const Align(
            alignment: Alignment.centerLeft,
            child: Text('ปลายทาง — ให้คิวยิงต่อไปเอง',
                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
          ),
          const SizedBox(height: 8),
          TextField(
            controller: _forward,
            decoration: const InputDecoration(
              labelText: 'URL ปลายทาง (เว้นว่าง = ให้ผู้รับดึงเอง)',
              hintText: 'http://127.0.0.1:12000/testqueue',
              helperText: 'คิวจะ POST ข้อความไปให้ทีละข้อความตามลำดับ · ปลายทางตอบ 2xx = ack ให้เลย '
                  'ตอบอย่างอื่นหรือไม่ตอบ = เก็บไว้ลองใหม่ (ห่างขึ้นเรื่อยๆ) จนครบจำนวนครั้งแล้วเข้ากอง dead',
              helperMaxLines: 3,
            ),
          ),
          const SizedBox(height: 12),
          Row(children: [
            Expanded(
              child: TextField(
                controller: _timeout,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(
                  labelText: 'รอปลายทางกี่ ms',
                  helperText: '1000-120000',
                ),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              flex: 2,
              child: TextField(
                controller: _headers,
                style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
                decoration: const InputDecoration(
                  labelText: 'header เพิ่มเติม (JSON, ไม่ใส่ก็ได้)',
                  hintText: '{"x-api-key":"..."}',
                ),
              ),
            ),
          ]),
          const Divider(height: 22),
          const Align(
            alignment: Alignment.centerLeft,
            child: Text('การลองใหม่', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
          ),
          const SizedBox(height: 8),
          TextField(
            controller: _vis,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(
              labelText: 'ระยะเวลามองไม่เห็น (วินาที)',
              helperText: 'หลังถูกดึงไป ข้อความจะถูกซ่อนไว้เท่านี้ ถ้ายังไม่ ack จะกลับเข้าคิว — '
                  'ตั้งให้ยาวกว่าเวลาประมวลผลจริง ไม่งั้นจะถูกส่งซ้ำทั้งที่ยังทำอยู่',
              helperMaxLines: 3,
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _max,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(
              labelText: 'ลองสูงสุดกี่ครั้ง',
              helperText: 'ครบแล้วย้ายไปกอง dead แทนที่จะวนลองไม่จบ',
              helperMaxLines: 2,
            ),
          ),
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

/// Publish by hand — lets an operator prove the consumer end works without
/// waiting for the PLC to produce something.
class _PublishDialog extends StatefulWidget {
  final String name;
  const _PublishDialog({required this.name});
  @override
  State<_PublishDialog> createState() => _PublishDialogState();
}

class _PublishDialogState extends State<_PublishDialog> {
  final _body = TextEditingController(text: '{"test": true}');
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _body.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await Api.instance.publishMessage(widget.name, _body.text);
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
      title: Text('ส่งข้อความทดสอบ · ${widget.name}'),
      content: SizedBox(
        width: 460,
        child: TextField(
          controller: _body,
          maxLines: 6,
          style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
          decoration: InputDecoration(
            labelText: 'เนื้อข้อความ',
            helperText: 'ส่งเป็นข้อความดิบ — ผู้บริโภคจะได้ตัวอักษรชุดนี้ตรงๆ',
            errorText: _error,
            errorMaxLines: 3,
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: _busy ? null : () => Navigator.pop(context, false), child: const Text('ยกเลิก')),
        FilledButton(
          onPressed: _busy ? null : _send,
          child: _busy
              ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
              : const Text('ส่ง'),
        ),
      ],
    );
  }
}
