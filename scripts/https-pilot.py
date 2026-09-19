#!/usr/bin/env python3
"""HTTPS pilot runbook for one static site on a WEBMANAGER host (HTTPS-PLAN.md).

Run from the dev machine, one subcommand per runbook step, in this order:

  health          panel version vs local origin/main, ftp/gateway up
  status          site row + proxy routes + https fields
  baseline        hit every backend path directly, save status codes
  ftp-open        temp FTP user rooted at nginx\\conf.d (owner-approved, read use only)   [mutating]
  backup <label>  download conf.d/ports + conf.d/front over that FTP user
  routes          create the /api and /auth proxy routes (skips ones that exist)           [mutating]
  verify-routes   same paths through the site port must match baseline; SSE stream check
  build-defines   switch the unit's buildup.sh line to relative dart-defines (--revert)
  verify-build    served main.dart.js must contain 0 absolute backend URLs
  https           enable the second https listener                                        [mutating]
  verify-https    https 200, http still 200, cert SAN carries the server IP
  diff <a> <b>    compare two backups; any change outside this site's conf is flagged
  ftp-close       delete the temp FTP user                                                  [mutating]
  sites-smoke save|check   before/after update.cmd on ANY host (WM_URL): every site port answers as before

Mutating steps accept --dry-run (print the request, send nothing). Config via env:
  WM_URL (default http://172.23.10.34:8088)  WM_USER (admin)  WM_PASS (prompted if unset)
  SITE_ID (18)  SITE_PORT (2521)  HTTPS_PORT (2443)  SERVER_IP (172.23.10.34)
  WM_ROOT_WIN (C:\\webmanager)  — install root on the Windows host, for the FTP root_path
"""
import getpass
import io
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from ftplib import FTP
from pathlib import Path

WM_URL = os.environ.get('WM_URL', 'http://172.23.10.34:8088').rstrip('/')
WM_USER = os.environ.get('WM_USER', 'admin')
SITE_ID = int(os.environ.get('SITE_ID', '18'))
SITE_PORT = int(os.environ.get('SITE_PORT', '2521'))
HTTPS_PORT = int(os.environ.get('HTTPS_PORT', '2443'))
SERVER_IP = os.environ.get('SERVER_IP', '172.23.10.34')
WM_ROOT_WIN = os.environ.get('WM_ROOT_WIN', r'C:\webmanager')
SITE_NAME = 'UI-SOI8GWPLC-DEPLOY'
UNIT = 'UI-SOI8GWPLC'
FTP_TEMP_USER = 'tmp-https-pilot'

STATE_DIR = Path.home() / '.webmanager-pilot'
BASELINE_FILE = STATE_DIR / 'baseline.json'
FTP_FILE = STATE_DIR / 'ftp.json'
BACKUP_DIR = STATE_DIR / 'backups'

ROUTES = [
    {'path_prefix': '/api', 'target_url': 'http://127.0.0.1:2520', 'strip_prefix': True, 'sse': True, 'enabled': True},
    {'path_prefix': '/auth', 'target_url': f'http://{SERVER_IP}:15000', 'strip_prefix': True, 'sse': False, 'enabled': True},
]

# (route prefix, backend origin, method, path) — the paths UI-SOI8GWPLC really calls
BACKEND_PATHS = [
    ('/api', f'http://{SERVER_IP}:2520', 'GET', '/gw/plcs'),
    ('/api', f'http://{SERVER_IP}:2520', 'GET', '/gw/tags'),
    ('/api', f'http://{SERVER_IP}:2520', 'GET', '/qc_peers'),
    ('/api', f'http://{SERVER_IP}:2520', 'GET', '/plc_source'),
    ('/api', f'http://{SERVER_IP}:2520', 'GET', '/register_map'),
    ('/api', f'http://{SERVER_IP}:2520', 'GET', '/gw_log'),
    ('/auth', f'http://{SERVER_IP}:15000', 'GET', '/gwplcstate'),
    ('/auth', f'http://{SERVER_IP}:15000', 'GET', '/gwplcregistermap'),
    ('/auth', f'http://{SERVER_IP}:15000', 'POST', '/login'),
    ('/auth', f'http://{SERVER_IP}:15000', 'POST', '/getitemregistry'),
    ('/auth', f'http://{SERVER_IP}:15000', 'POST', '/gwplcregistermap'),
]
SSE_PATH = '/gw/stream'

OLD_DEFINES = f'--dart-define=GWPLC_BACKEND=http://{SERVER_IP}:2520 --dart-define=GWPLC_AUTH=http://{SERVER_IP}:15000/'
NEW_DEFINES = '--dart-define=GWPLC_BACKEND=/api --dart-define=GWPLC_AUTH=/auth/'
BUILDUP_SH = Path(__file__).resolve().parents[2] / 'SOI8MASTER' / 'buildup.sh'

DRY = '--dry-run' in sys.argv
ARGS = [a for a in sys.argv[1:] if not a.startswith('--')]


def die(msg):
    print(f'FAIL: {msg}')
    sys.exit(1)


def http(method, url, body=None, headers=None, timeout=10):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={'Content-Type': 'application/json', **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, r.headers.get('Content-Type', ''), raw
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get('Content-Type', ''), e.read()
    except (urllib.error.URLError, socket.timeout, ConnectionError) as e:
        return 0, '', str(e).encode()


_token = None


def token():
    global _token
    if _token:
        return _token
    pw = os.environ.get('WM_PASS') or getpass.getpass(f'panel password for {WM_USER}@{WM_URL}: ')
    st, _, raw = http('POST', f'{WM_URL}/api/auth/login', {'username': WM_USER, 'password': pw})
    if st != 200:
        die(f'panel login {st}: {raw[:200]!r}')
    _token = json.loads(raw).get('token')
    if not _token:
        die('login ok but no token in response')
    return _token


def api(method, path, body=None):
    st, ct, raw = http(method, f'{WM_URL}{path}', body, {'Authorization': f'Bearer {token()}'})
    try:
        parsed = json.loads(raw) if raw else None
    except ValueError:
        parsed = raw[:300].decode(errors='replace')
    return st, parsed


def mutate(method, path, body=None):
    if DRY:
        print(f'  [dry-run] {method} {path} {json.dumps(body, ensure_ascii=False) if body else ""}')
        return 0, None
    st, parsed = api(method, path, body)
    print(f'  {method} {path} -> {st} {json.dumps(parsed, ensure_ascii=False)[:200] if parsed is not None else ""}')
    return st, parsed


def local_head():
    try:
        subprocess.run(['git', 'fetch', '-q', 'origin'], cwd=Path(__file__).resolve().parents[1], check=False, timeout=30)
        return subprocess.check_output(['git', 'rev-parse', '--short', 'origin/main'], cwd=Path(__file__).resolve().parents[1]).decode().strip()
    except (subprocess.SubprocessError, OSError):
        return '?'


# ── steps ──────────────────────────────────────────────────────────────────

def cmd_health():
    st, _, raw = http('GET', f'{WM_URL}/api/health')
    if st != 200:
        die(f'/api/health -> {st}')
    version = json.loads(raw).get('version', '')
    want = local_head()
    ok = version.startswith(want)
    print(f'panel version : {version}   origin/main: {want}   {"OK" if ok else "MISMATCH — update.cmd not done yet?"}')
    st, ftp = api('GET', '/api/ftp/status')
    print(f'ftp           : {json.dumps(ftp)}')
    st, gws = api('GET', '/api/gateways')
    if st == 200 and isinstance(gws, list):
        down = [g.get('name') for g in gws if g.get('enabled') and not g.get('running', True)]
        print(f'gateways      : {len(gws)} rows, enabled-but-down: {down or "none"}')
    else:
        print(f'gateways      : {st} {gws}')
    if not ok:
        sys.exit(2)


def cmd_status():
    st, site = api('GET', f'/api/sites/{SITE_ID}')
    if st != 200:
        die(f'site {SITE_ID}: {st} {site}')
    keys = ['id', 'name', 'runtime', 'direct_port', 'direct_port_enabled', 'https_port', 'https_enabled', 'enabled']
    print('site   :', {k: site.get(k) for k in keys})
    if site.get('name') != SITE_NAME or site.get('direct_port') != SITE_PORT:
        die(f'site {SITE_ID} is not {SITE_NAME}:{SITE_PORT} — refusing to continue')
    st, routes = api('GET', f'/api/sites/{SITE_ID}/routes')
    print('routes :', st, json.dumps(routes, ensure_ascii=False))


def probe(method, url):
    # headers only — an SSE endpoint never ends its body, so a full read would hang
    import http.client
    from urllib.parse import urlsplit
    u = urlsplit(url)
    conn = (http.client.HTTPSConnection if u.scheme == 'https' else http.client.HTTPConnection)(u.hostname, u.port, timeout=8)
    try:
        conn.request(method, u.path or '/', body=b'{}' if method == 'POST' else None, headers={'Content-Type': 'application/json'})
        r = conn.getresponse()
        return {'status': r.status, 'type': (r.getheader('Content-Type') or '').split(';')[0]}
    except (OSError, http.client.HTTPException):
        return {'status': 0, 'type': ''}
    finally:
        conn.close()


def cmd_baseline():
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    out = {}
    for prefix, origin, method, path in BACKEND_PATHS:
        r = probe(method, origin + path)
        out[f'{method} {prefix}{path}'] = r
        print(f'  {method:4} {origin}{path:22} {r["status"]} {r["type"]}')
    sse = probe('GET', f'http://{SERVER_IP}:2520{SSE_PATH}')
    out[f'GET /api{SSE_PATH}'] = sse
    print(f'  GET  {SERVER_IP}:2520{SSE_PATH:22} {sse["status"]} {sse["type"]}')
    if sse['type'] != 'text/event-stream':
        die('backend stream is not text/event-stream — SSE assumption broken')
    BASELINE_FILE.write_text(json.dumps(out, indent=1))
    print(f'saved {BASELINE_FILE}')


def cmd_ftp_open():
    if FTP_FILE.exists() and not DRY:
        print(f'temp FTP already recorded in {FTP_FILE} — run ftp-close first')
        return
    password = secrets.token_urlsafe(18)
    body = {'username': FTP_TEMP_USER, 'password': password, 'root_path': WM_ROOT_WIN + r'\nginx\conf.d', 'enabled': True}
    shown = {**body, 'password': '<random>'}
    print(f'  creating {json.dumps(shown)}')
    if DRY:
        return
    st, row = api('POST', '/api/ftp/users', body)
    if st not in (200, 201):
        die(f'create ftp user: {st} {row}')
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    FTP_FILE.write_text(json.dumps({'id': row.get('id'), 'username': FTP_TEMP_USER, 'password': password}))
    os.chmod(FTP_FILE, 0o600)
    print(f'  ok id={row.get("id")} (password kept only in {FTP_FILE})')


def ftp_conn():
    if not FTP_FILE.exists():
        die('no temp FTP user — run ftp-open first')
    cred = json.loads(FTP_FILE.read_text())
    st, status = api('GET', '/api/ftp/status')
    port = (status or {}).get('port', 21)
    f = FTP()
    f.connect(SERVER_IP, port, timeout=15)
    f.login(cred['username'], cred['password'])
    f.set_pasv(True)
    return f


def ftp_walk(f, sub):
    files = []
    try:
        for name, facts in f.mlsd(sub):
            if facts.get('type') == 'file':
                files.append(f'{sub}/{name}')
    except Exception:
        for name in f.nlst(sub):
            if name.endswith('.conf'):
                files.append(name if name.startswith(sub) else f'{sub}/{name}')
    return sorted(files)


def cmd_backup():
    label = ARGS[1] if len(ARGS) > 1 else None
    if not label:
        die('usage: backup <label>   (e.g. before, after-routes, after-https)')
    dest = BACKUP_DIR / label
    dest.mkdir(parents=True, exist_ok=True)
    f = ftp_conn()
    n = 0
    for sub in ('ports', 'front'):
        for remote in ftp_walk(f, sub):
            buf = io.BytesIO()
            f.retrbinary(f'RETR {remote}', buf.write)
            target = dest / remote
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(buf.getvalue())
            n += 1
    f.quit()
    print(f'saved {n} files -> {dest}')


def cmd_routes():
    st, existing = api('GET', f'/api/sites/{SITE_ID}/routes')
    have = {r['path_prefix'] for r in (existing or [])} if st == 200 else set()
    for r in ROUTES:
        if r['path_prefix'] in have:
            print(f'  {r["path_prefix"]} already exists — skip')
            continue
        st, res = mutate('POST', f'/api/sites/{SITE_ID}/routes', r)
        if not DRY and st != 201:
            die(f'route {r["path_prefix"]} failed ({st}): {res} — nginx -t rejected it, nothing was reloaded')


def cmd_verify_routes():
    if not BASELINE_FILE.exists():
        die('no baseline — run baseline first')
    base = json.loads(BASELINE_FILE.read_text())
    bad = 0
    for prefix, _, method, path in BACKEND_PATHS:
        key = f'{method} {prefix}{path}'
        r = probe(method, f'http://{SERVER_IP}:{SITE_PORT}{prefix}{path}')
        same = r == base[key]
        bad += not same
        print(f'  {"OK " if same else "DIFF"} {key:32} via site {r["status"]} {r["type"]:24} baseline {base[key]["status"]} {base[key]["type"]}')
    sse = probe('GET', f'http://{SERVER_IP}:{SITE_PORT}/api{SSE_PATH}')
    ok = sse['status'] == 200 and sse['type'] == 'text/event-stream'
    bad += not ok
    print(f'  {"OK " if ok else "DIFF"} SSE /api{SSE_PATH:26} {sse["status"]} {sse["type"]}')
    st, _, raw = http('GET', f'http://{SERVER_IP}:{SITE_PORT}/')
    ok = st == 200 and b'<html' in raw[:400].lower()
    bad += not ok
    print(f'  {"OK " if ok else "DIFF"} static / still serves index.html ({st})')
    if bad:
        die(f'{bad} mismatch(es) — do NOT deploy the relative build yet')
    print('all paths match baseline')


def cmd_build_defines():
    if not BUILDUP_SH.exists():
        die(f'{BUILDUP_SH} not found')
    text = BUILDUP_SH.read_text()
    revert = '--revert' in sys.argv
    src, dst = (NEW_DEFINES, OLD_DEFINES) if revert else (OLD_DEFINES, NEW_DEFINES)
    line = next((l for l in text.splitlines() if l.startswith(f'{UNIT}|')), None)
    if line is None:
        die(f'no {UNIT} line in buildup.sh')
    if dst in line:
        print(f'  buildup.sh already has: {dst}')
        return
    if src not in line:
        die(f'unexpected defines on the {UNIT} line, edit by hand:\n  {line}')
    print(f'  {UNIT}: {src}\n    -> {dst}')
    if DRY:
        return
    BUILDUP_SH.write_text(text.replace(line, line.replace(src, dst)))
    print(f'  written {BUILDUP_SH} — now run: cd {BUILDUP_SH.parent} && ./buildup.sh {UNIT}')


def cmd_verify_build():
    st, _, raw = http('GET', f'http://{SERVER_IP}:{SITE_PORT}/main.dart.js', timeout=30)
    if st != 200:
        die(f'main.dart.js -> {st}')
    js = raw.decode(errors='replace')
    counts = {p: len(re.findall(re.escape(p), js)) for p in (SERVER_IP, ':2520', ':15000')}
    rel = {p: p in js for p in ('/api/gw/stream', '/auth/')}
    print(f'  absolute leftovers: {counts}   relative present: {rel}   size {len(raw)//1024} KB')
    if any(counts.values()) or not all(rel.values()):
        die('served build still points at absolute backends — buildup with the relative defines first')
    print('served build is relative-path only')


def cmd_https():
    st, site = api('GET', f'/api/sites/{SITE_ID}')
    if site.get('https_enabled') and site.get('https_port') == HTTPS_PORT:
        print(f'  https already enabled on {HTTPS_PORT}')
        return
    st, res = mutate('POST', f'/api/sites/{SITE_ID}/https/enable', {'https_port': HTTPS_PORT})
    if not DRY and st != 200:
        die(f'https/enable {st}: {res} — nginx -t rejected, previous conf restored, http port untouched')


def cmd_verify_https():
    import ssl
    st, _, ca_pem = http('GET', f'{WM_URL}/panel-ca.crt')
    print(f'  CA download {WM_URL}/panel-ca.crt -> {st} ({len(ca_pem)} bytes)')
    if st != 200:
        die('CA not downloadable — https/enable did not create it?')
    # trust only the panel CA: same check a client PC does after installing it,
    # including the IP-SAN match (no verification bypass)
    ctx = ssl.create_default_context(cadata=ca_pem.decode())
    try:
        with urllib.request.urlopen(f'https://{SERVER_IP}:{HTTPS_PORT}/', context=ctx, timeout=10) as r:
            print(f'  https :{HTTPS_PORT} -> {r.status} (chain + IP SAN verified against panel CA)')
            if r.status != 200:
                die('https listener not serving 200')
    except ssl.SSLError as e:
        die(f'TLS verification failed: {e} — cert not signed by the panel CA or SAN lacks {SERVER_IP}')
    except Exception as e:
        die(f'https :{HTTPS_PORT} unreachable: {e} (firewall rule wm-port-{HTTPS_PORT}? nginx -t?)')
    st, _, _ = http('GET', f'http://{SERVER_IP}:{SITE_PORT}/')
    print(f'  http  :{SITE_PORT} -> {st}')
    if st != 200:
        die('old http port stopped serving — this must never happen in the pilot')
    try:
        pem = subprocess.run(['openssl', 's_client', '-connect', f'{SERVER_IP}:{HTTPS_PORT}', '-servername', SERVER_IP],
                             input=b'', capture_output=True, timeout=15).stdout
        san = subprocess.run(['openssl', 'x509', '-noout', '-ext', 'subjectAltName'], input=pem, capture_output=True, timeout=10).stdout.decode()
        print(f'  SAN: {san.strip().splitlines()[-1].strip() if san.strip() else "(none)"}')
        if f'IP Address:{SERVER_IP}' not in san:
            die(f'cert SAN lacks IP {SERVER_IP} — browsers will refuse it even with the CA installed')
    except (subprocess.SubprocessError, OSError) as e:
        print(f'  (openssl check skipped: {e})')
    print(f'https pilot up: https://{SERVER_IP}:{HTTPS_PORT}  and  http://{SERVER_IP}:{SITE_PORT}')


def cmd_diff():
    if len(ARGS) < 3:
        die('usage: diff <label-a> <label-b>')
    a, b = BACKUP_DIR / ARGS[1], BACKUP_DIR / ARGS[2]
    for d in (a, b):
        if not d.exists():
            die(f'no backup {d}')
    files = sorted({p.relative_to(a) for p in a.rglob('*.conf')} | {p.relative_to(b) for p in b.rglob('*.conf')})
    own = f'ports/{SITE_NAME}.conf'
    unexpected = []
    for rel in files:
        fa, fb = a / rel, b / rel
        state = 'same' if fa.exists() and fb.exists() and fa.read_bytes() == fb.read_bytes() else ('added' if not fa.exists() else 'removed' if not fb.exists() else 'CHANGED')
        if state != 'same':
            print(f'  {state:8} {rel}')
            if str(rel) != own:
                unexpected.append(str(rel))
    if unexpected:
        die(f'files outside {own} changed: {unexpected} — stop, investigate before any further reload')
    print(f'only {own} differs (or nothing) — as expected')


def cmd_sites_smoke():
    # `sites-smoke save` before update.cmd on any host, `sites-smoke check` after:
    # every enabled site port must answer exactly as before the restart
    mode = ARGS[1] if len(ARGS) > 1 else ''
    if mode not in ('save', 'check'):
        die('usage: sites-smoke save|check   (set WM_URL to the host)')
    host = urllib.parse.urlsplit(WM_URL).hostname
    f = STATE_DIR / f'sites-{host}.json'
    st, sites = api('GET', '/api/sites')
    if st != 200:
        die(f'/api/sites -> {st}')
    now = {}
    for s in sites:
        if not s.get('direct_port') or not s.get('direct_port_enabled'):
            continue
        r = probe('GET', f'http://{host}:{s["direct_port"]}/')
        now[s['name']] = {'port': s['direct_port'], **r}
        print(f'  {s["name"]:32} :{s["direct_port"]:<6} {r["status"]} {r["type"]}')
    st, health = api('GET', '/api/health')
    print(f'  panel version: {(health or {}).get("version")}   sites total: {len(sites)}   with direct port: {len(now)}')
    if mode == 'save':
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps({'sites': now, 'total': len(sites)}, indent=1))
        print(f'saved {f}')
        return
    if not f.exists():
        die(f'no saved smoke for {host} — run sites-smoke save before the update')
    before = json.loads(f.read_text())
    bad = [n for n, v in before['sites'].items() if now.get(n) != v] + [n for n in now if n not in before['sites']]
    if before['total'] != len(sites):
        bad.append(f'site count {before["total"]} -> {len(sites)}')
    if bad:
        die(f'changed after update: {bad}')
    print(f'{host}: all {len(now)} site ports answer exactly as before the update')


def cmd_ftp_close():
    if not FTP_FILE.exists():
        print('no temp FTP user recorded')
        return
    cred = json.loads(FTP_FILE.read_text())
    st, _ = mutate('DELETE', f'/api/ftp/users/{cred["id"]}')
    if DRY:
        return
    if st not in (200, 204):
        die(f'delete ftp user {st}')
    FTP_FILE.unlink()
    print('  temp FTP user removed')


COMMANDS = {
    'health': cmd_health, 'status': cmd_status, 'baseline': cmd_baseline,
    'ftp-open': cmd_ftp_open, 'backup': cmd_backup, 'routes': cmd_routes, 'verify-routes': cmd_verify_routes,
    'build-defines': cmd_build_defines, 'verify-build': cmd_verify_build,
    'https': cmd_https, 'verify-https': cmd_verify_https, 'diff': cmd_diff, 'ftp-close': cmd_ftp_close,
    'sites-smoke': cmd_sites_smoke,
}

if __name__ == '__main__':
    if not ARGS or ARGS[0] not in COMMANDS:
        print(__doc__)
        sys.exit(1)
    print(f'== {ARGS[0]}{" (dry-run)" if DRY else ""}  target {WM_URL}  site {SITE_ID} {SITE_NAME}:{SITE_PORT} -> https :{HTTPS_PORT}')
    COMMANDS[ARGS[0]]()
