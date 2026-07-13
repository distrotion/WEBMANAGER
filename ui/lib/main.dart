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

  @override
  void initState() {
    super.initState();
    _reload();
    _pollOverview();
    _monitTimer = Timer.periodic(const Duration(seconds: 3), (_) => _pollOverview());
  }

  @override
  void dispose() {
    _monitTimer?.cancel();
    super.dispose();
  }

  Future<void> _pollOverview() async {
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
      length: 2,
      child: Scaffold(
      appBar: AppBar(
        title: const Text('WEBMANAGER'),
        bottom: const TabBar(tabs: [
          Tab(icon: Icon(Icons.dns, size: 18), text: 'PM2 apps'),
          Tab(icon: Icon(Icons.web, size: 18), text: 'nginx / web'),
        ]),
        actions: [
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
          final pm2 = sites.where((s) => s['runtime'] == 'node' || s['runtime'] == 'nodered').toList();
          final web = sites.where((s) => s['runtime'] == 'static').toList();
          return TabBarView(children: [
            _siteList(context, pm2, 'No PM2 apps yet — create a node / Node-RED site.'),
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
              if (runtime == 'nodered') _btn('Start', Icons.play_arrow, () => _act('start')),
              if (isProcess) _btn('Restart', Icons.restart_alt, () => _act('restart')),
              if (isProcess) _btn('Stop', Icons.stop, () => _act('stop')),
              if (isProcess) _btn('View log', Icons.article, () => _act('logs')),
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
