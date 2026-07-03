import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';
import 'api.dart';
import 'console.dart';

/// Checks whether the server has everything WEBMANAGER needs (Node, Git, nginx,
/// NSSM, win-acme, Node-RED runtime, folder structure) with fix links.
class RequirementsPage extends StatefulWidget {
  const RequirementsPage({super.key});
  @override
  State<RequirementsPage> createState() => _RequirementsPageState();
}

class _RequirementsPageState extends State<RequirementsPage> {
  late Future<Map<String, dynamic>> _future;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  void _reload() => setState(() => _future = Api.instance.requirements());

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Install requirements'),
        actions: [IconButton(onPressed: _reload, icon: const Icon(Icons.refresh))],
      ),
      body: FutureBuilder<Map<String, dynamic>>(
        future: _future,
        builder: (context, snap) {
          if (snap.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snap.hasError) return Center(child: Text('Error: ${snap.error}'));
          final data = snap.data!;
          final items = (data['items'] as List).cast<Map<String, dynamic>>();
          final summary = data['summary'] as Map<String, dynamic>;
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              _header(data, summary),
              const SizedBox(height: 12),
              ...items.map(_tile),
              const SizedBox(height: 16),
              const GitCredentialsCard(),
              const SizedBox(height: 16),
              _nginxControl(),
              const SizedBox(height: 24),
              _steps(),
            ],
          );
        },
      ),
    );
  }

  Widget _header(Map data, Map summary) {
    final ok = summary['requiredOk'] == true;
    return Card(
      color: ok ? const Color(0xFF14532D) : const Color(0xFF7F1D1D),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(children: [
          Icon(ok ? Icons.check_circle : Icons.error, size: 32,
              color: ok ? Colors.greenAccent : Colors.redAccent),
          const SizedBox(width: 14),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(ok ? 'All required components present' : 'Missing required components',
                  style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
              const SizedBox(height: 4),
              Text('platform: ${data['platform']}   ·   root: ${data['root']}',
                  style: const TextStyle(fontSize: 12, color: Colors.white70)),
              if ((summary['missingOptional'] as List).isNotEmpty)
                Text('optional missing: ${(summary['missingOptional'] as List).join(', ')}',
                    style: const TextStyle(fontSize: 12, color: Colors.amberAccent)),
            ]),
          ),
        ]),
      ),
    );
  }

  Widget _tile(Map<String, dynamic> it) {
    final ok = it['ok'] == true;
    final required = it['required'] == true;
    final color = ok
        ? Colors.greenAccent
        : (required ? Colors.redAccent : Colors.amberAccent);
    final icon = ok ? Icons.check_circle : (required ? Icons.cancel : Icons.warning_amber);
    final url = (it['url'] ?? '').toString();
    return Card(
      child: ListTile(
        leading: Icon(icon, color: color),
        title: Row(children: [
          Text(it['name'], style: const TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(width: 8),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(4),
              border: Border.all(color: required ? Colors.white38 : Colors.white24),
            ),
            child: Text(required ? 'required' : 'optional',
                style: const TextStyle(fontSize: 10, color: Colors.white70)),
          ),
        ]),
        subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(it['detail'] ?? '', style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
          if (it['note'] != null)
            Text(it['note'], style: const TextStyle(fontSize: 12, color: Colors.white60)),
          if (it['requiredFor'] != null)
            Text('needed for: ${it['requiredFor']}',
                style: const TextStyle(fontSize: 12, color: Colors.white54)),
          if (!ok && it['fix'] != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Row(children: [
                const Icon(Icons.build, size: 13, color: Colors.lightBlueAccent),
                const SizedBox(width: 4),
                Flexible(
                  child: Text(it['fix'],
                      style: const TextStyle(fontSize: 12, color: Colors.lightBlueAccent, fontFamily: 'monospace')),
                ),
                IconButton(
                  tooltip: 'Copy',
                  visualDensity: VisualDensity.compact,
                  icon: const Icon(Icons.copy, size: 13),
                  onPressed: () => Clipboard.setData(ClipboardData(text: it['fix'])),
                ),
              ]),
            ),
        ]),
        trailing: url.isEmpty
            ? null
            : TextButton.icon(
                onPressed: () => launchUrl(Uri.parse(url), webOnlyWindowName: '_blank'),
                icon: const Icon(Icons.download, size: 16),
                label: const Text('Get'),
              ),
        isThreeLine: true,
      ),
    );
  }

  // (GitCredentialsCard is a separate widget below)

  Widget _nginxControl() {
    Widget b(String label, IconData icon, String action) => FilledButton.tonalIcon(
          onPressed: () => Api.instance.nginxAction(action),
          icon: Icon(icon, size: 16),
          label: Text(label),
        );
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: const [
            Icon(Icons.dns, size: 18),
            SizedBox(width: 8),
            Text('nginx control', style: TextStyle(fontWeight: FontWeight.bold)),
            SizedBox(width: 8),
            Text('(auto-switches: nginx.exe on Windows, nginx on Mac/Linux)',
                style: TextStyle(fontSize: 11, color: Colors.white54)),
          ]),
          const SizedBox(height: 10),
          Wrap(spacing: 8, runSpacing: 8, children: [
            b('Test config', Icons.fact_check, 'test'),
            b('Start', Icons.play_arrow, 'start'),
            b('Reload', Icons.refresh, 'reload'),
            b('Stop', Icons.stop, 'stop'),
          ]),
          const SizedBox(height: 12),
          const SizedBox(height: 220, child: LogConsole(channel: 'system')),
        ]),
      ),
    );
  }

  Widget _steps() {
    const steps = [
      '1. Install Node.js LTS + Git (on PATH).',
      '2. Drop nssm.exe → <root>\\tools ; extract nginx → <root>\\nginx ; win-acme → <root>\\tools\\win-acme.',
      '3. Build UI: cd ui && flutter build web --release.',
      '4. Elevated PowerShell: cd deploy && .\\install.ps1 -Root D:\\webmanager -AdminPass "<pass>".',
      '5. (Node-RED) .\\install-nodered.ps1 -Root D:\\webmanager.',
      '6. Open Firewall 80/443 + direct ports; restrict the manager port.',
    ];
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: const [
            Icon(Icons.list_alt, size: 18),
            SizedBox(width: 8),
            Text('Install steps (Windows Server 2019)',
                style: TextStyle(fontWeight: FontWeight.bold)),
          ]),
          const SizedBox(height: 10),
          ...steps.map((s) => Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Text(s, style: const TextStyle(fontSize: 13)),
              )),
        ]),
      ),
    );
  }
}

/// Set a GitHub Personal Access Token so private *_deploy repos can be pulled
/// without any console/SSH — the manager injects it non-interactively.
class GitCredentialsCard extends StatefulWidget {
  const GitCredentialsCard({super.key});
  @override
  State<GitCredentialsCard> createState() => _GitCredentialsCardState();
}

class _GitCredentialsCardState extends State<GitCredentialsCard> {
  final _token = TextEditingController();
  final _testUrl = TextEditingController();
  bool _hasToken = false;
  bool _busy = false;
  String? _msg;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    final has = await Api.instance.gitHasToken();
    if (mounted) setState(() => _hasToken = has);
  }

  Future<void> _save() async {
    if (_token.text.trim().isEmpty) return;
    setState(() => _busy = true);
    try {
      await Api.instance.saveGitToken(_token.text.trim());
      _token.clear();
      setState(() => _msg = 'Token saved.');
      await _refresh();
    } catch (e) {
      setState(() => _msg = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _clear() async {
    await Api.instance.clearGitToken();
    setState(() => _msg = 'Token removed.');
    await _refresh();
  }

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            const Icon(Icons.key, size: 18),
            const SizedBox(width: 8),
            const Text('Git credentials (private repos)',
                style: TextStyle(fontWeight: FontWeight.bold)),
            const SizedBox(width: 8),
            Icon(_hasToken ? Icons.check_circle : Icons.remove_circle_outline,
                size: 16, color: _hasToken ? Colors.greenAccent : Colors.white38),
            Text(_hasToken ? ' token set' : ' no token',
                style: const TextStyle(fontSize: 12, color: Colors.white60)),
          ]),
          const SizedBox(height: 6),
          const Text(
            'Optional. The server uses its own git login (credential manager) automatically, '
            'so if this machine can already clone your private repos, you need nothing here. '
            'Set a shared token only if the server has no git access — it applies to all users.',
            style: TextStyle(fontSize: 12, color: Colors.white60),
          ),
          const SizedBox(height: 10),
          Row(children: [
            Expanded(
              child: TextField(
                controller: _token,
                obscureText: true,
                decoration: const InputDecoration(
                  isDense: true,
                  border: OutlineInputBorder(),
                  labelText: 'GitHub Personal Access Token',
                  hintText: 'ghp_...',
                ),
              ),
            ),
            const SizedBox(width: 8),
            FilledButton(onPressed: _busy ? null : _save, child: const Text('Save')),
            if (_hasToken) ...[
              const SizedBox(width: 6),
              OutlinedButton(onPressed: _busy ? null : _clear, child: const Text('Clear')),
            ],
          ]),
          const SizedBox(height: 10),
          Row(children: [
            Expanded(
              child: TextField(
                controller: _testUrl,
                decoration: const InputDecoration(
                  isDense: true,
                  border: OutlineInputBorder(),
                  labelText: 'Test a repo URL (output in the console below)',
                  hintText: 'https://github.com/distrotion/SOME-DEPLOY',
                ),
              ),
            ),
            const SizedBox(width: 8),
            FilledButton.tonal(
              onPressed: () {
                if (_testUrl.text.trim().isNotEmpty) {
                  Api.instance.testGitToken(_testUrl.text.trim());
                }
              },
              child: const Text('Test'),
            ),
          ]),
          if (_msg != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(_msg!, style: const TextStyle(fontSize: 12, color: Colors.lightBlueAccent)),
            ),
        ]),
      ),
    );
  }
}
