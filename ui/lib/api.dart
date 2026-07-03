import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// Talks to the WEBMANAGER backend. Same-origin in production (UI served by the
/// backend); override with --dart-define=API_BASE=http://host:8088 for dev.
class Api {
  Api._();
  static final Api instance = Api._();

  String? _token;
  String? get token => _token;
  bool get loggedIn => _token != null;

  static const _kToken = 'wm_token';
  static const _kUser = 'wm_user';
  static const _kUserInfo = 'wm_userinfo';
  static const _kCfg = 'wm_cfg';
  String? rememberedUser;

  Map<String, dynamic>? user; // {id, username, role} of the logged-in user
  String get username => user?['username']?.toString() ?? '';
  String get role => user?['role']?.toString() ?? 'user';
  bool get isAdmin => role == 'admin';

  // Remembered create-site form defaults (runtime, source, branch, domain,
  // exposure, last-browsed folder, …) so repeat entries don't need re-typing.
  Map<String, dynamic> cfg = {};

  /// Restore saved session + form config from browser storage (call at startup).
  Future<void> restore() async {
    final prefs = await SharedPreferences.getInstance();
    _token = prefs.getString(_kToken);
    rememberedUser = prefs.getString(_kUser);
    final ui = prefs.getString(_kUserInfo);
    if (ui != null) {
      try {
        user = (jsonDecode(ui) as Map).cast<String, dynamic>();
      } catch (_) {}
    }
    final c = prefs.getString(_kCfg);
    if (c != null) {
      try {
        cfg = (jsonDecode(c) as Map).cast<String, dynamic>();
      } catch (_) {
        cfg = {};
      }
    }
  }

  /// Merge + persist form defaults.
  Future<void> saveCfg(Map<String, dynamic> patch) async {
    cfg = {...cfg, ...patch};
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kCfg, jsonEncode(cfg));
  }

  static const _defineBase = String.fromEnvironment('API_BASE', defaultValue: '');
  String get _base {
    if (_defineBase.isNotEmpty) return _defineBase;
    final o = Uri.base; // same origin the UI was served from
    return '${o.scheme}://${o.host}${o.hasPort ? ':${o.port}' : ''}';
  }

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (_token != null) 'Authorization': 'Bearer $_token',
      };

  Uri _u(String p) => Uri.parse('$_base$p');

  Future<bool> login(String username, String password) async {
    final r = await http.post(_u('/api/auth/login'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'username': username, 'password': password}));
    if (r.statusCode == 200) {
      final body = jsonDecode(r.body);
      _token = body['token'] as String;
      user = (body['user'] as Map).cast<String, dynamic>();
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_kToken, _token!);
      await prefs.setString(_kUser, username);
      await prefs.setString(_kUserInfo, jsonEncode(user));
      rememberedUser = username;
      return true;
    }
    return false;
  }

  Future<void> logout() async {
    _token = null;
    user = null;
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_kToken);
    await prefs.remove(_kUserInfo);
  }

  /// Called when the server rejects our token (expired/invalid) → drop it.
  Future<void> _onUnauthorized() async {
    _token = null;
    user = null;
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_kToken);
    await prefs.remove(_kUserInfo);
  }

  Future<Map<String, dynamic>> requirements() async {
    final r = await http.get(_u('/api/system/requirements'), headers: _headers);
    if (r.statusCode != 200) throw Exception('requirements failed: ${r.statusCode}');
    return jsonDecode(r.body) as Map<String, dynamic>;
  }

  Future<void> nginxAction(String action) async {
    await http.post(_u('/api/system/nginx/$action'), headers: _headers);
  }

  Future<bool> gitHasToken() async {
    final r = await http.get(_u('/api/system/git-credentials'), headers: _headers);
    if (r.statusCode != 200) return false;
    return jsonDecode(r.body)['hasToken'] == true;
  }

  Future<void> saveGitToken(String token) async {
    final r = await http.put(_u('/api/system/git-credentials'),
        headers: _headers, body: jsonEncode({'token': token}));
    if (r.statusCode != 200) throw Exception(jsonDecode(r.body)['error'] ?? 'save failed');
  }

  Future<void> clearGitToken() async {
    await http.delete(_u('/api/system/git-credentials'), headers: _headers);
  }

  Future<void> testGitToken(String url) async {
    await http.post(_u('/api/system/git-credentials/test'),
        headers: _headers, body: jsonEncode({'url': url}));
  }

  Future<Map<String, dynamic>> browse(String? path) async {
    final q = path == null ? '' : '?path=${Uri.encodeQueryComponent(path)}';
    final r = await http.get(_u('/api/system/browse$q'), headers: _headers);
    if (r.statusCode != 200) throw Exception(jsonDecode(r.body)['error'] ?? 'browse failed');
    return jsonDecode(r.body) as Map<String, dynamic>;
  }

  // ---- users (admin) ----
  Future<List<Map<String, dynamic>>> users() async {
    final r = await http.get(_u('/api/users'), headers: _headers);
    if (r.statusCode != 200) throw Exception('users failed: ${r.statusCode}');
    return (jsonDecode(r.body) as List).cast<Map<String, dynamic>>();
  }

  Future<void> createUser(String username, String password, String role) async {
    final r = await http.post(_u('/api/users'),
        headers: _headers, body: jsonEncode({'username': username, 'password': password, 'role': role}));
    if (r.statusCode != 201) throw Exception(jsonDecode(r.body)['error'] ?? 'create failed');
  }

  Future<void> deleteUser(int id) async {
    final r = await http.delete(_u('/api/users/$id'), headers: _headers);
    if (r.statusCode != 200) throw Exception(jsonDecode(r.body)['error'] ?? 'delete failed');
  }

  Future<void> resetUserPassword(int id, String password) async {
    final r = await http.post(_u('/api/users/$id/password'),
        headers: _headers, body: jsonEncode({'password': password}));
    if (r.statusCode != 200) throw Exception(jsonDecode(r.body)['error'] ?? 'reset failed');
  }

  Future<void> setUserRole(int id, String role) async {
    final r = await http.post(_u('/api/users/$id/role'),
        headers: _headers, body: jsonEncode({'role': role}));
    if (r.statusCode != 200) throw Exception(jsonDecode(r.body)['error'] ?? 'role failed');
  }

  Future<void> changeMyPassword(String current, String next) async {
    final r = await http.post(_u('/api/auth/change-password'),
        headers: _headers, body: jsonEncode({'current': current, 'next': next}));
    if (r.statusCode != 200) throw Exception(jsonDecode(r.body)['error'] ?? 'change failed');
  }

  Future<List<Map<String, dynamic>>> sites() async {
    final r = await http.get(_u('/api/sites'), headers: _headers);
    if (r.statusCode == 401) {
      await _onUnauthorized();
      throw Exception('unauthorized');
    }
    if (r.statusCode != 200) throw Exception('sites failed: ${r.statusCode}');
    return (jsonDecode(r.body) as List).cast<Map<String, dynamic>>();
  }

  Future<Map<String, dynamic>> createSite(Map<String, dynamic> body) async {
    final r = await http.post(_u('/api/sites'), headers: _headers, body: jsonEncode(body));
    if (r.statusCode != 201) throw Exception(jsonDecode(r.body)['error'] ?? 'create failed');
    return jsonDecode(r.body);
  }

  Future<void> deleteSite(int id) async {
    await http.delete(_u('/api/sites/$id'), headers: _headers);
  }

  /// Fire a button action that streams its logs over WebSocket.
  Future<void> action(int id, String path, [Map<String, dynamic>? body]) async {
    await http.post(_u('/api/sites/$id/$path'),
        headers: _headers, body: body == null ? null : jsonEncode(body));
  }

  /// Open the live-log socket for a channel (e.g. site-3).
  WebSocketChannel logSocket(String channel) {
    final b = _base.replaceFirst('http', 'ws');
    return WebSocketChannel.connect(Uri.parse('$b/ws?channel=$channel&token=$_token'));
  }

  /// Open an interactive shell (admin only) at /pty. Pass [site] to start in that
  /// site's folder (server resolves the path), or [cwd] for an explicit path.
  WebSocketChannel ptySocket({int cols = 80, int rows = 24, String? cwd, String? site}) {
    final b = _base.replaceFirst('http', 'ws');
    final q = site != null
        ? '&site=${Uri.encodeQueryComponent(site)}'
        : cwd != null
            ? '&cwd=${Uri.encodeQueryComponent(cwd)}'
            : '';
    return WebSocketChannel.connect(Uri.parse('$b/pty?token=$_token&cols=$cols&rows=$rows$q'));
  }

  void debugPrintBase() {
    if (kDebugMode) debugPrint('API base: $_base');
  }
}
