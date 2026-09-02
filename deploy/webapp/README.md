# Browser web app (app.example.com)

The same React SPA that runs inside the desktop (Tauri) and mobile (Capacitor)
shells, served directly to a browser. No separate build — it's the production
`frontend/dist` (built with `VITE_API_URL=https://chat.example.com`).
`platform.ts` detects `web` and native-only features degrade gracefully.

## What degrades in a browser
- **Remote-control host** — desktop-only (`inject_input` is native `SendInput`);
  `remoteControl.ts` returns early when `!isTauri()`.
- **App-audio capture** + the Windows "is-sharing" bar — desktop-only no-ops.
- ~~DeepFilter~~ — since the worklet+worker rebuild DeepFilter **does** run in
  the browser (gated behind Settings → Advanced → Experimental); it only falls
  back to RNNoise if the wasm can't start or the CPU can't keep up.
- **Media E2EE** — full frame encryption in Chromium (Insertable Streams);
  Firefox/Safari fall back to transport-only, and the indicator shows it.
Everything else works: SRP login, E2EE messaging/DMs/channels, voice, screen
share (`getDisplayMedia`), attachments, reactions, tasks.

## Deploy (on the server)
1. On your machine: `cd frontend && npm run build`, then
   `tar -czf dist.tar.gz -C dist .` (index.html at the archive root).
2. Push and extract to `/opt/puca/webapp` — `deploy/ops/dual-ship.sh webapp
   dist.tar.gz` does this on every host and verifies the served bundle hash;
   by hand: `tar -xzf dist.tar.gz --no-same-owner -C /opt/puca/webapp`.
   (`provision.sh` creates the directory; otherwise `mkdir -p` it and make it
   readable by Caddy's user — `0755`.)
3. Add this site block to `/etc/caddy/Caddyfile`
   (`deploy/Caddyfile.example.com` already contains it):
   ```
   app.example.com {
       root * /opt/puca/webapp
       encode gzip
       try_files {path} /index.html   # SPA client-side routing
       file_server
       header {
           Strict-Transport-Security "max-age=31536000; includeSubDomains"
           X-Content-Type-Options "nosniff"
           X-Frame-Options "SAMEORIGIN"
       }
   }
   ```
   then **add the Content-Security-Policy with the tool, not by hand**:
   ```
   python3 deploy/ops/add-webapp-csp.py /etc/caddy/Caddyfile /opt/puca/.env app.example.com chat.example.com --dry-run
   ```
   and again without `--dry-run`. `connect-src` must name the API host and,
   if the deployment has one, the SFU (`LIVEKIT_URL`) — a policy without the
   SFU silently breaks voice for every browser user, which is why the tool
   reads it from the backend's `.env` rather than taking it as an argument
   (`--no-sfu` for a mesh-only deployment). `deploy/ops/check-versions.sh`
   fails on `webapp-csp` until the header is live. Then
   `caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy`.
4. Add `https://app.example.com` to `CORS_ORIGINS` in `/opt/puca/.env`,
   `systemctl restart puca`.

## DNS
Add an **A record `app` → your public IP** at whatever hosts your DNS (the
same address as `chat` and `download`), and make sure ports 80 and 443 reach
this host — the same forward or firewall rule the API already uses; nothing
new is needed for a second hostname. Caddy obtains the Let's Encrypt
certificate on the first HTTPS request once the name resolves. Behind
Cloudflare, `app` is proxied (orange) like `chat` — [`../cloudflare/README.md`](../cloudflare/README.md).

## To update the web app
Re-run steps 1–2 (rebuild + re-extract; `dual-ship.sh webapp`). No
Caddy/CORS/DNS change needed unless a new release adds a `connect-src`
requirement — run `check-versions.sh` after every push. This is decoupled from
the desktop/mobile version line: it always serves whatever `dist` was last
deployed here.

## Follow-ups (not done)
- PWA manifest + service worker for installability/offline.
