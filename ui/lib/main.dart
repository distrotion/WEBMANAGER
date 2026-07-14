import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'api.dart';
import 'console.dart';
import 'requirements.dart';
import 'folder_picker.dart';
import 'users.dart';
import 'shell_console.dart';
import 'audit.dart';
import 'download.dart';
import 'fleet.dart';

// True when the browser tab is hidden/minimised — live pollers skip work then,
// so a backgrounded panel costs the server (almost) nothing.
bool pageHidden() {
  final st = WidgetsBinding.instance.lifecycleState;
  return st == AppLifecycleState.hidden ||
      st == AppLifecycleState.paused ||
      st == AppLifecycleState.detached;
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Restore remembered login — never let a storage hiccup blank the whole app.
  try {
    await Api.instance.restore();
  } catch (_) {}
  runApp(const WebManagerApp());
}

class WebManagerApp extends StatelessWidget {
  const WebManagerApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'WEBMANAGER',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF2563EB),
          brightness: Brightness.dark,
        ),
        scaffoldBackgroundColor: const Color(0xFF0F172A),
      ),
      home: const AuthGate(),
    );
  }
}

class AuthGate extends StatefulWidget {
  const AuthGate({super.key});
  @override
  State<AuthGate> createState() => _AuthGateState();
}

class _AuthGateState extends State<AuthGate> {
  @override
  Widget build(BuildContext context) =>
      Api.instance.loggedIn ? const SitesPage() : LoginPage(onDone: () => setState(() {}));
}

// ---------------- Login ----------------
class LoginPage extends StatefulWidget {
  final VoidCallback onDone;
  const LoginPage({super.key, required this.onDone});
  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final _user = TextEditingController(text: Api.instance.rememberedUser ?? 'admin');
  final _pass = TextEditingController();
  String? _error;
  bool _busy = false;

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final ok = await Api.instance.login(_user.text.trim(), _pass.text);
      if (ok) {
        widget.onDone();
      } else {
        setState(() => _error = 'Invalid credentials');
      }
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 360),
          child: Card(
            margin: const EdgeInsets.all(24),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(children: const [
                    Icon(Icons.dns, size: 28),
                    SizedBox(width: 10),
                    Text('WEBMANAGER', style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
                  ]),
                  const SizedBox(height: 20),
                  TextField(
                    controller: _user,
                    decoration: const InputDecoration(labelText: 'Username', border: OutlineInputBorder()),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _pass,
                    obscureText: true,
                    onSubmitted: (_) => _submit(),
                    decoration: const InputDecoration(labelText: 'Password', border: OutlineInputBorder()),
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 12),
                    Text(_error!, style: const TextStyle(color: Colors.redAccent)),
                  ],
                  const SizedBox(height: 20),
                  FilledButton(
                    onPressed: _busy ? null : _submit,
                    child: _busy
                        ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
                        : const Text('Sign in'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

// ---------------- Sites list ----------------
class SitesPage extends StatefulWidget {
  const SitesPage({super.key});
  @override
  State<SitesPage> createState() => _SitesPageState();
}

class _SitesPageState extends State<SitesPage> {
  late Future<List<Map<String, dynamic>>> _future;
  // Live PM2 metrics keyed by site name (from /pm2/overview), polled every 3s.
  Map<String, Map<String, dynamic>> _overview = {};
  Timer? _monitTimer;
  String _version = '';

  @override
  void initState() {
    super.initState();
    _reload();
    _pollOverview();
    _monitTimer = Timer.periodic(const Duration(seconds: 3), (_) => _pollOverview());
    Api.instance.serverVersion().then((v) {
      if (mounted) setState(() => _version = v);
    });
  }

  @override
  void dispose() {
    _monitTimer?.cancel();
    super.dispose();
  }

  Future<void> _pollOverview() async {
    // skip while the tab is hidden or another page (detail / PM2 list) covers us
    if (!mounted || pageHidden() || !(ModalRoute.of(context)?.isCurrent ?? true)) return;
    final o = await Api.instance.pm2Overview();
    if (mounted) setState(() => _overview = o);
  }

  void _reload() => setState(() => _future = Api.instance.sites());

  Future<void> _create() async {
    final created = await showDialog<bool>(
      context: context,
      builder: (_) => const CreateSiteDialog(),
    );
    if (created == true) _reload();
  }

  Color _statusColor(String? s) {
    switch (s) {
      case 'running':
      case 'online':
        return Colors.green;
      case 'error':
      case 'errored':
        return Colors.red;
      default:
        return Colors.grey;
    }
  }

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 3,
      child: Scaffold(
      appBar: AppBar(
        title: Row(crossAxisAlignment: CrossAxisAlignment.end, mainAxisSize: MainAxisSize.min, children: [
          const Text('WEBMANAGER'),
          if (_version.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(left: 8, bottom: 3),
              child: Text(_version,
                  style: const TextStyle(fontSize: 11, color: Colors.white38)),
            ),
        ]),
        bottom: const TabBar(tabs: [
          Tab(icon: Icon(Icons.dns, size: 18), text: 'PM2 apps'),
          Tab(icon: Icon(Icons.account_tree, size: 18), text: 'Node-RED'),
          Tab(icon: Icon(Icons.web, size: 18), text: 'nginx / web'),
        ]),
        actions: [
          IconButton(
            tooltip: 'PM2 list',
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => const Pm2ListPage()),
            ),
            icon: const Icon(Icons.table_rows),
          ),
          IconButton(
            tooltip: 'Install requirements',
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => const RequirementsPage()),
            ),
            icon: const Icon(Icons.fact_check),
          ),
          IconButton(onPressed: _reload, icon: const Icon(Icons.refresh)),
          PopupMenuButton<String>(
            tooltip: 'Account',
            icon: const Icon(Icons.account_circle),
            onSelected: (v) async {
              if (v == 'users') {
                Navigator.of(context).push(MaterialPageRoute(builder: (_) => const UsersPage()));
              } else if (v == 'fleet') {
                Navigator.of(context).push(MaterialPageRoute(builder: (_) => const FleetPage()));
              } else if (v == 'shell') {
                Navigator.of(context).push(MaterialPageRoute(builder: (_) => const ShellConsolePage()));
              } else if (v == 'audit') {
                Navigator.of(context).push(MaterialPageRoute(builder: (_) => const AuditPage()));
              } else if (v == 'password') {
                await showDialog(context: context, builder: (_) => const _ChangePasswordDialog());
              } else if (v == 'logout') {
                await Api.instance.logout();
                if (context.mounted) {
                  Navigator.of(context).pushReplacement(
                    MaterialPageRoute(builder: (_) => const AuthGate()),
                  );
                }
              }
            },
            itemBuilder: (_) => [
              PopupMenuItem(
                enabled: false,
                child: Text('${Api.instance.username} · ${Api.instance.role}',
                    style: const TextStyle(fontWeight: FontWeight.bold)),
              ),
              const PopupMenuDivider(),
              if (Api.instance.isAdmin)
                const PopupMenuItem(value: 'users', child: ListTile(leading: Icon(Icons.group), title: Text('Users'), dense: true)),
              if (Api.instance.isAdmin)
                const PopupMenuItem(value: 'fleet', child: ListTile(leading: Icon(Icons.hub), title: Text('Fleet (แม่/ลูก)'), dense: true)),
              if (Api.instance.isAdmin)
                const PopupMenuItem(value: 'shell', child: ListTile(leading: Icon(Icons.terminal), title: Text('Server console (shell)'), dense: true)),
              if (Api.instance.isAdmin)
                const PopupMenuItem(value: 'audit', child: ListTile(leading: Icon(Icons.history), title: Text('Audit log'), dense: true)),
              const PopupMenuItem(value: 'password', child: ListTile(leading: Icon(Icons.password), title: Text('Change password'), dense: true)),
              const PopupMenuItem(value: 'logout', child: ListTile(leading: Icon(Icons.logout), title: Text('Logout'), dense: true)),
            ],
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _create,
        icon: const Icon(Icons.add),
        label: const Text('New site'),
      ),
      body: FutureBuilder<List<Map<String, dynamic>>>(
        future: _future,
        builder: (context, snap) {
          if (snap.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snap.hasError) {
            if ('${snap.error}'.contains('unauthorized')) {
              WidgetsBinding.instance.addPostFrameCallback((_) {
                if (context.mounted) {
                  Navigator.of(context).pushReplacement(
                    MaterialPageRoute(builder: (_) => const AuthGate()),
                  );
                }
              });
              return const Center(child: Text('Session expired — signing out…'));
            }
            return Center(child: Text('Error: ${snap.error}'));
          }
          final sites = snap.data ?? [];
          final node = sites.where((s) => s['runtime'] == 'node').toList();
          final nodered = sites.where((s) => s['runtime'] == 'nodered').toList();
          final web = sites.where((s) => s['runtime'] == 'static').toList();
          return TabBarView(children: [
            _siteList(context, node, 'No PM2 apps yet — create a node backend site.'),
            _siteList(context, nodered, 'No Node-RED apps yet — create a Node-RED site.'),
            _siteList(context, web, 'No nginx sites yet — create a static site.'),
          ]);
        },
      ),
    ),
    );
  }

  Widget _siteList(BuildContext context, List<Map<String, dynamic>> sites, String empty) {
    if (sites.isEmpty) return Center(child: Text(empty, style: const TextStyle(color: Colors.white54)));
    return ListView.separated(
      padding: const EdgeInsets.all(12),
      itemCount: sites.length,
      separatorBuilder: (_, __) => const SizedBox(height: 8),
      itemBuilder: (_, i) {
        final s = sites[i];
        final m = _overview[s['name']]; // live PM2 metrics for this app (null for web)
        final liveStatus = (m?['status'] as String?) ?? s['status'];
        return Card(
          child: ListTile(
            leading: Icon(_runtimeIcon(s['runtime'])),
            title: Text(s['name'], style: const TextStyle(fontWeight: FontWeight.w600)),
            subtitle: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(_subtitle(s)),
                if (m != null) _monitLine(m),
                if (s['autodeploy'] == 1)
                  const Padding(
                    padding: EdgeInsets.only(top: 2),
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      Icon(Icons.sync, size: 12, color: Colors.lightBlueAccent),
                      SizedBox(width: 3),
                      Text('auto-deploy', style: TextStyle(fontSize: 11, color: Colors.lightBlueAccent)),
                    ]),
                  ),
              ],
            ),
            trailing: Row(mainAxisSize: MainAxisSize.min, children: [
              if (_openUrl(s) != null)
                IconButton(
                  tooltip: 'Open',
                  icon: const Icon(Icons.open_in_new, size: 18),
                  onPressed: () => launchUrl(Uri.parse(_openUrl(s)!), webOnlyWindowName: '_blank'),
                ),
              if (s['ssl_enabled'] == 1) const Icon(Icons.lock, size: 16, color: Colors.greenAccent),
              const SizedBox(width: 8),
              Chip(
                label: Text(liveStatus ?? 'new', style: const TextStyle(fontSize: 11)),
                backgroundColor: _statusColor(liveStatus).withValues(alpha: 0.2),
                side: BorderSide(color: _statusColor(liveStatus)),
              ),
            ]),
            onTap: () async {
              await Navigator.of(context).push(
                MaterialPageRoute(builder: (_) => SiteDetailPage(site: s)),
              );
              _reload();
            },
          ),
        );
      },
    );
  }

  // Best URL to open from the list: front (with SSL) if set, else direct port.
  String? _openUrl(Map<String, dynamic> s) {
    final scheme = s['ssl_enabled'] == 1 ? 'https' : 'http';
    final sub = (s['subdomain'] ?? '').toString();
    final dom = (s['domain'] ?? '').toString();
    if (s['exposure_mode'] == 'subdomain' && sub.isNotEmpty) return '$scheme://$sub';
    if (s['exposure_mode'] == 'path' && dom.isNotEmpty) {
      return '$scheme://$dom/${s['path'] ?? ''}';
    }
    if (s['direct_port'] != null && s['direct_port_enabled'] == 1) {
      final host = Uri.base.host.isEmpty ? 'localhost' : Uri.base.host;
      return 'http://$host:${s['direct_port']}';
    }
    return null;
  }

  // Live CPU / RAM / restarts line for a PM2 app (from /pm2/overview).
  Widget _monitLine(Map<String, dynamic> m) {
    final cpu = (m['cpu'] as num?)?.toDouble();
    final memBytes = (m['memory'] as num?)?.toDouble();
    final restarts = (m['restarts'] as num?)?.toInt() ?? 0;
    final mem = memBytes == null ? null : (memBytes / (1024 * 1024)).toStringAsFixed(0);
    TextSpan chip(IconData i, String t) => TextSpan(children: [
          WidgetSpan(
            alignment: PlaceholderAlignment.middle,
            child: Icon(i, size: 12, color: Colors.white54),
          ),
          TextSpan(text: ' $t   ', style: const TextStyle(fontSize: 11, color: Colors.white70)),
        ]);
    return Padding(
      padding: const EdgeInsets.only(top: 2),
      child: Text.rich(TextSpan(children: [
        if (cpu != null) chip(Icons.memory, '${cpu.toStringAsFixed(0)}%'),
        if (mem != null) chip(Icons.sd_storage, '$mem MB'),
        if (restarts > 0) chip(Icons.restart_alt, '$restarts'),
      ])),
    );
  }

  String _subtitle(Map<String, dynamic> s) {
    final parts = <String>[s['runtime'] ?? 'static'];
    if (s['direct_port'] != null) parts.add('port ${s['direct_port']}');
    if (s['exposure_mode'] == 'subdomain') parts.add(s['subdomain'] ?? '');
    if (s['exposure_mode'] == 'path') parts.add('${s['domain']}/${s['path']}');
    return parts.where((e) => e.isNotEmpty).join(' · ');
  }

  IconData _runtimeIcon(String? r) {
    switch (r) {
      case 'nodered':
        return Icons.account_tree;
      case 'node':
        return Icons.dns;
      default:
        return Icons.web;
    }
  }
}

// ---------------- PM2 list (pm2 ls) ----------------
// Live table of every wm-* PM2 process, like `pm2 list` — polls every 3s.
class Pm2ListPage extends StatefulWidget {
  const Pm2ListPage({super.key});
  @override
  State<Pm2ListPage> createState() => _Pm2ListPageState();
}

class _Pm2ListPageState extends State<Pm2ListPage> {
  Map<String, Map<String, dynamic>> _apps = {};
  bool _loading = true;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _poll();
    _timer = Timer.periodic(const Duration(seconds: 3), (_) => _poll());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _poll() async {
    if (!mounted || pageHidden()) return;
    final o = await Api.instance.pm2Overview();
    if (mounted) {
      setState(() {
        _apps = o;
        _loading = false;
      });
    }
  }

  String _uptime(dynamic since, String status) {
    if (since is! num || status != 'online') return '-';
    final secs = (DateTime.now().millisecondsSinceEpoch - since) ~/ 1000;
    if (secs < 0) return '-';
    if (secs < 60) return '${secs}s';
    if (secs < 3600) return '${secs ~/ 60}m';
    if (secs < 86400) return '${secs ~/ 3600}h ${(secs % 3600) ~/ 60}m';
    return '${secs ~/ 86400}d ${(secs % 86400) ~/ 3600}h';
  }

  Color _stColor(String s) => s == 'online'
      ? Colors.greenAccent
      : (s == 'errored' ? Colors.redAccent : Colors.grey);

  @override
  Widget build(BuildContext context) {
    final names = _apps.keys.toList()..sort();
    return Scaffold(
      appBar: AppBar(title: const Text('PM2 list'), actions: [
        IconButton(onPressed: _poll, icon: const Icon(Icons.refresh)),
      ]),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : names.isEmpty
              ? const Center(
                  child: Text('No PM2 processes — deploy a node / Node-RED app first.',
                      style: TextStyle(color: Colors.white54)))
              : SingleChildScrollView(
                  padding: const EdgeInsets.all(12),
                  child: SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: DataTable(
                      headingTextStyle:
                          const TextStyle(fontWeight: FontWeight.bold, fontSize: 13),
                      dataTextStyle:
                          const TextStyle(fontFamily: 'monospace', fontSize: 13),
                      columns: const [
                        DataColumn(label: Text('name')),
                        DataColumn(label: Text('status')),
                        DataColumn(label: Text('pid')),
                        DataColumn(label: Text('cpu')),
                        DataColumn(label: Text('mem')),
                        DataColumn(label: Text('↻ restarts')),
                        DataColumn(label: Text('uptime')),
                      ],
                      rows: [
                        for (final n in names)
                          DataRow(cells: [
                            DataCell(Text(_apps[n]!['name']?.toString() ?? 'wm-$n')),
                            DataCell(Text(
                              _apps[n]!['status']?.toString() ?? '?',
                              style: TextStyle(
                                  color: _stColor(_apps[n]!['status']?.toString() ?? ''),
                                  fontWeight: FontWeight.bold),
                            )),
                            DataCell(Text('${_apps[n]!['pid'] ?? '-'}')),
                            DataCell(Text(_apps[n]!['cpu'] is num
                                ? '${(_apps[n]!['cpu'] as num).toStringAsFixed(1)}%'
                                : '-')),
                            DataCell(Text(_apps[n]!['memory'] is num
                                ? '${((_apps[n]!['memory'] as num) / 1048576).toStringAsFixed(0)} MB'
                                : '-')),
                            DataCell(Text('${_apps[n]!['restarts'] ?? 0}')),
                            DataCell(Text(_uptime(
                                _apps[n]!['uptime'], _apps[n]!['status']?.toString() ?? ''))),
                          ]),
                      ],
                    ),
                  ),
                ),
    );
  }
}

// KEY=VALUE lines <-> JSON env map.
String _envJsonToLines(dynamic envJson) {
  if (envJson == null || '$envJson'.isEmpty) return '';
  try {
    final m = jsonDecode(envJson as String) as Map<String, dynamic>;
    return m.entries.map((e) => '${e.key}=${e.value}').join('\n');
  } catch (_) {
    return '';
  }
}

String? _linesToEnvJson(String text) {
  final m = <String, String>{};
  for (final line in text.split('\n')) {
    final t = line.trim();
    if (t.isEmpty || !t.contains('=')) continue;
    final i = t.indexOf('=');
    m[t.substring(0, i).trim()] = t.substring(i + 1).trim();
  }
  return m.isEmpty ? null : jsonEncode(m);
}

// ---------------- Create / edit site ----------------
class CreateSiteDialog extends StatefulWidget {
  final Map<String, dynamic>? site; // non-null = edit an existing site
  const CreateSiteDialog({super.key, this.site});
  @override
  State<CreateSiteDialog> createState() => _CreateSiteDialogState();
}

class _CreateSiteDialogState extends State<CreateSiteDialog> {
  static Map<String, dynamic> get _cfg => Api.instance.cfg;
  bool get _editing => widget.site != null;

  final _name = TextEditingController();
  final _repo = TextEditingController();
  final _local = TextEditingController();
  final _branch = TextEditingController();
  final _entry = TextEditingController();
  final _env = TextEditingController();
  final _port = TextEditingController();
  final _subdomain = TextEditingController();
  final _domain = TextEditingController();
  final _path = TextEditingController();
  late String _runtime;
  late String _source;
  late String _exposure;
  bool _autodeploy = false;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    final s = widget.site;
    if (s != null) {
      // editing → prefill from the site
      _name.text = s['name'] ?? '';
      _repo.text = s['repo_url'] ?? '';
      _local.text = s['local_path'] ?? '';
      _branch.text = s['branch'] ?? 'main';
      _entry.text = s['entry_file'] ?? '';
      _env.text = _envJsonToLines(s['env_json']);
      _port.text = s['direct_port']?.toString() ?? '';
      _subdomain.text = s['subdomain'] ?? '';
      _domain.text = s['domain'] ?? '';
      _path.text = s['path'] ?? '';
      _runtime = s['runtime'] ?? 'static';
      _source = s['source_type'] ?? 'git';
      _exposure = s['exposure_mode'] ?? 'none';
      _autodeploy = s['autodeploy'] == 1;
    } else {
      // creating → prefill from remembered config
      _branch.text = _cfg['branch'] ?? 'main';
      _domain.text = _cfg['domain'] ?? '';
      _runtime = _cfg['runtime'] ?? 'static';
      _source = _cfg['source_type'] ?? 'git';
      _exposure = _cfg['exposure_mode'] ?? 'subdomain';
    }
  }

  // Pick a .env file from this computer and MERGE it into the Env vars field:
  // keys already typed stay (imported values win on duplicates); the file itself
  // is read in the browser only — never uploaded, moved, or deleted.
  Future<void> _importEnvFile() async {
    final text = await pickTextFile();
    if (text == null) return;
    final merged = <String, String>{};
    void addLines(String src) {
      for (final line in src.split('\n')) {
        final t = line.trim();
        if (t.isEmpty || t.startsWith('#') || !t.contains('=')) continue;
        final i = t.indexOf('=');
        merged[t.substring(0, i).trim()] = t.substring(i + 1).trim();
      }
    }

    addLines(_env.text);
    addLines(text); // imported file wins on duplicate keys
    setState(() => _env.text = merged.entries.map((e) => '${e.key}=${e.value}').join('\n'));
  }

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final body = {
        'name': _name.text.trim(),
        'runtime': _runtime,
        'source_type': _source,
        'repo_url': _source == 'git' ? _repo.text.trim() : null,
        'local_path': _source == 'local' ? _local.text.trim() : null,
        'branch': _branch.text.trim(),
        if (_runtime == 'node') 'entry_file': _entry.text.trim().isEmpty ? null : _entry.text.trim(),
        if (_runtime == 'node') 'env_json': _linesToEnvJson(_env.text),
        'direct_port': _port.text.trim().isNotEmpty ? int.tryParse(_port.text.trim()) : null,
        'autodeploy': (_source == 'git' && _autodeploy) ? 1 : 0,
        'exposure_mode': _exposure == 'none' ? null : _exposure,
        'subdomain': _exposure == 'subdomain' ? _subdomain.text.trim() : null,
        'domain': _exposure == 'path' ? _domain.text.trim() : null,
        'path': _exposure == 'path' ? _path.text.trim() : null,
      };
      if (_editing) {
        await Api.instance.updateSite(widget.site!['id'], body);
      } else {
        await Api.instance.createSite(body);
      }
      // remember these as defaults for the next site
      await Api.instance.saveCfg({
        'runtime': _runtime,
        'source_type': _source,
        'branch': _branch.text.trim(),
        if (_exposure == 'path') 'domain': _domain.text.trim(),
        'exposure_mode': _exposure,
      });
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(_editing ? 'Edit site' : 'New site'),
      content: SizedBox(
        width: 420,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: _name,
                readOnly: _editing, // name is the key — can't rename
                decoration: InputDecoration(
                  labelText: 'Name (unique)',
                  helperText: _editing ? 'name cannot be changed' : null,
                ),
              ),
              const SizedBox(height: 8),
              DropdownButtonFormField<String>(
                value: _runtime,
                decoration: const InputDecoration(labelText: 'Runtime'),
                items: const [
                  DropdownMenuItem(value: 'static', child: Text('static (Flutter _deploy)')),
                  DropdownMenuItem(value: 'nodered', child: Text('Node-RED')),
                  DropdownMenuItem(value: 'node', child: Text('node backend')),
                ],
                onChanged: (v) => setState(() => _runtime = v!),
              ),
              if (_runtime != 'nodered') ...[
                const SizedBox(height: 8),
                DropdownButtonFormField<String>(
                  value: _source,
                  decoration: const InputDecoration(labelText: 'Source'),
                  items: const [
                    DropdownMenuItem(value: 'git', child: Text('Git repo (clone/pull)')),
                    DropdownMenuItem(value: 'local', child: Text('Local folder (on server)')),
                  ],
                  onChanged: (v) => setState(() => _source = v!),
                ),
                if (_source == 'git') ...[
                  const SizedBox(height: 8),
                  TextField(controller: _repo, decoration: const InputDecoration(labelText: 'Git repo URL (*_deploy)')),
                  const SizedBox(height: 8),
                  TextField(controller: _branch, decoration: const InputDecoration(labelText: 'Branch')),
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    dense: true,
                    value: _autodeploy,
                    onChanged: (v) => setState(() => _autodeploy = v),
                    title: const Text('Auto-deploy (CI/CD)', style: TextStyle(fontSize: 14)),
                    subtitle: const Text('Poll this branch and Pull & Deploy on new commits',
                        style: TextStyle(fontSize: 11)),
                    secondary: const Icon(Icons.sync),
                  ),
                ],
                if (_source == 'local') ...[
                  const SizedBox(height: 8),
                  TextField(
                    controller: _local,
                    decoration: InputDecoration(
                      labelText: 'Local folder path',
                      hintText: r'e.g. /Users/.../UI-QC-...-DEPLOY  or  D:\builds\app1',
                      suffixIcon: IconButton(
                        tooltip: 'Browse',
                        icon: const Icon(Icons.folder_open),
                        onPressed: () async {
                          final start = _local.text.trim().isNotEmpty
                              ? _local.text.trim()
                              : _cfg['last_folder'] as String?;
                          final picked = await FolderPicker.show(context, start: start);
                          if (picked != null) {
                            setState(() => _local.text = picked);
                            await Api.instance.saveCfg({'last_folder': picked});
                          }
                        },
                      ),
                    ),
                  ),
                ],
              ],
              if (_runtime == 'node') ...[
                const SizedBox(height: 8),
                TextField(
                  controller: _entry,
                  decoration: const InputDecoration(
                    labelText: 'Entry file',
                    hintText: 'default: server.js  (see package.json "main")',
                  ),
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: _env,
                  minLines: 1,
                  maxLines: 5,
                  decoration: const InputDecoration(
                    labelText: 'Env vars (one per line: KEY=VALUE)',
                    hintText: 'DB_HOST=1.2.3.4\nNODE_ENV=production',
                  ),
                ),
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton.icon(
                    onPressed: _importEnvFile,
                    icon: const Icon(Icons.upload_file, size: 16),
                    label: const Text('Import .env file (merge — nothing deleted)',
                        style: TextStyle(fontSize: 12)),
                  ),
                ),
              ],
              const SizedBox(height: 8),
              TextField(
                controller: _port,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(labelText: 'Direct port (layer 1), e.g. 9500'),
              ),
              const SizedBox(height: 8),
              DropdownButtonFormField<String>(
                value: _exposure,
                decoration: const InputDecoration(labelText: 'Front exposure (layer 2)'),
                items: const [
                  DropdownMenuItem(value: 'none', child: Text('none (direct port only)')),
                  DropdownMenuItem(value: 'subdomain', child: Text('subdomain')),
                  DropdownMenuItem(value: 'path', child: Text('path')),
                ],
                onChanged: (v) => setState(() => _exposure = v!),
              ),
              if (_exposure == 'subdomain')
                TextField(controller: _subdomain, decoration: const InputDecoration(labelText: 'Subdomain, e.g. app1.qc.local')),
              if (_exposure == 'path') ...[
                TextField(controller: _domain, decoration: const InputDecoration(labelText: 'Domain, e.g. qc.local')),
                TextField(controller: _path, decoration: const InputDecoration(labelText: 'Path, e.g. webapp1')),
              ],
              if (_error != null) ...[
                const SizedBox(height: 10),
                Text(_error!, style: const TextStyle(color: Colors.redAccent)),
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
        FilledButton(
          onPressed: _busy ? null : _save,
          child: _busy
              ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
              : Text(_editing ? 'Save' : 'Create'),
        ),
      ],
    );
  }
}

// ---------------- Node-RED settings editor ----------------
// Edits settings.user.js (user overrides that survive restarts). Common toggles
// (CORS) are one click; advanced users edit the JS directly.
class NoderedSettingsDialog extends StatefulWidget {
  final Map<String, dynamic> site;
  const NoderedSettingsDialog({super.key, required this.site});
  @override
  State<NoderedSettingsDialog> createState() => _NoderedSettingsDialogState();
}

class _NoderedSettingsDialogState extends State<NoderedSettingsDialog> {
  final _ctrl = TextEditingController();
  final _authUser = TextEditingController(text: 'admin');
  final _authPass = TextEditingController();
  bool _authOn = false;
  bool _loading = true;
  bool _busy = false;
  String? _error;

  static const _corsLine = "  httpNodeCors: { origin: '*', methods: 'GET,PUT,POST,DELETE,OPTIONS' },";

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final c = await Api.instance.noderedSettings(widget.site['id']);
      _ctrl.text = _sanitizeHeader(c);
      _authOn = _authEnabled;
      final m = RegExp(r"^\s*adminAuth\s*:.*username:\s*'([^']*)'", multiLine: true)
          .firstMatch(_body);
      if (m != null) _authUser.text = m.group(1)!;
    } catch (e) {
      _error = '$e';
    }
    if (mounted) setState(() => _loading = false);
  }

  // The file's doc header contains example lines (// httpNodeCors: …) that must
  // never be uncommented — all toggles below operate ONLY on the part from
  // `module.exports` onward. This also repairs files broken by the old toggle,
  // which could uncomment a header example and make the file invalid JS.
  int get _exportsStart =>
      RegExp(r'module\.exports\s*=\s*\{').firstMatch(_ctrl.text)?.start ?? 0;
  String get _head => _ctrl.text.substring(0, _exportsStart);
  String get _body => _ctrl.text.substring(_exportsStart);

  static String _sanitizeHeader(String t) {
    final ei = RegExp(r'module\.exports\s*=\s*\{').firstMatch(t)?.start;
    if (ei == null) return t;
    final head = t.substring(0, ei).replaceAllMapped(
          RegExp(r'^(\s*)((?:httpNodeCors|adminAuth)\s*:.*)$', multiLine: true),
          (m) => '${m.group(1)}// ${m.group(2)}',
        );
    return head + t.substring(ei);
  }

  bool get _corsEnabled =>
      RegExp(r'^\s*httpNodeCors\s*:', multiLine: true).hasMatch(_body);

  bool get _authEnabled =>
      RegExp(r'^\s*adminAuth\s*:', multiLine: true).hasMatch(_body);

  // Toggle the CORS line INSIDE module.exports: uncomment/insert it, or comment it out.
  void _toggleCors(bool on) {
    final head = _head;
    var body = _body;
    if (on) {
      final commented = RegExp(r'^\s*//\s*(httpNodeCors\s*:.*)$', multiLine: true);
      if (commented.hasMatch(body)) {
        body = body.replaceFirstMapped(commented, (m) => '  ${m.group(1)}');
      } else if (!_corsEnabled) {
        body = body.replaceFirst(
            RegExp(r'module\.exports\s*=\s*\{'), 'module.exports = {\n$_corsLine');
      }
    } else {
      body = body.replaceAllMapped(
        RegExp(r'^(\s*)(httpNodeCors\s*:.*)$', multiLine: true),
        (m) => '${m.group(1)}// ${m.group(2)}',
      );
    }
    setState(() => _ctrl.text = head + body);
  }

  // Apply the editor-login switch to the settings text: insert/replace a
  // one-line adminAuth (password bcrypt-hashed server-side), or comment it out.
  Future<void> _applyAuth() async {
    if (_authOn) {
      final user = _authUser.text.trim();
      if (!RegExp(r'^[a-zA-Z0-9._-]+$').hasMatch(user)) {
        throw Exception('username: letters/numbers/._- only');
      }
      if (_authPass.text.isEmpty) {
        if (_authEnabled) return; // keep the existing credentials
        throw Exception('enter a password to enable editor login');
      }
      final hash = await Api.instance.noderedHash(widget.site['id'], _authPass.text);
      final line =
          "  adminAuth: { type: 'credentials', users: [{ username: '$user', password: '$hash', permissions: '*' }] },";
      final head = _head;
      var body = _body;
      final active = RegExp(r'^\s*adminAuth\s*:.*$', multiLine: true);
      final commented = RegExp(r'^\s*//\s*adminAuth\s*:.*$', multiLine: true);
      if (active.hasMatch(body)) {
        body = body.replaceFirst(active, line);
      } else if (commented.hasMatch(body)) {
        body = body.replaceFirst(commented, line);
      } else {
        body = body.replaceFirst(RegExp(r'module\.exports\s*=\s*\{'), 'module.exports = {\n$line');
      }
      _ctrl.text = head + body;
    } else if (_authEnabled) {
      _ctrl.text = _head +
          _body.replaceAllMapped(
            RegExp(r'^(\s*)(adminAuth\s*:.*)$', multiLine: true),
            (m) => '${m.group(1)}// ${m.group(2)}',
          );
    }
  }

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await _applyAuth();
      await Api.instance.saveNoderedSettings(widget.site['id'], _ctrl.text);
      if (!mounted) return;
      // ask whether to restart now so the change takes effect
      final restart = await showDialog<bool>(
        context: context,
        builder: (_) => AlertDialog(
          content: const Text('Saved. Restart Node-RED now to apply the new settings?'),
          actions: [
            TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Later')),
            FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Restart now')),
          ],
        ),
      );
      if (mounted) Navigator.of(context).pop(restart == true);
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text('Node-RED settings · ${widget.site['name']}'),
      content: SizedBox(
        width: 560,
        child: _loading
            ? const SizedBox(height: 80, child: Center(child: CircularProgressIndicator()))
            : Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    dense: true,
                    value: _corsEnabled,
                    onChanged: _toggleCors,
                    title: const Text('Enable CORS (httpNodeCors)', style: TextStyle(fontSize: 14)),
                    subtitle: const Text('Allow API/HTTP-In nodes to be called from any origin',
                        style: TextStyle(fontSize: 11)),
                  ),
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    dense: true,
                    value: _authOn,
                    onChanged: (v) => setState(() => _authOn = v),
                    title: const Text('Editor login (adminAuth)', style: TextStyle(fontSize: 14)),
                    subtitle: const Text('Require username/password to open the flow editor',
                        style: TextStyle(fontSize: 11)),
                  ),
                  if (_authOn)
                    Row(children: [
                      Expanded(
                        child: TextField(
                          controller: _authUser,
                          decoration: const InputDecoration(labelText: 'Username', isDense: true),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: TextField(
                          controller: _authPass,
                          obscureText: true,
                          decoration: InputDecoration(
                            labelText: _authEnabled ? 'New password (blank = keep)' : 'Password',
                            isDense: true,
                          ),
                        ),
                      ),
                    ]),
                  const SizedBox(height: 8),
                  const Text('settings.user.js  (survives restarts / redeploys)',
                      style: TextStyle(fontSize: 12, color: Colors.white54)),
                  const SizedBox(height: 4),
                  TextField(
                    controller: _ctrl,
                    minLines: 8,
                    maxLines: 16,
                    style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
                    decoration: const InputDecoration(border: OutlineInputBorder()),
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 8),
                    Text(_error!, style: const TextStyle(color: Colors.redAccent, fontSize: 12)),
                  ],
                ],
              ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
        FilledButton(
          onPressed: _busy || _loading ? null : _save,
          child: _busy
              ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
              : const Text('Save'),
        ),
      ],
    );
  }
}

// ---------------- Site detail ----------------
class SiteDetailPage extends StatefulWidget {
  final Map<String, dynamic> site;
  const SiteDetailPage({super.key, required this.site});
  @override
  State<SiteDetailPage> createState() => _SiteDetailPageState();
}

class _SiteDetailPageState extends State<SiteDetailPage> {
  late Map<String, dynamic> s = widget.site;
  String get _channel => 'site-${s['id']}';
  Map<String, dynamic> _metrics = {};
  Timer? _metricsTimer;

  bool get _isProcess => s['runtime'] == 'nodered' || s['runtime'] == 'node';

  @override
  void initState() {
    super.initState();
    if (_isProcess) {
      _loadMetrics();
      _metricsTimer = Timer.periodic(const Duration(seconds: 3), (_) => _loadMetrics());
    }
  }

  @override
  void dispose() {
    _metricsTimer?.cancel();
    super.dispose();
  }

  Future<void> _loadMetrics() async {
    if (!mounted || pageHidden()) return;
    final m = await Api.instance.processMetrics(s['id']);
    if (mounted) setState(() => _metrics = m);
  }

  Future<void> _act(String path, [Map<String, dynamic>? body]) async {
    try {
      await Api.instance.action(s['id'], path, body);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
      }
    }
  }

  Future<void> _editNoderedSettings() async {
    final restart = await showDialog<bool>(
      context: context,
      builder: (_) => NoderedSettingsDialog(site: s),
    );
    // If the user chose to apply now, restart Node-RED so the new settings load.
    if (restart == true) await _act('restart');
  }

  // Live URL of the site via the direct port (layer 1), using the host the panel
  // is loaded from. Null when the port is disabled.
  String? _directUrl() {
    final p = s['direct_port'];
    if (p == null || s['direct_port_enabled'] != 1) return null;
    final host = Uri.base.host.isEmpty ? 'localhost' : Uri.base.host;
    return 'http://$host:$p';
  }

  // Live URL via the front (layer 2), respecting subdomain/path + SSL.
  String? _frontUrl() {
    final scheme = s['ssl_enabled'] == 1 ? 'https' : 'http';
    final sub = (s['subdomain'] ?? '').toString();
    final dom = (s['domain'] ?? '').toString();
    if (s['exposure_mode'] == 'subdomain' && sub.isNotEmpty) return '$scheme://$sub';
    if (s['exposure_mode'] == 'path' && dom.isNotEmpty) {
      return '$scheme://$dom/${s['path'] ?? ''}';
    }
    return null;
  }

  Future<void> _open(String url) async {
    final ok = await launchUrl(Uri.parse(url), webOnlyWindowName: '_blank');
    if (!ok && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Cannot open $url')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final runtime = s['runtime'] ?? 'static';
    final isStatic = runtime == 'static';
    final isProcess = runtime == 'nodered' || runtime == 'node';
    final portOn = s['direct_port_enabled'] == 1;
    final hasExposure = s['exposure_mode'] != null;
    final runLabel = runtime == 'node'
        ? 'Node.js (Express)'
        : runtime == 'nodered'
            ? 'Node-RED'
            : 'Static site';

    return Scaffold(
      appBar: AppBar(
        title: Text(s['name']),
        actions: [
          IconButton(
            tooltip: 'Edit settings',
            icon: const Icon(Icons.edit),
            onPressed: () async {
              final saved = await showDialog<bool>(
                context: context,
                builder: (_) => CreateSiteDialog(site: s),
              );
              if (saved == true) {
                final fresh = await Api.instance.sites();
                final updated = fresh.firstWhere((e) => e['id'] == s['id'], orElse: () => s);
                setState(() => s = updated);
              }
            },
          ),
        ],
      ),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _group('Open', [
              if (_directUrl() != null)
                _btn('Open :${s['direct_port']}', Icons.open_in_new, () => _open(_directUrl()!)),
              if (_frontUrl() != null) _btn('Open front', Icons.public, () => _open(_frontUrl()!)),
            ]),
            _group(runLabel, [
              if (isStatic || runtime == 'node')
                _btn('Pull & Deploy', Icons.cloud_download, () => _act('deploy')),
              if (isProcess) _btn('Start', Icons.play_arrow, () => _act('start')),
              if (isProcess) _btn('Restart', Icons.restart_alt, () => _act('restart')),
              if (isProcess) _btn('Stop', Icons.stop, () => _act('stop')),
              if (isProcess) _btn('View log', Icons.article, () => _act('logs')),
              if (runtime == 'nodered') _btn('Settings (CORS…)', Icons.tune, _editNoderedSettings),
            ]),
            // nginx/SSL only matter for static sites or anything with a front exposure.
            // A plain node/Node-RED app (no front) is PM2-only — no web section.
            if (isStatic || hasExposure)
              _group('Web · front', [
                if (isStatic && s['direct_port'] != null)
                  _btn(portOn ? 'Disable port' : 'Enable port', Icons.electrical_services, () async {
                    await _act('port', {'enabled': !portOn});
                    setState(() => s['direct_port_enabled'] = portOn ? 0 : 1);
                  }),
                _btn('Reload nginx', Icons.refresh, () => _act('reload')),
                if (hasExposure) _btn('Issue SSL', Icons.lock, () => _act('ssl/issue')),
                if (hasExposure) _btn('Disable SSL', Icons.lock_open, () => _act('ssl/disable')),
              ]),
            if (Api.instance.isAdmin)
              _group('Admin', [
                _btn('Console', Icons.terminal, () {
                  Navigator.of(context).push(MaterialPageRoute(
                    builder: (_) => ShellConsolePage(site: s['name'], title: 'Console · ${s['name']}'),
                  ));
                }),
              ]),
            _group('Danger', [_btn('Delete', Icons.delete, _confirmDelete, danger: true)]),
            const SizedBox(height: 12),
            _infoBar(),
            if (_isProcess) ...[
              const SizedBox(height: 8),
              _metricsBar(),
            ],
            const SizedBox(height: 12),
            Expanded(child: LogConsole(channel: _channel)),
          ],
        ),
      ),
    );
  }

  Widget _metricsBar() {
    final m = _metrics;
    if (m.isEmpty) return const SizedBox.shrink();
    final status = (m['status'] ?? 'unknown').toString();
    final online = status == 'online';
    final mem = m['memory'] is num ? '${(m['memory'] / 1048576).toStringAsFixed(0)} MB' : '-';
    final cpu = m['cpu'] is num ? '${m['cpu']}%' : '-';
    String up = '-';
    if (m['uptime'] is num && online) {
      final secs = (DateTime.now().millisecondsSinceEpoch - (m['uptime'] as num)) ~/ 1000;
      if (secs >= 0) {
        if (secs < 60) {
          up = '${secs}s';
        } else if (secs < 3600) {
          up = '${secs ~/ 60}m';
        } else if (secs < 86400) {
          up = '${secs ~/ 3600}h';
        } else {
          up = '${secs ~/ 86400}d';
        }
      }
    }
    Widget chip(IconData i, String v) => Chip(
          avatar: Icon(i, size: 14),
          label: Text(v, style: const TextStyle(fontSize: 11)),
          visualDensity: VisualDensity.compact,
        );
    final color = online ? Colors.green : (status == 'errored' ? Colors.red : Colors.grey);
    return Wrap(spacing: 8, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
      Chip(
        label: Text(status, style: const TextStyle(fontSize: 11)),
        backgroundColor: color.withValues(alpha: 0.2),
        side: BorderSide(color: color),
        visualDensity: VisualDensity.compact,
      ),
      chip(Icons.memory, 'CPU $cpu'),
      chip(Icons.sd_storage, mem),
      chip(Icons.restart_alt, 'restarts ${m['restarts'] ?? 0}'),
      chip(Icons.schedule, 'up $up'),
      if (m['instances'] != null && (m['instances'] as num) > 1) chip(Icons.copy_all, 'x${m['instances']}'),
    ]);
  }

  Widget _infoBar() {
    final front = _frontUrl();
    final chips = <String>[
      'runtime: ${s['runtime']}',
      if (s['direct_port'] != null) 'port: ${s['direct_port']}',
      if (front != null) front,
      if (s['last_commit'] != null) 'commit: ${s['last_commit']}',
    ];
    return Wrap(
      spacing: 8,
      children: chips.map((c) => Chip(label: Text(c, style: const TextStyle(fontSize: 11)))).toList(),
    );
  }

  Future<void> _confirmDelete() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text('Delete ${s['name']}?'),
        content: const Text('Removes nginx config + DB record. Files on disk are kept.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Delete')),
        ],
      ),
    );
    if (ok == true) {
      await Api.instance.deleteSite(s['id']);
      if (mounted) Navigator.of(context).pop();
    }
  }

  // A labelled row of action buttons; hidden entirely when it has no buttons.
  Widget _group(String label, List<Widget> buttons) {
    if (buttons.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(label.toUpperCase(),
            style: const TextStyle(fontSize: 10.5, color: Colors.white38, letterSpacing: 0.8)),
        const SizedBox(height: 5),
        Wrap(spacing: 8, runSpacing: 8, children: buttons),
      ]),
    );
  }

  Widget _btn(String label, IconData icon, VoidCallback onTap, {bool danger = false}) {
    return danger
        ? OutlinedButton.icon(
            onPressed: onTap,
            icon: Icon(icon, size: 18, color: Colors.redAccent),
            label: Text(label, style: const TextStyle(color: Colors.redAccent)),
          )
        : FilledButton.tonalIcon(onPressed: onTap, icon: Icon(icon, size: 18), label: Text(label));
  }
}

// Self-service password change for the logged-in user.
class _ChangePasswordDialog extends StatefulWidget {
  const _ChangePasswordDialog();
  @override
  State<_ChangePasswordDialog> createState() => _ChangePasswordDialogState();
}

class _ChangePasswordDialogState extends State<_ChangePasswordDialog> {
  final _current = TextEditingController();
  final _next = TextEditingController();
  String? _msg;
  bool _busy = false;

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _msg = null;
    });
    try {
      await Api.instance.changeMyPassword(_current.text, _next.text);
      if (mounted) {
        Navigator.pop(context);
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Password changed.')));
      }
    } catch (e) {
      setState(() => _msg = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Change my password'),
      content: SizedBox(
        width: 340,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: _current, obscureText: true, decoration: const InputDecoration(labelText: 'Current password')),
          const SizedBox(height: 8),
          TextField(controller: _next, obscureText: true, decoration: const InputDecoration(labelText: 'New password (min 4)')),
          if (_msg != null) ...[
            const SizedBox(height: 10),
            Text(_msg!, style: const TextStyle(color: Colors.redAccent)),
          ],
        ]),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(
          onPressed: _busy ? null : _save,
          child: _busy
              ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
              : const Text('Change'),
        ),
      ],
    );
  }
}
