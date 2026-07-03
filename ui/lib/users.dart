import 'package:flutter/material.dart';
import 'api.dart';

/// Admin-only page to manage login accounts (add / delete / reset password / role).
class UsersPage extends StatefulWidget {
  const UsersPage({super.key});
  @override
  State<UsersPage> createState() => _UsersPageState();
}

class _UsersPageState extends State<UsersPage> {
  late Future<List<Map<String, dynamic>>> _future;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  void _reload() => setState(() => _future = Api.instance.users());

  Future<void> _add() async {
    final ok = await showDialog<bool>(context: context, builder: (_) => const _AddUserDialog());
    if (ok == true) _reload();
  }

  Future<void> _snack(String m) async {
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  Future<void> _delete(Map<String, dynamic> u) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text('Delete user "${u['username']}"?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Delete')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await Api.instance.deleteUser(u['id']);
      _reload();
    } catch (e) {
      _snack('$e');
    }
  }

  Future<void> _resetPw(Map<String, dynamic> u) async {
    final ctl = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text('Reset password — ${u['username']}'),
        content: TextField(
          controller: ctl,
          obscureText: true,
          decoration: const InputDecoration(labelText: 'New password (min 4)'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Set')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await Api.instance.resetUserPassword(u['id'], ctl.text);
      _snack('Password updated.');
    } catch (e) {
      _snack('$e');
    }
  }

  Future<void> _toggleRole(Map<String, dynamic> u) async {
    final next = u['role'] == 'admin' ? 'user' : 'admin';
    try {
      await Api.instance.setUserRole(u['id'], next);
      _reload();
    } catch (e) {
      _snack('$e');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Users'),
        actions: [IconButton(onPressed: _reload, icon: const Icon(Icons.refresh))],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _add,
        icon: const Icon(Icons.person_add),
        label: const Text('Add user'),
      ),
      body: FutureBuilder<List<Map<String, dynamic>>>(
        future: _future,
        builder: (context, snap) {
          if (snap.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snap.hasError) return Center(child: Text('Error: ${snap.error}'));
          final users = snap.data ?? [];
          return ListView.separated(
            padding: const EdgeInsets.all(12),
            itemCount: users.length,
            separatorBuilder: (_, __) => const SizedBox(height: 6),
            itemBuilder: (_, i) {
              final u = users[i];
              final isAdmin = u['role'] == 'admin';
              final isMe = u['username'] == Api.instance.username;
              return Card(
                child: ListTile(
                  leading: Icon(isAdmin ? Icons.shield : Icons.person,
                      color: isAdmin ? Colors.amberAccent : Colors.white70),
                  title: Row(children: [
                    Text(u['username'], style: const TextStyle(fontWeight: FontWeight.w600)),
                    if (isMe)
                      const Padding(
                        padding: EdgeInsets.only(left: 8),
                        child: Text('(you)', style: TextStyle(fontSize: 11, color: Colors.white54)),
                      ),
                  ]),
                  subtitle: Text('${u['role']} · created ${u['created_at'] ?? ''}'),
                  trailing: PopupMenuButton<String>(
                    onSelected: (v) {
                      if (v == 'pw') _resetPw(u);
                      if (v == 'role') _toggleRole(u);
                      if (v == 'del') _delete(u);
                    },
                    itemBuilder: (_) => [
                      const PopupMenuItem(value: 'pw', child: Text('Reset password')),
                      PopupMenuItem(value: 'role', child: Text(isAdmin ? 'Make user' : 'Make admin')),
                      const PopupMenuItem(value: 'del', child: Text('Delete')),
                    ],
                  ),
                ),
              );
            },
          );
        },
      ),
    );
  }
}

class _AddUserDialog extends StatefulWidget {
  const _AddUserDialog();
  @override
  State<_AddUserDialog> createState() => _AddUserDialogState();
}

class _AddUserDialogState extends State<_AddUserDialog> {
  final _user = TextEditingController();
  final _pass = TextEditingController();
  String _role = 'user';
  String? _error;
  bool _busy = false;

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await Api.instance.createUser(_user.text.trim(), _pass.text, _role);
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Add user'),
      content: SizedBox(
        width: 360,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: _user, decoration: const InputDecoration(labelText: 'Username')),
          const SizedBox(height: 8),
          TextField(controller: _pass, obscureText: true, decoration: const InputDecoration(labelText: 'Password (min 4)')),
          const SizedBox(height: 8),
          DropdownButtonFormField<String>(
            value: _role,
            decoration: const InputDecoration(labelText: 'Role'),
            items: const [
              DropdownMenuItem(value: 'user', child: Text('user (deploy/manage sites)')),
              DropdownMenuItem(value: 'admin', child: Text('admin (full access + users)')),
            ],
            onChanged: (v) => setState(() => _role = v!),
          ),
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(_error!, style: const TextStyle(color: Colors.redAccent)),
          ],
        ]),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
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
