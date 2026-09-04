import 'dart:async';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'api.dart';
import 'download.dart';
import 'timefmt.dart';

/// Uptime monitoring — watches anything worth watching (URL / TCP port /
/// database login), not only sites this manager deploys. The motivating bug: a
/// database can keep its TCP port open while rejecting every login, so a plain
/// port check reports green on something nothing can actually use — the
/// mssql/postgres/mongodb monitor types log in and run a real query instead.

// ---------------- theme ----------------

/// One look for this page. The rest of the panel is fixed dark, but a monitor
/// wall is the one screen people leave open all day — on a bright factory floor
/// the dark theme washes out, at night the bright one is glare. So this page
/// carries its own palette instead of inheriting the app's.
///
/// Status colours live here rather than being read off the ColorScheme: "up" and
/// "down" are semantic, ColorScheme has no slot for them, and `greenAccent` on a
/// white card is nearly unreadable — each palette picks its own.
class MonPalette {
  final String key;
  final String label;
  final IconData icon;
  final ThemeData theme;
  final Color card;
  final Color up;
  final Color down;
  final Color warn;
  final Color info;

  const MonPalette({
    required this.key,
    required this.label,
    required this.icon,
    required this.theme,
    required this.card,
    required this.up,
    required this.down,
    required this.warn,
    required this.info,
  });

  /// Text that should recede (labels, timestamps). Alpha over onSurface follows
  /// the surface both ways, so one call works in every palette.
  Color muted([double alpha = 0.55]) => theme.colorScheme.onSurface.withValues(alpha: alpha);

  /// Neither up nor down — disabled, or never checked yet.
  Color get idle => muted(0.30);
}

MonPalette _palette({
  required String key,
  required String label,
  required IconData icon,
  required Brightness brightness,
  required Color seed,
  required Color background,
  required Color card,
  required Color up,
  required Color down,
  required Color warn,
  required Color info,
}) {
  return MonPalette(
    key: key,
    label: label,
    icon: icon,
    card: card,
    up: up,
    down: down,
    warn: warn,
    info: info,
    theme: ThemeData(
      useMaterial3: true,
      colorScheme: ColorScheme.fromSeed(seedColor: seed, brightness: brightness),
      scaffoldBackgroundColor: background,
    ),
  );
}

final List<MonPalette> monitorPalettes = [
  _palette(
    key: 'light',
    label: 'สว่าง',
    icon: Icons.light_mode,
    brightness: Brightness.light,
    seed: const Color(0xFF2563EB),
    background: const Color(0xFFF1F5F9),
    card: Colors.white,
    // Darker, fully saturated status colours — the accent shades used on the
    // dark palettes disappear against white.
    up: const Color(0xFF15803D),
    down: const Color(0xFFDC2626),
    warn: const Color(0xFFB45309),
    info: const Color(0xFF1D4ED8),
  ),
  _palette(
    key: 'dusk',
    label: 'พลบค่ำ',
    icon: Icons.wb_twilight,
    brightness: Brightness.dark,
    seed: const Color(0xFFC084FC),
    background: const Color(0xFF2B2440),
    card: const Color(0x14FFFFFF),
    up: const Color(0xFF4ADE80),
    down: const Color(0xFFFB7185),
    warn: const Color(0xFFFBBF24),
    info: const Color(0xFF93C5FD),
  ),
  _palette(
    key: 'night',
    label: 'กลางคืน',
    icon: Icons.dark_mode,
    brightness: Brightness.dark,
    seed: const Color(0xFF2563EB),
    background: const Color(0xFF0F172A),
    card: const Color(0x08FFFFFF),
    up: Colors.greenAccent,
    down: Colors.redAccent,
    warn: Colors.orangeAccent,
    info: Colors.lightBlueAccent,
  ),
];

/// Default = the app's own look, so nothing changes until it is asked to.
MonPalette get _defaultPalette => monitorPalettes.last;

MonPalette paletteByKey(String? key) =>
    monitorPalettes.firstWhere((p) => p.key == key, orElse: () => _defaultPalette);

/// Carries the palette down the tree. Extends [InheritedTheme] rather than plain
/// [InheritedWidget] on purpose: dialogs live on their own route, and only
/// InheritedTheme subclasses are copied across that boundary by `showDialog`
/// (via `InheritedTheme.capture`). A plain InheritedWidget would resolve to the
/// default inside every dialog.
class MonitorThemeScope extends InheritedTheme {
  final MonPalette palette;
  const MonitorThemeScope({super.key, required this.palette, required super.child});

  static MonPalette of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<MonitorThemeScope>()?.palette ?? _defaultPalette;

  @override
  bool updateShouldNotify(MonitorThemeScope old) => old.palette != palette;

  @override
  Widget wrap(BuildContext context, Widget child) =>
      MonitorThemeScope(palette: palette, child: child);
}

// ---------------- page ----------------

/// Thin shell: owns the palette choice only, so everything below it — including
/// dialogs opened from it — builds under the chosen theme.
class MonitorPage extends StatefulWidget {
  const MonitorPage({super.key});
  @override
  State<MonitorPage> createState() => _MonitorPageState();
}

class _MonitorPageState extends State<MonitorPage> {
  late MonPalette _p = paletteByKey(Api.instance.cfg['monitor_theme']?.toString());

  Future<void> _pick(MonPalette p) async {
    setState(() => _p = p);
    // Same per-browser store the rest of the panel uses for its preferences.
    await Api.instance.saveCfg({'monitor_theme': p.key});
  }

  @override
  Widget build(BuildContext context) {
    return MonitorThemeScope(
      palette: _p,
      // AnimatedTheme cross-fades every colour in the ThemeData instead of
      // snapping — switching สว่าง↔พลบค่ำ↔กลางคืน on a screen someone is staring
      // at should not feel like the lights being flicked.
      child: AnimatedTheme(
        data: _p.theme,
        duration: const Duration(milliseconds: 350),
        child: _MonitorView(palette: _p, onPickPalette: _pick),
      ),
    );
  }
}

class _MonitorView extends StatefulWidget {
  final MonPalette palette;
  final ValueChanged<MonPalette> onPickPalette;
  const _MonitorView({required this.palette, required this.onPickPalette});
  @override
  State<_MonitorView> createState() => _MonitorViewState();
}

class _MonitorViewState extends State<_MonitorView> with SingleTickerProviderStateMixin {
  List<Map<String, dynamic>> _rows = [];
  bool _loading = true;
  Timer? _timer;
  bool _publicOn = false;
  int _publicCount = 0;

  // ONE controller drives every pulse on the page. A wall of forty monitors with
  // a controller each would keep forty tickers running; this keeps one, and the
  // pulses stay in step with each other, which reads as deliberate rather than
  // as forty things twitching independently.
  late final AnimationController _pulse;

  // Newest beat timestamp per monitor, so a bar that has just gained a beat can
  // animate that one in and leave the rest alone.
  final Map<int, int> _lastBeatTs = {};

  MonPalette get _p => widget.palette;

  @override
  void initState() {
    super.initState();
    _pulse = AnimationController(vsync: this, duration: const Duration(milliseconds: 1400))..repeat();
    _reload();
    if (Api.instance.isAdmin) _loadPublic();
    _timer = Timer.periodic(const Duration(seconds: 8), (_) => _reload(silent: true));
  }

  @override
  void dispose() {
    _timer?.cancel();
    _pulse.dispose();
    super.dispose();
  }

  Future<void> _reload({bool silent = false}) async {
    try {
      final r = await Api.instance.monitors();
      if (!mounted) return;
      setState(() {
        _rows = r;
        _loading = false;
      });
    } catch (_) {
      if (!silent && mounted) setState(() => _loading = false);
    }
  }

  Future<void> _loadPublic() async {
    try {
      final r = await Api.instance.publicPageStatus();
      if (!mounted) return;
      setState(() {
        _publicOn = r['enabled'] == true;
        _publicCount = (r['count'] as num?)?.toInt() ?? 0;
      });
    } catch (_) {/* non-fatal — the card just stays as-is */}
  }

  Future<void> _togglePublic(bool on) async {
    try {
      await Api.instance.setPublicPage(on);
      await _loadPublic();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(on ? 'เปิดหน้าสถานะสาธารณะแล้ว — /status' : 'ปิดหน้าสถานะสาธารณะแล้ว'),
        ));
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('เปลี่ยนไม่สำเร็จ: $e')));
    }
  }

  void _openStatusPage() {
    // Same origin as the panel — the status page is served by this backend at
    // /status, so it works over whichever host/port the operator reached us on.
    launchUrl(Uri.parse('${Api.instance.serverOrigin}/status'), webOnlyWindowName: '_blank');
  }

  Future<void> _setAllPublic(bool on) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text(on ? 'แสดงทุก monitor บนหน้าสาธารณะ?' : 'ซ่อนทุก monitor จากหน้าสาธารณะ?'),
        content: Text(on
            ? 'ติ๊ก "แสดงบนหน้าสถานะสาธารณะ" ให้ทุกตัวพร้อมกัน — หน้า /status จะโชว์ชื่อ สถานะ และ uptime '
              'ของทุก monitor (ยังไม่โชว์ host/port/รหัส/SQL)'
            : 'เอาทุกตัวออกจากหน้า /status'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('ยกเลิก')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: Text(on ? 'แสดงทั้งหมด' : 'ซ่อนทั้งหมด')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      final r = await Api.instance.setAllPublic(on);
      await _loadPublic();
      _reload();
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('ปรับ ${r['changed']} รายการแล้ว')));
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('ไม่สำเร็จ: $e')));
    }
  }

  Widget _publicCard() {
    return Card(
      color: _p.card,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 8, 8, 8),
        child: Row(children: [
          Icon(_publicOn ? Icons.public : Icons.public_off,
              size: 20, color: _publicOn ? _p.up : _p.muted(0.40)),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Text('หน้าสถานะสาธารณะ (ดูได้โดยไม่ต้อง login)',
                  style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
              Text(
                _publicOn
                    ? 'เปิดอยู่ที่ /status · แสดง $_publicCount รายการที่ติ๊กไว้ (โชว์แค่ชื่อ/สถานะ/uptime)'
                    : 'ปิดอยู่ — เปิดแล้วใครก็ตามที่เข้าถึงพอร์ตนี้ได้จะเห็นหน้า /status',
                style: TextStyle(fontSize: 11, color: _p.muted()),
              ),
            ]),
          ),
          if (_publicOn)
            IconButton(
              tooltip: 'เปิดหน้า /status',
              icon: const Icon(Icons.open_in_new, size: 20),
              onPressed: _openStatusPage,
            ),
          PopupMenuButton<String>(
            tooltip: 'ตั้งค่าเป็นชุด',
            icon: const Icon(Icons.checklist, size: 20),
            onSelected: (v) => _setAllPublic(v == 'all'),
            itemBuilder: (_) => const [
              PopupMenuItem(value: 'all', child: Text('แสดงทุกตัวบนหน้าสาธารณะ')),
              PopupMenuItem(value: 'none', child: Text('ซ่อนทุกตัว')),
            ],
          ),
          Switch(value: _publicOn, onChanged: _togglePublic),
        ]),
      ),
    );
  }

  Future<void> _edit([Map<String, dynamic>? m]) async {
    final ok = await showDialog<bool>(context: context, builder: (_) => MonitorDialog(monitor: m));
    if (ok == true) _reload();
  }

  Future<void> _report(Map<String, dynamic> m) =>
      showDialog<void>(context: context, builder: (_) => MonitorReportDialog(monitor: m));

  Future<void> _delete(Map<String, dynamic> m) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text('ลบ "${m['name']}"?'),
        content: const Text('ลบเฉพาะ monitor และประวัติของมัน — ไม่กระทบเป้าหมายที่เฝ้าดูอยู่'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('ยกเลิก')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('ลบ')),
        ],
      ),
    );
    if (ok == true) {
      await Api.instance.deleteMonitor(m['id'] as int);
      _reload();
    }
  }

  Future<void> _runNow(Map<String, dynamic> m) async {
    try {
      await Api.instance.runMonitor(m['id'] as int);
      _reload();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('เช็คไม่สำเร็จ: $e')));
    }
  }

  Future<void> _fromSites() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('สร้าง monitor จาก sites ทั้งหมด'),
        content: const Text('สร้าง HTTP monitor ให้ทุก site ที่มี direct port และยังไม่มี monitor — '
            'กดซ้ำได้ ไม่สร้างซ้ำของเดิม'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('ยกเลิก')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('สร้าง')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      final r = await Api.instance.monitorsFromSites();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('สร้างใหม่ ${r['created']} ตัว (มีอยู่แล้ว ${r['skipped']} ตัว)')));
      }
      _reload();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('สร้างไม่สำเร็จ: $e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Monitor (เฝ้าดูสถานะ)'),
        actions: [
          PopupMenuButton<MonPalette>(
            tooltip: 'ธีมของหน้านี้',
            icon: Icon(_p.icon),
            onSelected: widget.onPickPalette,
            itemBuilder: (_) => [
              for (final p in monitorPalettes)
                PopupMenuItem(
                  value: p,
                  child: Row(children: [
                    Icon(p.icon, size: 18),
                    const SizedBox(width: 10),
                    Text(p.label),
                    if (p.key == _p.key) ...[
                      const SizedBox(width: 8),
                      const Icon(Icons.check, size: 16),
                    ],
                  ]),
                ),
            ],
          ),
          if (Api.instance.isAdmin)
            IconButton(tooltip: 'สร้างจาก sites', onPressed: _fromSites, icon: const Icon(Icons.auto_awesome)),
          IconButton(onPressed: () => _reload(), icon: const Icon(Icons.refresh)),
        ],
      ),
      floatingActionButton: Api.instance.isAdmin
          ? FloatingActionButton.extended(
              onPressed: () => _edit(),
              icon: const Icon(Icons.add),
              label: const Text('เพิ่ม monitor'),
            )
          : null,
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _rows.isEmpty
              ? Center(
                  child: Text('ยังไม่มี monitor — กด "เพิ่ม monitor" หรือ "สร้างจาก sites"',
                      style: TextStyle(color: _p.muted())),
                )
              : ListView(padding: const EdgeInsets.all(12), children: [
                  if (Api.instance.isAdmin) ...[_publicCard(), const SizedBox(height: 8)],
                  ..._rows.map(_card),
                ]),
    );
  }

  Color _statusColor(dynamic up) {
    if (up == true) return _p.up;
    if (up == false) return _p.down;
    return _p.idle; // null = disabled or never checked
  }

  String _target(Map<String, dynamic> m) =>
      m['type'] == 'http' ? '${m['url']}' : '${m['host']}:${m['port']}';

  Widget _uptimeChip(String label, dynamic pct) {
    final v = (pct is num) ? pct.toDouble() : null;
    final color = v == null ? _p.idle : (v >= 99 ? _p.up : (v >= 95 ? _p.warn : _p.down));
    return Padding(
      padding: const EdgeInsets.only(right: 10),
      child: Text('$label ${v == null ? '—' : '$v%'}', style: TextStyle(fontSize: 11, color: color)),
    );
  }

  Widget _heartbeatBar(int id, List beats) {
    if (beats.isEmpty) {
      return Text('ยังไม่มีประวัติ', style: TextStyle(fontSize: 11, color: _p.idle));
    }
    final list = beats.cast<Map<String, dynamic>>();
    final newestTs = (list.last['ts'] as num?)?.toInt() ?? 0;
    // Animate only the beat that was not there a moment ago. Replaying the whole
    // bar on every 8s poll would make a still-healthy monitor look like it was
    // constantly changing.
    final isNew = _lastBeatTs[id] != null && _lastBeatTs[id] != newestTs;
    _lastBeatTs[id] = newestTs;

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final b in list)
          Tooltip(
            message: '${localTime(_msToDbUtc(b['ts']))}\n'
                '${b['ok'] == 1 ? '${b['ms'] ?? '?'} ms' : (b['error'] ?? 'down')}',
            child: _Beat(
              key: ValueKey('$id-${b['ts']}'),
              color: b['ok'] == 1 ? _p.up : _p.down,
              animateIn: isNew && (b['ts'] as num?)?.toInt() == newestTs,
            ),
          ),
      ],
    );
  }

  /// "ทุก 60s" for an interval monitor, "ทุกวัน 00:30" for a scheduled one —
  /// a daily monitor's interval_sec is meaningless and showing it misleads.
  String _cadence(Map<String, dynamic> m) {
    final at = m['daily_at']?.toString() ?? '';
    return at.isEmpty ? 'ทุก ${m['interval_sec']}s' : 'ทุกวัน $at น.';
  }

  Widget _card(Map<String, dynamic> m) {
    final enabled = m['enabled'] == true;
    final up = enabled ? m['up'] : null;
    final err = m['error']?.toString();
    final uptime = (m['uptime'] as Map?) ?? {};
    final beats = (m['beats'] as List?) ?? [];
    return AnimatedContainer(
      duration: const Duration(milliseconds: 400),
      curve: Curves.easeOut,
      margin: const EdgeInsets.symmetric(vertical: 4),
      decoration: BoxDecoration(
        // A down monitor keeps a faint red wash so the row itself reads as the
        // problem, not just the icon on its left.
        color: enabled && up == false ? Color.alphaBlend(_p.down.withValues(alpha: 0.10), _p.card) : _p.card,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: enabled && up == false ? _p.down.withValues(alpha: 0.45) : Colors.transparent,
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
        child: ListTile(
          // Only a DOWN monitor pulses. If everything moved, movement would stop
          // meaning anything — the point is that the eye lands on the problem
          // when the page is glanced at from across a room.
          leading: _StatusDot(
            icon: !enabled
                ? Icons.pause_circle
                : (up == true ? Icons.check_circle : (up == false ? Icons.error : Icons.help_outline)),
            color: _statusColor(up),
            pulse: enabled && up == false ? _pulse : null,
          ),
          title: Row(children: [
            Text('${m['name']}', style: const TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(width: 8),
            Text('[${m['type']}]', style: TextStyle(fontSize: 11, color: _p.muted(0.45))),
            if ((m['daily_at']?.toString() ?? '').isNotEmpty) ...[
              const SizedBox(width: 6),
              Tooltip(
                message: 'รันวันละครั้ง ${m['daily_at']} น.',
                child: Icon(Icons.schedule, size: 13, color: _p.muted(0.45)),
              ),
            ],
            if (m['public'] == true) ...[
              const SizedBox(width: 6),
              Tooltip(
                message: 'แสดงบนหน้าสถานะสาธารณะ',
                child: Icon(Icons.public, size: 13, color: _p.info),
              ),
            ],
            if (up == true && m['ms'] != null) ...[
              const SizedBox(width: 8),
              Text('${m['ms']} ms', style: TextStyle(fontSize: 11, color: _p.muted(0.45))),
            ],
          ]),
          subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(_target(m), style: TextStyle(fontFamily: 'monospace', fontSize: 11, color: _p.muted(0.70))),
            if (!enabled)
              Text('ปิดใช้งาน', style: TextStyle(fontSize: 11, color: _p.muted(0.45)))
            else if (up == false && err != null && err.isNotEmpty)
              Text(err, style: TextStyle(fontSize: 11, color: _p.down)),
            const SizedBox(height: 6),
            Row(children: [
              _uptimeChip('24h', uptime['d1']),
              _uptimeChip('7d', uptime['d7']),
              _uptimeChip('30d', uptime['d30']),
            ]),
            const SizedBox(height: 4),
            _heartbeatBar(m['id'] as int, beats),
            if (m['checkedAt'] != null)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text('ตรวจล่าสุด ${localTime(_msToDbUtc(m['checkedAt']))} · ${_cadence(m)}',
                    style: TextStyle(fontSize: 10, color: _p.muted(0.35))),
              ),
          ]),
          isThreeLine: true,
          trailing: Wrap(spacing: 2, children: [
            IconButton(
              tooltip: 'รายงานย้อนหลัง',
              icon: const Icon(Icons.assessment_outlined, size: 18),
              onPressed: () => _report(m),
            ),
            if (Api.instance.isAdmin) ...[
              IconButton(tooltip: 'เช็คตอนนี้', icon: const Icon(Icons.refresh, size: 18), onPressed: () => _runNow(m)),
              IconButton(tooltip: 'แก้ไข', icon: const Icon(Icons.edit, size: 18), onPressed: () => _edit(m)),
              IconButton(tooltip: 'ลบ', icon: const Icon(Icons.delete_outline, size: 18), onPressed: () => _delete(m)),
            ],
          ]),
        ),
      ),
    );
  }
}

/// One bar of the heartbeat strip. A bar that has just arrived grows up from the
/// baseline and fades in; the ones already there are built as plain boxes, so a
/// steady monitor costs nothing to render.
class _Beat extends StatefulWidget {
  final Color color;
  final bool animateIn;
  const _Beat({super.key, required this.color, required this.animateIn});
  @override
  State<_Beat> createState() => _BeatState();
}

class _BeatState extends State<_Beat> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 420),
    // Nothing to play for a bar that was already on screen — start finished.
    value: widget.animateIn ? 0 : 1,
  );

  @override
  void initState() {
    super.initState();
    if (widget.animateIn) _c.forward();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_c.isCompleted) return _bar(1, 1);
    return AnimatedBuilder(
      animation: _c,
      builder: (_, __) {
        final t = Curves.easeOutBack.transform(_c.value.clamp(0.0, 1.0));
        return _bar(t.clamp(0.0, 1.0), _c.value);
      },
    );
  }

  Widget _bar(double scale, double opacity) => SizedBox(
        width: 8,
        height: 18,
        child: Center(
          child: Opacity(
            opacity: opacity.clamp(0.0, 1.0),
            child: Container(
              width: 6,
              height: 18 * scale,
              decoration: BoxDecoration(
                color: widget.color,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ),
        ),
      );
}

/// The status icon, with a halo that breathes while the monitor is down. The
/// controller is owned by the page and shared, so this widget only listens.
class _StatusDot extends StatelessWidget {
  final IconData icon;
  final Color color;
  final Animation<double>? pulse;
  const _StatusDot({required this.icon, required this.color, this.pulse});

  @override
  Widget build(BuildContext context) {
    final dot = Icon(icon, color: color);
    if (pulse == null) return dot;
    return AnimatedBuilder(
      animation: pulse!,
      builder: (_, child) {
        // One breath per cycle: the ring swells and fades out, then restarts.
        final t = Curves.easeOut.transform(pulse!.value);
        return SizedBox(
          width: 34,
          height: 34,
          child: Stack(
            alignment: Alignment.center,
            children: [
              Container(
                width: 18 + 16 * t,
                height: 18 + 16 * t,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: color.withValues(alpha: 0.28 * (1 - t)),
                ),
              ),
              child!,
            ],
          ),
        );
      },
      child: dot,
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

// ---------------- report ----------------

/// History of one monitor. The point of a once-a-day drift check is the record
/// it leaves — a heartbeat bar only holds the last 40 beats, which for a daily
/// monitor is still over a month but for a 60s one is forty minutes.
class MonitorReportDialog extends StatefulWidget {
  final Map<String, dynamic> monitor;
  const MonitorReportDialog({super.key, required this.monitor});
  @override
  State<MonitorReportDialog> createState() => _MonitorReportDialogState();
}

class _MonitorReportDialogState extends State<MonitorReportDialog> {
  int _days = 30;
  bool _busy = true;
  String? _error;
  Map<String, dynamic>? _data;

  int get _id => widget.monitor['id'] as int;

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
      final r = await Api.instance.monitorReport(_id, days: _days);
      if (!mounted) return;
      setState(() {
        _data = r;
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

  Future<void> _csv() async {
    try {
      final bytes = await Api.instance.monitorReportCsv(_id, days: _days);
      final safe = '${widget.monitor['name']}'.replaceAll(RegExp(r'[^\w.-]'), '_');
      downloadBytes('$safe-report-${_days}d.csv', bytes);
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('โหลดไม่สำเร็จ: $e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = MonitorThemeScope.of(context);
    final rows = (_data?['rows'] as List?) ?? [];
    final total = (_data?['total'] as num?)?.toInt() ?? 0;
    final failed = (_data?['failed'] as num?)?.toInt() ?? 0;
    final passed = total - failed;
    final rate = total == 0 ? null : (passed * 100 / total);

    return AlertDialog(
      title: Row(children: [
        Expanded(child: Text('รายงาน · ${widget.monitor['name']}', overflow: TextOverflow.ellipsis)),
        DropdownButton<int>(
          value: _days,
          underline: const SizedBox.shrink(),
          items: const [
            DropdownMenuItem(value: 7, child: Text('7 วัน')),
            DropdownMenuItem(value: 30, child: Text('30 วัน')),
            DropdownMenuItem(value: 90, child: Text('90 วัน')),
            DropdownMenuItem(value: 365, child: Text('1 ปี')),
          ],
          onChanged: _busy
              ? null
              : (v) {
                  if (v == null) return;
                  setState(() => _days = v);
                  _load();
                },
        ),
      ]),
      content: SizedBox(
        width: 620,
        height: 460,
        child: _busy
            ? const Center(child: CircularProgressIndicator())
            : _error != null
                ? Center(child: Text(_error!, style: TextStyle(color: p.down)))
                : Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Wrap(spacing: 18, runSpacing: 6, children: [
                      _stat('ตรวจทั้งหมด', '$total ครั้ง', p.muted(0.75)),
                      _stat('ผ่าน', '$passed', p.up),
                      _stat('ไม่ผ่าน', '$failed', failed == 0 ? p.muted(0.75) : p.down),
                      _stat('อัตราผ่าน', rate == null ? '—' : '${rate.toStringAsFixed(2)}%',
                          rate == null ? p.muted(0.75) : (rate >= 99 ? p.up : (rate >= 95 ? p.warn : p.down))),
                    ]),
                    const Divider(height: 20),
                    if (rows.isEmpty)
                      Expanded(
                        child: Center(
                          child: Text('ยังไม่มีข้อมูลในช่วงนี้', style: TextStyle(color: p.muted())),
                        ),
                      )
                    else
                      Expanded(
                        child: ListView.builder(
                          itemCount: rows.length,
                          itemBuilder: (_, i) {
                            final r = rows[i] as Map<String, dynamic>;
                            final ok = r['ok'] == 1;
                            return Padding(
                              padding: const EdgeInsets.symmetric(vertical: 3),
                              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                Icon(ok ? Icons.check_circle : Icons.cancel, size: 14, color: ok ? p.up : p.down),
                                const SizedBox(width: 8),
                                SizedBox(
                                  width: 150,
                                  child: Text(localTime(_msToDbUtc(r['ts'])),
                                      style: TextStyle(fontSize: 12, fontFamily: 'monospace', color: p.muted(0.80))),
                                ),
                                SizedBox(
                                  width: 66,
                                  child: Text(r['ms'] == null ? '' : '${r['ms']} ms',
                                      style: TextStyle(fontSize: 12, color: p.muted(0.55))),
                                ),
                                Expanded(
                                  child: Text(
                                    (r['error']?.toString().isNotEmpty ?? false) ? r['error'].toString() : (ok ? 'ปกติ' : 'ล่ม'),
                                    style: TextStyle(fontSize: 12, color: ok ? p.muted(0.55) : p.down),
                                  ),
                                ),
                              ]),
                            );
                          },
                        ),
                      ),
                    // The API caps a report at 5000 rows; saying so beats a
                    // silently short list that reads as "nothing happened".
                    if (rows.length >= 5000)
                      Padding(
                        padding: const EdgeInsets.only(top: 6),
                        child: Text('แสดงได้สูงสุด 5000 แถว — ลดจำนวนวันลงเพื่อดูช่วงที่ต้องการ',
                            style: TextStyle(fontSize: 11, color: p.warn)),
                      ),
                  ]),
      ),
      actions: [
        TextButton.icon(
          onPressed: _busy ? null : _csv,
          icon: const Icon(Icons.download, size: 16),
          label: const Text('ดาวน์โหลด CSV'),
        ),
        FilledButton(onPressed: () => Navigator.pop(context), child: const Text('ปิด')),
      ],
    );
  }

  Widget _stat(String label, String value, Color color) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(label, style: TextStyle(fontSize: 11, color: MonitorThemeScope.of(context).muted(0.55))),
          Text(value, style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: color)),
        ],
      );
}

const _types = ['http', 'tcp', 'mssql', 'postgres', 'mongodb'];
const _typeLabels = {
  'http': 'HTTP(S)',
  'tcp': 'TCP port',
  'mssql': 'MSSQL (login จริง)',
  'postgres': 'PostgreSQL (login จริง)',
  'mongodb': 'MongoDB (ping จริง)',
};

class MonitorDialog extends StatefulWidget {
  final Map<String, dynamic>? monitor;
  const MonitorDialog({super.key, this.monitor});
  @override
  State<MonitorDialog> createState() => _MonitorDialogState();
}

class _MonitorDialogState extends State<MonitorDialog> {
  late final TextEditingController _name;
  late final TextEditingController _url;
  late final TextEditingController _host;
  late final TextEditingController _port;
  late final TextEditingController _user;
  final _pass = TextEditingController();
  late final TextEditingController _dbName;
  late final TextEditingController _interval;
  late final TextEditingController _failThreshold;
  late final TextEditingController _query;
  late final TextEditingController _expectValue;
  late final TextEditingController _compareHost;
  late final TextEditingController _comparePort;
  late final TextEditingController _dailyAt;
  bool _daily = false;
  String _expectOp = 'eq';
  bool _public = false;
  late String _type;
  bool _ignoreTls = false;
  bool _busy = false;
  bool _showPass = false;
  String? _error;
  String? _testResult;

  bool get _isEdit => widget.monitor != null;
  bool get _isDbType => _type == 'mssql' || _type == 'postgres' || _type == 'mongodb';

  @override
  void initState() {
    super.initState();
    final m = widget.monitor;
    _type = m?['type']?.toString() ?? 'http';
    _name = TextEditingController(text: m?['name']?.toString() ?? '');
    _url = TextEditingController(text: m?['url']?.toString() ?? '');
    _host = TextEditingController(text: m?['host']?.toString() ?? '');
    _port = TextEditingController(text: m?['port']?.toString() ?? '');
    _user = TextEditingController(text: m?['username']?.toString() ?? '');
    _dbName = TextEditingController(text: m?['database_name']?.toString() ?? '');
    _interval = TextEditingController(text: m?['interval_sec']?.toString() ?? '60');
    _failThreshold = TextEditingController(text: m?['fail_threshold']?.toString() ?? '3');
    _ignoreTls = m?['ignore_tls_errors'] == true;
    _query = TextEditingController(text: m?['check_query']?.toString() ?? '');
    _expectValue = TextEditingController(text: m?['expect_value']?.toString() ?? '');
    _expectOp = m?['expect_op']?.toString() ?? 'eq';
    _compareHost = TextEditingController(text: m?['compare_host']?.toString() ?? '');
    _comparePort = TextEditingController(text: m?['compare_port']?.toString() ?? '');
    _dailyAt = TextEditingController(text: m?['daily_at']?.toString() ?? '00:00');
    _daily = (m?['daily_at']?.toString() ?? '').isNotEmpty;
    _public = m?['public'] == true;
  }

  @override
  void dispose() {
    _name.dispose();
    _url.dispose();
    _host.dispose();
    _port.dispose();
    _user.dispose();
    _pass.dispose();
    _dbName.dispose();
    _interval.dispose();
    _failThreshold.dispose();
    _query.dispose();
    _expectValue.dispose();
    _compareHost.dispose();
    _comparePort.dispose();
    _dailyAt.dispose();
    super.dispose();
  }

  // MSSQL replication-health presets — pick one and it fills the query +
  // condition; the operator picks the one matching their replication setup.
  bool get _customQuery => _isDbType && _type != 'mongodb';
  static const _presets = <String, Map<String, String>>{
    'Always On AG — ฐานที่ยังไม่ sync (ควร = 0)': {
      // Returns -1 when the AG has no databases at all, so pointing this at a
      // server that is not in an Always On group goes RED instead of green.
      // The plain COUNT(*) it replaced answered 0 there — a true zero, which
      // passed "= 0" and left the monitor green while watching nothing.
      'query':
          'SELECT CASE WHEN COUNT(*) = 0 THEN -1 ELSE '
          "SUM(CASE WHEN synchronization_state_desc <> 'SYNCHRONIZED' THEN 1 ELSE 0 END) END "
          'FROM sys.dm_hadr_database_replica_states',
      'op': 'eq',
      'value': '0',
      // Which instance to point `host` at is not obvious and getting it wrong
      // gives a green monitor that is watching nothing, so each preset says so.
      'host': 'ชี้ไปที่ instance ไหนก็ได้ในวง AG (นิยมใช้ primary) — DMV ตัวนี้ตอบสถานะของ replica ทุกตัวจากที่เดียว',
    },
    'Log shipping — วินาทีตั้งแต่ restore ล่าสุด (< 300)': {
      'query': 'SELECT DATEDIFF(second, MAX(last_restored_date), GETUTCDATE()) FROM msdb.dbo.log_shipping_monitor_secondary',
      'op': 'lt',
      'value': '300',
      'host': 'ชี้ไปที่เครื่อง secondary (หรือ monitor server) — ตาราง log_shipping_monitor_secondary อยู่ที่นั่น',
    },
    'PostgreSQL — replication lag วินาที (< 30)': {
      'query': 'SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::int',
      'op': 'lt',
      'value': '30',
      'host': 'ชี้ไปที่ replica เอง — ฟังก์ชันนี้คืนค่าเฉพาะบนเครื่องที่กำลัง replay',
    },
  };
  String? _presetHint;
  void _applyPreset(String key) {
    final p = _presets[key]!;
    setState(() {
      _query.text = p['query']!;
      _expectOp = p['op']!;
      _expectValue.text = p['value']!;
      _presetHint = p['host'];
    });
  }

  Map<String, dynamic> _body() => {
        'name': _name.text.trim(),
        'type': _type,
        if (_type == 'http') 'url': _url.text.trim(),
        if (_type != 'http') 'host': _host.text.trim(),
        if (_type != 'http') 'port': int.tryParse(_port.text.trim()),
        if (_isDbType) 'username': _user.text.trim(),
        if (_isDbType && _pass.text.isNotEmpty) 'password': _pass.text,
        if (_isDbType) 'database_name': _dbName.text.trim(),
        if (_type == 'http') 'ignore_tls_errors': _ignoreTls,
        if (_customQuery && _query.text.trim().isNotEmpty) 'check_query': _query.text.trim(),
        if (_customQuery && _query.text.trim().isNotEmpty) 'expect_op': _expectOp,
        if (_customQuery && _query.text.trim().isNotEmpty) 'expect_value': _expectValue.text.trim(),
        if (_customQuery && _compareHost.text.trim().isNotEmpty) 'compare_host': _compareHost.text.trim(),
        if (_customQuery && _compareHost.text.trim().isNotEmpty && _comparePort.text.trim().isNotEmpty)
          'compare_port': int.tryParse(_comparePort.text.trim()),
        'daily_at': _daily ? _dailyAt.text.trim() : '',
        'interval_sec': int.tryParse(_interval.text.trim()) ?? 60,
        'fail_threshold': int.tryParse(_failThreshold.text.trim()) ?? 3,
        'public': _public,
      };

  Future<void> _test() async {
    setState(() {
      _busy = true;
      _testResult = null;
    });
    try {
      final body = _body();
      if (_isEdit) body['id'] = widget.monitor!['id'];
      final r = await Api.instance.testMonitor(body);
      setState(() => _testResult =
          r['ok'] == true ? '✓ เชื่อมต่อได้${r['ms'] != null ? ' (${r['ms']} ms)' : ''}' : '✗ ${r['error'] ?? 'เชื่อมต่อไม่ได้'}');
    } catch (e) {
      setState(() => _testResult = '✗ $e'.replaceFirst('Exception: ', ''));
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
        await Api.instance.updateMonitor(widget.monitor!['id'] as int, _body());
      } else {
        await Api.instance.createMonitor(_body());
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
    final p = MonitorThemeScope.of(context);
    return AlertDialog(
      title: Text(_isEdit ? 'แก้ไข monitor' : 'เพิ่ม monitor'),
      content: SizedBox(
        width: 480,
        child: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            TextField(
              controller: _name,
              decoration: const InputDecoration(labelText: 'ชื่อเรียก', hintText: 'เช่น BACK-QC-PH-HES-INF'),
            ),
            const SizedBox(height: 10),
            DropdownButtonFormField<String>(
              initialValue: _type,
              decoration: const InputDecoration(labelText: 'ประเภท'),
              items: _types.map((t) => DropdownMenuItem(value: t, child: Text(_typeLabels[t]!))).toList(),
              onChanged: (v) => setState(() => _type = v ?? 'http'),
            ),
            const SizedBox(height: 10),
            if (_type == 'http') ...[
              TextField(
                controller: _url,
                decoration: const InputDecoration(labelText: 'URL', hintText: 'http://127.0.0.1:9700/'),
              ),
              CheckboxListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                controlAffinity: ListTileControlAffinity.leading,
                value: _ignoreTls,
                title: const Text('ข้ามการตรวจใบรับรอง TLS', style: TextStyle(fontSize: 13)),
                subtitle: const Text('ใช้เฉพาะปลายทางที่ใช้ certificate self-signed/local CA ที่รู้จักอยู่แล้ว',
                    style: TextStyle(fontSize: 11)),
                onChanged: (v) => setState(() => _ignoreTls = v ?? false),
              ),
            ] else ...[
              Row(children: [
                Expanded(
                  flex: 3,
                  child: TextField(
                    controller: _host,
                    decoration: const InputDecoration(labelText: 'host', hintText: '172.23.10.51'),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  flex: 2,
                  child: TextField(
                    controller: _port,
                    keyboardType: TextInputType.number,
                    decoration: InputDecoration(labelText: 'port', hintText: _type == 'mssql' ? '1433' : (_type == 'postgres' ? '5432' : '27017')),
                  ),
                ),
              ]),
            ],
            if (_isDbType) ...[
              const SizedBox(height: 10),
              TextField(controller: _user, decoration: const InputDecoration(labelText: 'username')),
              const SizedBox(height: 10),
              TextField(
                controller: _pass,
                obscureText: !_showPass,
                decoration: InputDecoration(
                  labelText: _isEdit ? 'รหัสผ่าน (เว้นว่าง = ใช้ของเดิม)' : 'รหัสผ่าน',
                  helperText: _type == 'mongodb' ? 'เว้นว่างได้ถ้า mongo ไม่ตั้ง auth' : 'เก็บแบบเข้ารหัส ไม่มีทางเรียกดูกลับได้',
                  suffixIcon: IconButton(
                    icon: Icon(_showPass ? Icons.visibility_off : Icons.visibility, size: 18),
                    onPressed: () => setState(() => _showPass = !_showPass),
                  ),
                ),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _dbName,
                decoration: InputDecoration(
                  labelText: _type == 'mongodb' ? 'authSource (ไม่ใส่ = admin)' : 'database (ไม่ใส่ = default)',
                ),
              ),
            ],
            // Custom query / replication-health check (mssql & postgres).
            if (_customQuery) ...[
              const Divider(height: 22),
              const Align(
                alignment: Alignment.centerLeft,
                child: Text('ตรวจแบบกำหนดเอง / replication (ไม่ใส่ = แค่เช็คว่า login ได้)',
                    style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
              ),
              const SizedBox(height: 6),
              DropdownButtonFormField<String>(
                initialValue: null,
                isExpanded: true,
                decoration: const InputDecoration(labelText: 'เลือก preset สำเร็จรูป', isDense: true),
                hint: const Text('— เลือกเพื่อเติม query ให้อัตโนมัติ —', style: TextStyle(fontSize: 12)),
                items: _presets.keys
                    .map((k) => DropdownMenuItem(value: k, child: Text(k, style: const TextStyle(fontSize: 12), overflow: TextOverflow.ellipsis)))
                    .toList(),
                onChanged: (k) => k == null ? null : _applyPreset(k),
              ),
              if (_presetHint != null)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Icon(Icons.info_outline, size: 14, color: p.info),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(_presetHint!,
                          style: TextStyle(fontSize: 11, color: p.info, height: 1.4)),
                    ),
                  ]),
                ),
              const SizedBox(height: 8),
              TextField(
                controller: _query,
                maxLines: 3,
                style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
                decoration: const InputDecoration(
                  labelText: 'SQL (read-only)',
                  hintText: 'SELECT COUNT(*) FROM ... — ต้องคืนค่าเดียว',
                  helperText: 'อ่านอย่างเดียว (SELECT/WITH/EXEC) · รันทุกรอบ · เอาค่าช่องแรกมาเทียบเงื่อนไข',
                  helperMaxLines: 2,
                ),
              ),
              const SizedBox(height: 8),
              Row(children: [
                Expanded(
                  flex: 2,
                  child: DropdownButtonFormField<String>(
                    initialValue: _expectOp,
                    isDense: true,
                    decoration: const InputDecoration(labelText: 'เงื่อนไขผ่าน'),
                    items: const [
                      DropdownMenuItem(value: 'eq', child: Text('= เท่ากับ')),
                      DropdownMenuItem(value: 'ne', child: Text('≠ ไม่เท่ากับ')),
                      DropdownMenuItem(value: 'lt', child: Text('< น้อยกว่า')),
                      DropdownMenuItem(value: 'lte', child: Text('≤ น้อยกว่าเท่ากับ')),
                      DropdownMenuItem(value: 'gt', child: Text('> มากกว่า')),
                      DropdownMenuItem(value: 'gte', child: Text('≥ มากกว่าเท่ากับ')),
                      DropdownMenuItem(value: 'contains', child: Text('มีคำว่า')),
                    ],
                    onChanged: (v) => setState(() => _expectOp = v ?? 'eq'),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: TextField(
                    controller: _expectValue,
                    decoration: const InputDecoration(labelText: 'ค่าที่คาดหวัง', hintText: '0'),
                  ),
                ),
              ]),
              const SizedBox(height: 10),
              // Drift check: same query on a second server, judged on the
              // difference between the two answers.
              Row(children: [
                Expanded(
                  flex: 3,
                  child: TextField(
                    controller: _compareHost,
                    decoration: const InputDecoration(
                      labelText: 'เทียบกับเครื่อง (ไม่ใส่ = ไม่เทียบ)',
                      hintText: '172.23.10.51',
                      helperText: 'รัน query เดียวกันทั้งสองเครื่อง แล้วดูว่าผลต่างเข้าเงื่อนไขข้างบนไหม '
                          '(เช่น "= 0" คือต้องตรงกันเป๊ะ) · เป็น query หนัก ต้องตั้งเป็นรายวัน '
                          'หรือห่างกันอย่างน้อย 600 วินาที',
                      helperMaxLines: 3,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: TextField(
                    controller: _comparePort,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(labelText: 'port', hintText: 'เท่าเครื่องแรก'),
                  ),
                ),
              ]),
            ],
            const Divider(height: 22),
            // Wall-clock schedule. A heavy comparison has to land in the quiet
            // window, and an interval would drift out of it.
            CheckboxListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              value: _daily,
              title: const Text('รันวันละครั้ง ตามเวลาที่กำหนด', style: TextStyle(fontSize: 13)),
              subtitle: const Text('เหมาะกับการเทียบข้อมูล/query หนัก — ตรงเวลาเดิมทุกวัน ไม่เลื่อน',
                  style: TextStyle(fontSize: 11)),
              onChanged: (v) => setState(() => _daily = v ?? false),
            ),
            if (_daily)
              Padding(
                padding: const EdgeInsets.only(left: 32, bottom: 4),
                child: SizedBox(
                  width: 160,
                  child: TextField(
                    controller: _dailyAt,
                    decoration: const InputDecoration(labelText: 'เวลา (HH:MM)', hintText: '00:00', isDense: true),
                  ),
                ),
              ),
            const SizedBox(height: 10),
            Row(children: [
              Expanded(
                child: TextField(
                  controller: _interval,
                  keyboardType: TextInputType.number,
                  enabled: !_daily,
                  decoration: InputDecoration(
                    labelText: 'ทุกกี่วินาที',
                    helperText: _daily
                        ? 'ไม่ใช้ — ตั้งเป็นรายวันแล้ว'
                        : (_isDbType ? 'ขั้นต่ำ 30s (กันยิง login ถี่)' : 'ขั้นต่ำ 10s'),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: TextField(
                  controller: _failThreshold,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(labelText: 'พลาดกี่ครั้งถึงถือว่าล่ม'),
                ),
              ),
            ]),
            const Divider(height: 22),
            CheckboxListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              value: _public,
              title: const Text('แสดงบนหน้าสถานะสาธารณะ', style: TextStyle(fontSize: 13)),
              subtitle: const Text(
                  'หน้า /status ที่เปิดดูได้โดยไม่ต้อง login — โชว์แค่ชื่อ สถานะ และ uptime '
                  '(ไม่โชว์ host/port/รหัส/SQL)',
                  style: TextStyle(fontSize: 11)),
              onChanged: (v) => setState(() => _public = v ?? false),
            ),
            if (_testResult != null) ...[
              const SizedBox(height: 10),
              Align(
                alignment: Alignment.centerLeft,
                child: Text(_testResult!,
                    style: TextStyle(fontSize: 12, color: _testResult!.startsWith('✓') ? p.up : p.warn)),
              ),
            ],
            if (_error != null) ...[
              const SizedBox(height: 10),
              Align(
                alignment: Alignment.centerLeft,
                child: Text(_error!, style: TextStyle(color: p.down, fontSize: 12)),
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
