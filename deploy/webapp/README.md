# Browser web app (app.example.com)

The same React SPA that runs inside the desktop (Tauri) and mobile (Capacitor)
shells, served directly to a browser. No separate build — it's the production
`frontend/dist` (VITE_API_URL=https://chat.example.com). `platform.ts` detects
`web` and native-only features degrade gracefully.

## What degrades in a browser
- **Remote-control host** — desktop-only (`inject_input` is native `SendInput`);
  `remoteControl.ts` returns early when `!isTauri()`.
- **App-audio capture** + the Windows "is-sharing" bar — desktop-only no-ops.
- ~~DeepFilter~~ — since the worklet+worker rebuild DeepFilter **does** run in
  the browser (gated behind Settings → Advanced → Experimental); it only falls
  back to RNNoise if the wasm can't start or the CPU can't keep up.
- **Media E2EE** — 🔒 in Chromium (Insertable Streams); Firefox/Safari fall back
  to transport-only, and the indicator shows it.
Everything else works: SRP login, E2EE messaging/DMs/channels, voice, screen
share (`getDisplayMedia`), attachments, reactions, tasks.

## Deploy (on the server)
1. `cd frontend && npm run build`
2. Zip `dist` contents (index.html at root), push, extract to
   `/opt/puca/webapp`.
3. Caddy site block (already in `/etc/caddy/Caddyfile`):
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
           Content-Security-Policy "default-src 'self'; connect-src 'self' https://chat.example.com wss://chat.example.com wss://sfu.example.com; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; font-src 'self' data:; worker-src 'self' blob:; child-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
       }
   }
   ```
   Do not hand-write the `Content-Security-Policy` line: run
   `deploy/ops/add-webapp-csp.py /etc/caddy/Caddyfile /opt/puca/.env app.example.com chat.example.com --dry-run`
   and then without `--dry-run`. `connect-src` must name the API host and,
   if the deployment has one, the SFU (`LIVEKIT_URL`) — a policy without the
   SFU silently breaks voice for every browser user, which is why the tool
   reads it from the backend's `.env` rather than taking it as an argument
   (`--no-sfu` for a mesh-only deployment). `deploy/ops/check-versions.sh`
   fails on `webapp-csp` until the header is live.
   `systemctl reload caddy`.
4. Add `https://app.example.com` to `CORS_ORIGINS` in `/opt/puca/.env`,
   `systemctl restart puca`.

## DNS (manual — Porkbun)
Add an **A record `app` → YOUR_PUBLIC_IP** (same as `chat`/`download`; keep the
"don't delete existing records" box checked). Ports 80/443 already forward to
this container, so no new router rule. Caddy auto-provisions the Let's Encrypt
cert on the first HTTPS request once DNS resolves.

## To update the web app
Re-run steps 1–2 (rebuild + re-extract). No Caddy/CORS/DNS change needed. This
is decoupled from the desktop/mobile version line — it always serves whatever
`dist` was last deployed here.

## Follow-ups (not done)
- PWA manifest + service worker for installability/offline.
