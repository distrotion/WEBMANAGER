# WEBMANAGER backend (Phase 1 MVP)

Express + SQLite control-panel API for git-based deploy of Flutter-web (`*_deploy`) sites
behind a 2-layer nginx setup on Windows Server 2019. See `../PLAN.md` for full spec.

## Run (dev, this repo)

```bash
cd backend
npm install
# local dev: store under ~/webmanager-dev, port 8088
WM_LOG_CONSOLE=1 npm start
```

On Windows Server it auto-uses `D:\webmanager` as root. Configure via env / `.env`
(see `.env.example`) and run as an NSSM service (Phase 4 install scripts).

Default admin is seeded on first boot: `admin` / `admin1234` — **change `ADMIN_PASS`
+ `JWT_SECRET` before production.**

## Layout

```
src/
  server.js        express + ws bootstrap, route wiring
  config.js        paths/env (ROOT, nginx exe, ports)
  db.js            better-sqlite3 schema (users, sites, releases, audit)
  auth.js          bcrypt + JWT, seedAdmin, authMiddleware, requireRole
  logbus.js        WebSocket /ws — streams command output per channel
  runner.js        spawn + line-stream stdout/stderr to a log channel
  git.js           clone/pull *_deploy repos
  nginx.js         generate layer1 (ports) + layer2 (front) configs, test, reload
  deploy.js        pull -> copy release -> swap current -> nginx -t -> reload
  routes/          auth, sites (CRUD + port toggle), deploy
```

## API (all under `/api`, JWT bearer except login/health)

| Method | Path | Note |
|--------|------|------|
| GET  | `/health` | no auth |
| POST | `/auth/login` | `{username,password}` → `{token,user}` |
| GET  | `/sites` | list |
| POST | `/sites` | create (name, runtime, repo_url, direct_port, exposure_mode, ...) |
| GET  | `/sites/:id` | one |
| PUT  | `/sites/:id` | update fields |
| DELETE | `/sites/:id` | remove + clean nginx configs |
| POST | `/sites/:id/port` | `{enabled}` toggle layer-1 port |
| POST | `/sites/:id/deploy` | git pull + publish + reload (static); logs on ws `site-<id>` |
| POST | `/sites/:id/reload` | nginx -t + reload; logs on ws `system` |

### Live logs (WebSocket)

```
ws://<host>:8088/ws?channel=site-3&token=<jwt>
```
Every button action streams its command output to the matching channel (use `*` for all).

## Status

- [x] auth, sites CRUD, port toggle
- [x] git-based static deploy (clone/pull → release → atomic swap → nginx -t → reload)
- [x] 2-layer config generation (layer1 ports; layer2 subdomain + aggregated path)
- [x] live log streaming over WebSocket
- [ ] Phase 2: Node-RED runtime (NSSM start/stop/restart)
- [ ] Phase 3: SSL via win-acme
- [ ] Phase 4: rollback UI, install scripts
- [ ] Flutter UI
```
