import 'package:flutter/material.dart';
import 'api.dart';
import 'download.dart';

/// History of automatic (CI/CD) deploys — when the git watcher pulled + deployed
/// each site. Kept in the DB and pruned by the same log-retention setting.
class AutoDeployLogPage extends StatefulWidget {
  const AutoDeployLogPage({super.key});
  @override
  State<AutoDeployLogPage> createState() => _AutoDeployLogPageState();
}

class _AutoDeployLogPageState extends State<AutoDeployLogPage> {
  late Future<List<Map<String, dynamic>>> _future;
  String _q = '';

  @override
  void initState() {
    super.initState();
    _reload();
  }

  void _reload() => setState(() => _future = Api.instance.autodeployLog(limit: 2000));

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Auto-deploy log'),
        actions: [IconButton(onPressed: _reload, icon: const Icon(Icons.refresh))],
      ),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.all(12),
          child: TextField(
            decoration: const InputDecoration(
              prefixIcon: Icon(Icons.search),
              hintText: 'filter (site / commit)',
              isDense: true,
              border: OutlineInputBorder(),
            ),
            onChanged: (v) => setState(() => _q = v.toLowerCase()),
          ),
        ),
        Expanded(
          child: FutureBuilder<List<Map<String, dynamic>>>(
            future: _future,
            builder: (context, snap) {
              if (snap.connectionState != ConnectionState.done) {
                return const Center(child: CircularProgressIndicator());
              }
              if (snap.hasError) return Center(child: Text('Error: ${snap.error}'));
              var rows = snap.data ?? [];
              if (_q.isNotEmpty) {
                rows = rows.where((r) {
                  final s = '${r['site_name']} ${r['from_commit']} ${r['to_commit']}'.toLowerCase();
                  return s.contains(_q);
                }).toList();
              }
              if (rows.isEmpty) {
                return const Center(
                    child: Text('ยังไม่มี auto-deploy — เปิดสวิตช์ Auto-deploy (CI/CD) ที่ site ก่อน',
                        style: TextStyle(color: Colors.white54)));
              }
              return ListView.separated(
                itemCount: rows.length,
                separatorBuilder: (_, __) => const Divider(height: 1),
                itemBuilder: (_, i) {
                  final r = rows[i];
                  final ok = r['ok'] == 1 || r['ok'] == true;
                  return ListTile(
                    dense: true,
                    leading: Icon(ok ? Icons.check_circle : Icons.error,
                        size: 20, color: ok ? Colors.greenAccent : Colors.redAccent),
                    title: Text(
                      '${r['site_name']}   ${r['from_commit'] ?? 'none'} → ${r['to_commit'] ?? ''}',
                      style: const TextStyle(fontWeight: FontWeight.w600, fontFamily: 'monospace', fontSize: 13),
                    ),
                    subtitle: (r['message'] != null && '${r['message']}'.isNotEmpty)
                        ? Text('${r['message']}', style: const TextStyle(color: Colors.redAccent, fontSize: 12))
                        : Text(ok ? 'pulled & deployed' : 'failed', style: const TextStyle(fontSize: 12, color: Colors.white54)),
                    trailing: Text('${r['ts']}', style: const TextStyle(fontSize: 11, color: Colors.white54)),
                  );
                },
              );
            },
          ),
        ),
      ]),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () async {
          final rows = await Api.instance.autodeployLog(limit: 5000);
          final text = rows
              .map((r) => '${r['ts']}\t${r['site_name']}\t${r['from_commit'] ?? ''}\t${r['to_commit'] ?? ''}\t${(r['ok'] == 1) ? 'ok' : 'fail'}\t${r['message'] ?? ''}')
              .join('\n');
          downloadText('autodeploy.tsv', text);
        },
        icon: const Icon(Icons.download),
        label: const Text('Export'),
      ),
    );
  }
}
