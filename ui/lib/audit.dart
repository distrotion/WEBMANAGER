import 'package:flutter/material.dart';
import 'api.dart';
import 'download.dart';
import 'timefmt.dart';

/// Admin-only audit trail: who did what, when (create/deploy/toggle/ssl/users...).
class AuditPage extends StatefulWidget {
  const AuditPage({super.key});
  @override
  State<AuditPage> createState() => _AuditPageState();
}

class _AuditPageState extends State<AuditPage> {
  late Future<List<Map<String, dynamic>>> _future;
  String _q = '';

  @override
  void initState() {
    super.initState();
    _reload();
  }

  void _reload() => setState(() => _future = Api.instance.audit(limit: 1000));

  IconData _icon(String? action) {
    final a = action ?? '';
    if (a.contains('deploy')) return Icons.cloud_download;
    if (a.contains('delete')) return Icons.delete;
    if (a.contains('user')) return Icons.person;
    if (a.contains('ssl')) return Icons.lock;
    if (a.contains('port')) return Icons.electrical_services;
    if (a.contains('console')) return Icons.terminal;
    if (a.contains('start') || a.contains('restart')) return Icons.play_arrow;
    if (a.contains('stop')) return Icons.stop;
    return Icons.history;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Audit log'),
        actions: [IconButton(onPressed: _reload, icon: const Icon(Icons.refresh))],
      ),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.all(12),
          child: TextField(
            decoration: const InputDecoration(
              prefixIcon: Icon(Icons.search),
              hintText: 'filter (user / action / target)',
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
                  final s = '${r['who']} ${r['action']} ${r['target']} ${r['detail']}'.toLowerCase();
                  return s.contains(_q);
                }).toList();
              }
              if (rows.isEmpty) return const Center(child: Text('No audit entries.'));
              return ListView.separated(
                itemCount: rows.length,
                separatorBuilder: (_, __) => const Divider(height: 1),
                itemBuilder: (_, i) {
                  final r = rows[i];
                  return ListTile(
                    dense: true,
                    leading: Icon(_icon(r['action']), size: 20),
                    title: Text('${r['action']}  ·  ${r['target'] ?? ''}',
                        style: const TextStyle(fontWeight: FontWeight.w600)),
                    subtitle: Text([
                      'by ${r['who']}',
                      if (r['detail'] != null && '${r['detail']}'.isNotEmpty) 'detail: ${r['detail']}',
                    ].join('   ')),
                    trailing: Text(localTime(r['time']), style: const TextStyle(fontSize: 11, color: Colors.white54)),
                  );
                },
              );
            },
          ),
        ),
      ]),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () async {
          final rows = await Api.instance.audit(limit: 5000);
          final text = rows
              .map((r) => '${r['time']}\t${r['who']}\t${r['action']}\t${r['target'] ?? ''}\t${r['detail'] ?? ''}')
              .join('\n');
          downloadText('audit.tsv', text);
        },
        icon: const Icon(Icons.download),
        label: const Text('Export'),
      ),
    );
  }
}
