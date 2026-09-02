# HTTPS Setup Guide

> **The proxy configs live in [`deploy/`](../deploy/README.md) and are kept in
> sync with the code:** [`deploy/Caddyfile`](../deploy/Caddyfile) and
> [`deploy/nginx.conf`](../deploy/nginx.conf). Copy one of those; do not
> retype a block from a page like this one. An earlier version of this page
> carried its own nginx sample, which had drifted from the shipped config —
> it omitted `client_max_body_size`, so nginx's 1 MB default silently
> rejected every attachment over 1 MB with a proxy-generated 413 that never
> reached the backend's logs.

For production, use a reverse proxy for TLS termination. The backend process
never speaks TLS by design — never expose `:3000` directly.

## What the shipped configs get right, and a hand-written one must too

- **Proxy the whole origin.** The API lives at the root (`/auth/…`,
  `/servers`, `/ws`, `/files/:id`); the only `/api` route is the mobile OTA
  check. A vhost that forwards only `/api/` returns 404 for everything else.
- **WebSocket upgrade** on `/ws`, with a long read timeout (the shipped
  configs use 86400 s). Caddy does this natively; nginx needs the `Upgrade` /
  `Connection` headers and `proxy_http_version 1.1`.
- **`client_max_body_size 32m`** (nginx) / `request_body { max_size 32MB }`
  (Caddy): uploads are capped at 25 MB by the app, 28 MB with framing.
- **`X-Forwarded-For` overwritten with the real peer** — never appended with
  `$proxy_add_x_forwarded_for`: the backend's rate limiter keys on the
  leftmost entry, and a client that can supply its own gets a fresh limiter
  bucket per request.
- **`CF-Connecting-IP` cleared** unless Cloudflare really is in front (then use
  [`deploy/cloudflare/`](../deploy/cloudflare/README.md), which validates
  Cloudflare's ranges).
- **HSTS, `nosniff`, `X-Frame-Options`** on the API vhost. The web app's origin
  additionally carries a Content-Security-Policy, applied with
  `deploy/ops/add-webapp-csp.py` (see `deploy/webapp/README.md`).

## Certificates

Caddy obtains and renews Let's Encrypt certificates itself (ports 80 and 443
must reach it). With nginx: `sudo certbot certonly --nginx -d chat.example.com`
and the `ssl_certificate` lines in `deploy/nginx.conf`; certbot installs a
renewal timer (`systemctl status certbot.timer`).

## Update the frontend

Do **not** edit `frontend/src/api/config.ts` — the API base URL is a
build-time env var (read by `frontend/src/api/platform.ts`), and the
WebSocket URL is derived from it automatically. The whole origin is proxied,
so there is **no `/api` suffix**:

```bash
cd frontend
echo 'VITE_API_URL=https://chat.example.com' > .env.production
npm run build
```
