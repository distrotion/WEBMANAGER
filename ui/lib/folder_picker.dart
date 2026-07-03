import 'package:flutter/material.dart';
import 'api.dart';

/// Browse the server filesystem and pick a folder to use as a local source.
/// Returns the selected absolute path, or null if cancelled.
class FolderPicker extends StatefulWidget {
  final String? start;
  const FolderPicker({super.key, this.start});

  static Future<String?> show(BuildContext context, {String? start}) {
    return showDialog<String>(
      context: context,
      builder: (_) => FolderPicker(start: start),
    );
  }

  @override
  State<FolderPicker> createState() => _FolderPickerState();
}

class _FolderPickerState extends State<FolderPicker> {
  Map<String, dynamic>? _data;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load(widget.start);
  }

  Future<void> _load(String? path) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final d = await Api.instance.browse(path);
      setState(() => _data = d);
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final data = _data;
    final entries = (data?['entries'] as List?)?.cast<Map<String, dynamic>>() ?? [];
    final dirs = entries.where((e) => e['dir'] == true).toList();
    return AlertDialog(
      title: const Text('Locate folder on server'),
      content: SizedBox(
        width: 520,
        height: 460,
        child: Column(
          children: [
            // current path + up
            Row(children: [
              IconButton(
                tooltip: 'Up',
                icon: const Icon(Icons.arrow_upward),
                onPressed: data?['parent'] == null ? null : () => _load(data!['parent']),
              ),
              Expanded(
                child: Text(
                  data?['path']?.toString() ?? '...',
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              IconButton(
                tooltip: 'Home',
                icon: const Icon(Icons.home),
                onPressed: () => _load(null),
              ),
            ]),
            const Divider(height: 1),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.all(8),
                child: Text(_error!, style: const TextStyle(color: Colors.redAccent)),
              ),
            Expanded(
              child: _busy
                  ? const Center(child: CircularProgressIndicator())
                  : ListView.builder(
                      itemCount: dirs.length,
                      itemBuilder: (_, i) {
                        final e = dirs[i];
                        final hasIndex = e['hasIndex'] == true;
                        return ListTile(
                          dense: true,
                          leading: Icon(
                            hasIndex ? Icons.web : Icons.folder,
                            color: hasIndex ? Colors.greenAccent : Colors.amber,
                          ),
                          title: Text(e['name']),
                          subtitle: hasIndex
                              ? const Text('contains index.html — deployable',
                                  style: TextStyle(fontSize: 11, color: Colors.greenAccent))
                              : null,
                          trailing: TextButton(
                            onPressed: () => Navigator.of(context).pop(e['path'] as String),
                            child: const Text('Select'),
                          ),
                          onTap: () => _load(e['path'] as String),
                        );
                      },
                    ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(
          onPressed: data == null ? null : () => Navigator.of(context).pop(data['path'] as String),
          child: const Text('Use this folder'),
        ),
      ],
    );
  }
}
