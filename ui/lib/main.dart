import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'api.dart';
import 'console.dart';
import 'requirements.dart';
import 'folder_picker.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Api.instance.restore(); // remember previous login across refreshes
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

  @override
  void initState() {
    super.initState();
    _reload();
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
        return Colors.green;
      case 'error':
        return Colors.red;
      default:
        return Colors.grey;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('WEBMANAGER'),
        actions: [
          IconButton(
            tooltip: 'Install requirements',
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => const RequirementsPage()),
            ),
            icon: const Icon(Icons.fact_check),
          ),
          IconButton(onPressed: _reload, icon: const Icon(Icons.refresh)),
          IconButton(
            tooltip: 'Logout',
            onPressed: () async {
              await Api.instance.logout();
              if (context.mounted) {
                Navigator.of(context).pushReplacement(
                  MaterialPageRoute(builder: (_) => const AuthGate()),
                );
              }
            },
            icon: const Icon(Icons.logout),
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
          if (sites.isEmpty) {
            return const Center(child: Text('No sites yet — create one.'));
          }
          return ListView.separated(
            padding: const EdgeInsets.all(12),
            itemCount: sites.length,
            separatorBuilder: (_, __) => const SizedBox(height: 8),
            itemBuilder: (_, i) {
              final s = sites[i];
              return Card(
                child: ListTile(
                  leading: Icon(_runtimeIcon(s['runtime'])),
                  title: Text(s['name'], style: const TextStyle(fontWeight: FontWeight.w600)),
                  subtitle: Text(_subtitle(s)),
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
                      label: Text(s['status'] ?? 'new', style: const TextStyle(fontSize: 11)),
                      backgroundColor: _statusColor(s['status']).withValues(alpha: 0.2),
                      side: BorderSide(color: _statusColor(s['status'])),
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
        },
      ),
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

// ---------------- Create site ----------------
class CreateSiteDialog extends StatefulWidget {
  const CreateSiteDialog({super.key});
  @override
  State<CreateSiteDialog> createState() => _CreateSiteDialogState();
}

class _CreateSiteDialogState extends State<CreateSiteDialog> {
  // Prefill from remembered config so repeat entries don't need re-typing.
  static Map<String, dynamic> get _cfg => Api.instance.cfg;
  final _name = TextEditingController();
  final _repo = TextEditingController();
  final _local = TextEditingController();
  final _branch = TextEditingController(text: _cfg['branch'] ?? 'main');
  final _port = TextEditingController();
  final _subdomain = TextEditingController();
  final _domain = TextEditingController(text: _cfg['domain'] ?? '');
  final _path = TextEditingController();
  late String _runtime = _cfg['runtime'] ?? 'static';
  late String _source = _cfg['source_type'] ?? 'git';
  late String _exposure = _cfg['exposure_mode'] ?? 'subdomain';
  String? _error;
  bool _busy = false;

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await Api.instance.createSite({
        'name': _name.text.trim(),
        'runtime': _runtime,
        'source_type': _source,
        if (_source == 'git' && _repo.text.trim().isNotEmpty) 'repo_url': _repo.text.trim(),
        if (_source == 'local' && _local.text.trim().isNotEmpty) 'local_path': _local.text.trim(),
        'branch': _branch.text.trim(),
        if (_port.text.trim().isNotEmpty) 'direct_port': int.tryParse(_port.text.trim()),
        'exposure_mode': _exposure,
        if (_exposure == 'subdomain') 'subdomain': _subdomain.text.trim(),
        if (_exposure == 'path') 'domain': _domain.text.trim(),
        if (_exposure == 'path') 'path': _path.text.trim(),
      });
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
      title: const Text('New site'),
      content: SizedBox(
        width: 420,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(controller: _name, decoration: const InputDecoration(labelText: 'Name (unique)')),
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
              : const Text('Create'),
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

    return Scaffold(
      appBar: AppBar(title: Text(s['name'])),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Wrap(spacing: 8, runSpacing: 8, children: [
              if (_directUrl() != null)
                _btn('Open :${s['direct_port']}', Icons.open_in_new, () => _open(_directUrl()!)),
              if (_frontUrl() != null)
                _btn('Open front', Icons.public, () => _open(_frontUrl()!)),
              if (isStatic || runtime == 'node')
                _btn('Pull & Deploy', Icons.cloud_download, () => _act('deploy')),
              if (runtime == 'nodered') _btn('Start', Icons.play_arrow, () => _act('start')),
              if (isProcess) ...[
                _btn('Stop', Icons.stop, () => _act('stop')),
                _btn('Restart', Icons.restart_alt, () => _act('restart')),
                _btn('View log', Icons.article, () => _act('logs')),
              ],
              if (isStatic && s['direct_port'] != null)
                _btn(portOn ? 'Disable port' : 'Enable port', Icons.electrical_services, () async {
                  await _act('port', {'enabled': !portOn});
                  setState(() => s['direct_port_enabled'] = portOn ? 0 : 1);
                }),
              _btn('Reload nginx', Icons.refresh, () => _act('reload')),
              _btn('Issue SSL', Icons.lock, () => _act('ssl/issue')),
              _btn('Disable SSL', Icons.lock_open, () => _act('ssl/disable')),
              _btn('Delete', Icons.delete, _confirmDelete, danger: true),
            ]),
            const SizedBox(height: 12),
            _infoBar(),
            const SizedBox(height: 12),
            Expanded(child: LogConsole(channel: _channel)),
          ],
        ),
      ),
    );
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
