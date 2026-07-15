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

  /// Fleet: when a remote server is selected (hub mode), every /api/* call is
  /// routed through this hub's transparent proxy — the whole UI then operates
  /// on that server. Auth + fleet management always stay local.
  int? remoteId;
  String remoteName = '';
  bool get onRemote => remoteId != null;
  void setRemote(int? id, String name) {
    remoteId = id;
    remoteName = id == null ? '' : name;
  }

  Uri _u(String p) {
    if (remoteId != null &&
        p.startsWith('/api/') &&
        !p.startsWith('/api/auth') &&
        !p.startsWith('/api/fleet')) {
      return Uri.parse('$_base/api/fleet/remotes/$remoteId/proxy$p');
    }
    return Uri.parse('$_base$p');
  }

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

  // ---- fleet (แม่/ลูก) ----
  Future<Map<String, dynamic>> fleetInfo() async {
    final r = await http.get(_u('/api/fleet'), headers: _headers);
    if (r.statusCode != 200) throw Exception('fleet info failed');
    return jsonDecode(r.body) as Map<String, dynamic>;
  }

  Future<void> setFleetRole(String role) async {
    final r = await http.put(_u('/api/fleet'),
        headers: _headers, body: jsonEncode({'role': role}));
    if (r.statusCode != 200) throw Exception(jsonDecode(r.body)['error'] ?? 'role failed');
  }

  Future<String> genFleetToken() async {
    final r = await http.post(_u('/api/fleet/token'), headers: _headers);
    if (r.statusCode != 200) throw Exception(jsonDecode(r.body)['error'] ?? 'token failed');
    return jsonDecode(r.body)['token'] as String;
  }

  Future<void> revokeFleetToken() async {
    await http.delete(_u('/api/fleet/token'), headers: _headers);
  }

  Future<List<Map<String, dynamic>>> fleetRemotes() async {
    final r = await http.get(_u('/api/fleet/remotes'), headers: _headers);
    if (r.statusCode != 200) throw Exception('remotes failed');
    return (jsonDecode(r.body) as List).cast<Map<String, dynamic>>();
  }

  Future<void> addFleetRemote(String name, String url, String token) async {
    final r = await http.post(_u('/api/fleet/remotes'),
        headers: _headers, body: jsonEncode({'name': name, 'url': url, 'token': token}));
    if (r.statusCode != 201) throw Exception(jsonDecode(r.body)['error'] ?? 'add failed');
  }

  Future<void> deleteFleetRemote(int id) async {
    await http.delete(_u('/api/fleet/remotes/$id'), headers: _headers);
  }

  Future<void> renameFleetRemote(int id, String name, String url) async {
    final r = await http.put(_u('/api/fleet/remotes/$id'),
        headers: _headers, body: jsonEncode({'name': name, 'url': url}));
    if (r.statusCode != 200) throw Exception(jsonDecode(r.body)['error'] ?? 'rename failed');
  }

  /// Child self-registration: this server signs itself up at the hub.
  Future<void> fleetJoin(String hubUrl, String username, String password,
      String myName, String myUrl) async {
    final r = await http.post(_u('/api/fleet/join'),
        headers: _headers,
        body: jsonEncode({
          'hubUrl': hubUrl,
          'username': username,
          'password': password,
          'myName': myName,
          'myUrl': myUrl,
        }));
    if (r.statusCode != 200) throw Exception(jsonDecode(r.body)['error'] ?? 'join failed');
  }

  Future<List<Map<String, dynamic>>> fleetOverview() async {
    final r = await http.get(_u('/api/fleet/overview'), headers: _headers);
    if (r.statusCode != 200) throw Exception('overview failed');
    return (jsonDecode(r.body) as List).cast<Map<String, dynamic>>();
  }

  /// Backend build version (git hash stamped at install) — for "อัพรึยัง" checks.
  Future<String> serverVersion() async {
    try {
      final r = await http.get(_u('/api/health'));
      if (r.statusCode != 200) return '';
      return jsonDecode(r.body)['version']?.toString() ?? '';
    } catch (_) {
      return '';
    }
  }

  Future<Map<String, dynamic>> requirements() async {
    final r = await http.get(_u('/api/system/requirements'), headers: _headers);
    if (r.statusCode != 200) throw Exception('requirements failed: ${r.statusCode}');
    return jsonDecode(r.body) as Map<String, dynamic>;
  }

  Future<void> nginxAction(String action) async {
    await http.post(_u('/api/system/nginx/$action'), headers: _headers);
  }

  // ---- HTTPS panel (local CA) ----
  Future<Map<String, dynamic>> httpsStatus() async {
    final r = await http.get(_u('/api/system/https'), headers: _headers);
    if (r.statusCode != 200) throw Exception('https status failed');
    return jsonDecode(r.body) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> httpsEnable() async {
    final r = await http.post(_u('/api/system/https/enable'), headers: _headers);
    if (r.statusCode != 200) throw Exception(jsonDecode(r.body)['error'] ?? 'enable failed');
    return jsonDecode(r.body) as Map<String, dynamic>;
  }

  Future<void> httpsDisable() async {
    await http.post(_u('/api/system/https/disable'), headers: _headers);
  }

  /// Re-mint the server cert (keeps the same CA — no need to re-install it).
  Future<void> httpsRegenerate() async {
    final r = await http.post(_u('/api/system/https/regenerate'), headers: _headers);
    if (r.statusCode != 200) throw Exception(jsonDecode(r.body)['error'] ?? 'regenerate failed');
  }

  /// Absolute URL of the downloadable local-CA cert (public, no auth needed).
  String get caCertUrl => '$_base/panel-ca.crt';

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

  // Multiple per-host git credentials.
  Future<List<Map<String, dynamic>>> gitCredentials() async {
    final r = await http.get(_u('/api/system/git-credentials/list'), headers: _headers);
    if (r.statusCode != 200) return [];
    return (jsonDecode(r.body) as List).cast<Map<String, dynamic>>();
  }

  Future<void> addGitCredential(String name, String host, String token) async {
    final r = await http.post(_u('/api/system/git-credentials/list'),
        headers: _headers, body: jsonEncode({'name': name, 'host': host, 'token': token}));
    if (r.statusCode != 201) throw Exception(jsonDecode(r.body)['error'] ?? 'save failed');
  }

  Future<void> deleteGitCredential(int id) async {
    await http.delete(_u('/api/system/git-credentials/list/$id'), headers: _headers);
  }

  Future<void> testGitToken(String url) async {
    await http.post(_u('/api/system/git-credentials/test'),
        headers: _headers, body: jsonEncode({'url': url}));
  }

  // ---- Remote Gateway (raw-TCP port forward) ----
  Future<List<Map<String, dynamic>>> gateways() async {
    final r = await http.get(_u('/api/gateways'), headers: _headers);
    if (r.statusCode != 200) throw Exception('gateways failed');
    return (jsonDecode(r.body) as List).cast<Map<String, dynamic>>();
  }

  Future<void> createGateway(Map<String, dynamic> body) async {
    final r = await http.post(_u('/api/gateways'), headers: _headers, body: jsonEncode(body));
    if (r.statusCode != 201) throw Exception(jsonDecode(r.body)['error'] ?? 'create failed');
  }

  Future<void> updateGateway(int id, Map<String, dynamic> body) async {
    final r = await http.put(_u('/api/gateways/$id'), headers: _headers, body: jsonEncode(body));
    if (r.statusCode != 200) throw Exception(jsonDecode(r.body)['error'] ?? 'update failed');
  }

  Future<void> deleteGateway(int id) async {
    await http.delete(_u('/api/gateways/$id'), headers: _headers);
  }

  Future<bool> gatewayHasToken() async {
    final r = await http.get(_u('/api/gateways/token'), headers: _headers);
    if (r.statusCode != 200) return false;
    return jsonDecode(r.body)['hasToken'] == true;
  }

  Future<String> genGatewayToken() async {
    final r = await http.post(_u('/api/gateways/token'), headers: _headers);
    if (r.statusCode != 200) throw Exception(jsonDecode(r.body)['error'] ?? 'token failed');
    return jsonDecode(r.body)['token'] as String;
  }

  Future<void> revokeGatewayToken() async {
    await http.delete(_u('/api/gateways/token'), headers: _headers);
  }

  /// Who holds a port: [{pid, name, proto}] (admin).
  Future<List<Map<String, dynamic>>> portInfo(int port) async {
    final r = await http.get(_u('/api/system/port/$port'), headers: _headers);
    if (r.statusCode != 200) throw Exception(jsonDecode(r.body)['error'] ?? 'port info failed');
    return (jsonDecode(r.body) as List).cast<Map<String, dynamic>>();
  }

  /// Kill everything on a port (admin). Returns per-process results.
  Future<List<Map<String, dynamic>>> killPort(int port) async {
    final r = await http.post(_u('/api/system/killport'),
        headers: _headers, body: jsonEncode({'port': port}));
    if (r.statusCode != 200) throw Exception(jsonDecode(r.body)['error'] ?? 'kill failed');
    return (jsonDecode(r.body) as List).cast<Map<String, dynamic>>();
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

  Future<Map<String, dynamic>> updateSite(int id, Map<String, dynamic> body) async {
    final r = await http.put(_u('/api/sites/$id'), headers: _headers, body: jsonEncode(body));
    if (r.statusCode != 200) throw Exception(jsonDecode(r.body)['error'] ?? 'update failed');
    return jsonDecode(r.body);
  }

  Future<void> deleteSite(int id) async {
    await http.delete(_u('/api/sites/$id'), headers: _headers);
  }

  /// PM2 metrics for a process site: {status, cpu, memory, restarts, uptime, pid}.
  Future<Map<String, dynamic>> processMetrics(int id) async {
    try {
      final r = await http.get(_u('/api/sites/$id/metrics'), headers: _headers);
      if (r.statusCode != 200) return {};
      return jsonDecode(r.body) as Map<String, dynamic>;
    } catch (_) {
      return {};
    }
  }

  /// Live PM2 metrics for ALL wm-* apps in one call: list of
  /// {name: 'wm-<site>', status, cpu, memory, restarts, uptime, ...}.
  Future<Map<String, Map<String, dynamic>>> pm2Overview() async {
    try {
      final r = await http.get(_u('/api/sites/pm2/overview'), headers: _headers);
      if (r.statusCode != 200) return {};
      final list = (jsonDecode(r.body) as List).cast<Map<String, dynamic>>();
      // key by site name (strip the wm- service prefix)
      return {
        for (final m in list)
          (m['name']?.toString() ?? '').replaceFirst('wm-', ''): m,
      };
    } catch (_) {
      return {};
    }
  }

  /// Read a Node-RED site's user overrides (settings.user.js).
  Future<String> noderedSettings(int id) async {
    final r = await http.get(_u('/api/sites/$id/nodered-settings'), headers: _headers);
    if (r.statusCode != 200) throw Exception(jsonDecode(r.body)['error'] ?? 'load failed');
    return jsonDecode(r.body)['content']?.toString() ?? '';
  }

  /// Bcrypt-hash an editor password for Node-RED adminAuth.
  Future<String> noderedHash(int id, String password) async {
    final r = await http.post(_u('/api/sites/$id/nodered-hash'),
        headers: _headers, body: jsonEncode({'password': password}));
    if (r.statusCode != 200) throw Exception(jsonDecode(r.body)['error'] ?? 'hash failed');
    return jsonDecode(r.body)['hash'] as String;
  }

  /// Save a Node-RED site's user overrides (validated server-side).
  Future<void> saveNoderedSettings(int id, String content) async {
    final r = await http.put(_u('/api/sites/$id/nodered-settings'),
        headers: _headers, body: jsonEncode({'content': content}));
    if (r.statusCode != 200) throw Exception(jsonDecode(r.body)['error'] ?? 'save failed');
  }

  /// Fire a button action that streams its logs over WebSocket.
  Future<void> action(int id, String path, [Map<String, dynamic>? body]) async {
    await http.post(_u('/api/sites/$id/$path'),
        headers: _headers, body: body == null ? null : jsonEncode(body));
  }

  /// Persisted log history for a channel (`site-<id>` or `system`).
  Future<List<String>> logHistory(String channel, {int limit = 500}) async {
    try {
      final r = await http.get(
        _u('/api/logs/history?channel=${Uri.encodeQueryComponent(channel)}&limit=$limit'),
        headers: _headers,
      );
      if (r.statusCode != 200) return [];
      return (jsonDecode(r.body) as List).map((e) => e['line'].toString()).toList();
    } catch (_) {
      return [];
    }
  }

  Future<void> clearLogHistory(String channel) async {
    await http.delete(_u('/api/logs/history?channel=${Uri.encodeQueryComponent(channel)}'),
        headers: _headers);
  }

  Future<Map<String, dynamic>> logSettings() async {
    final r = await http.get(_u('/api/logs/settings'), headers: _headers);
    if (r.statusCode != 200) throw Exception('log settings failed');
    return jsonDecode(r.body) as Map<String, dynamic>;
  }

  Future<void> saveLogSettings({int? retentionMonths, bool? autoPrune}) async {
    await http.put(_u('/api/logs/settings'),
        headers: _headers,
        body: jsonEncode({
          if (retentionMonths != null) 'retentionMonths': retentionMonths,
          if (autoPrune != null) 'autoPrune': autoPrune,
        }));
  }

  /// Full log history for a channel, as raw text (for download).
  Future<String> downloadLogText(String channel) async {
    final r = await http.get(
      _u('/api/logs/download?channel=${Uri.encodeQueryComponent(channel)}'),
      headers: _headers,
    );
    if (r.statusCode != 200) throw Exception('download failed: ${r.statusCode}');
    return r.body;
  }

  /// Auto-deploy history: [{site_name, from_commit, to_commit, ok, message, ts}].
  Future<List<Map<String, dynamic>>> autodeployLog({int limit = 1000}) async {
    final r = await http.get(_u('/api/logs/autodeploy?limit=$limit'), headers: _headers);
    if (r.statusCode != 200) throw Exception('autodeploy log failed: ${r.statusCode}');
    return (jsonDecode(r.body) as List).cast<Map<String, dynamic>>();
  }

  /// Audit trail (admin): who did what, when.
  Future<List<Map<String, dynamic>>> audit({int limit = 300}) async {
    final r = await http.get(_u('/api/audit?limit=$limit'), headers: _headers);
    if (r.statusCode != 200) throw Exception('audit failed: ${r.statusCode}');
    return (jsonDecode(r.body) as List).cast<Map<String, dynamic>>();
  }

  /// Delete logs older than [months] now; returns how many rows were removed.
  Future<int> pruneLogs({int? months}) async {
    final r = await http.post(_u('/api/logs/prune'),
        headers: _headers, body: jsonEncode({if (months != null) 'months': months}));
    if (r.statusCode != 200) throw Exception('prune failed');
    return (jsonDecode(r.body)['deleted'] as num).toInt();
  }

  /// Open the live-log socket for a channel (e.g. site-3). On a remote server
  /// this goes through the hub's ws proxy.
  WebSocketChannel logSocket(String channel) {
    final b = _base.replaceFirst('http', 'ws');
    final path = remoteId != null ? '/fleet/$remoteId/ws' : '/ws';
    return WebSocketChannel.connect(Uri.parse('$b$path?channel=$channel&token=$_token'));
  }

  /// Open an interactive shell (admin only) at /pty. Pass [site] to start in that
  /// site's folder (server resolves the path), or [cwd] for an explicit path.
  WebSocketChannel ptySocket({int cols = 80, int rows = 24, String? cwd, String? site}) {
    final b = _base.replaceFirst('http', 'ws');
    final path = remoteId != null ? '/fleet/$remoteId/pty' : '/pty';
    final q = site != null
        ? '&site=${Uri.encodeQueryComponent(site)}'
        : cwd != null
            ? '&cwd=${Uri.encodeQueryComponent(cwd)}'
            : '';
    return WebSocketChannel.connect(Uri.parse('$b$path?token=$_token&cols=$cols&rows=$rows$q'));
  }

  void debugPrintBase() {
    if (kDebugMode) debugPrint('API base: $_base');
  }
}
