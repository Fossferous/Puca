# Putting Puca behind Cloudflare (free tier)

This hides the origin IP from public DNS and lets Cloudflare absorb L3/L4 and
L7 **HTTP** floods before they reach the origin's uplink. It is the single
highest-leverage, zero-cost hardening step for a self-hosted deployment.

## What it does and does NOT do

- ✅ Hides the origin IP for HTTP/HTTPS/WebSocket traffic (DNS returns
  Cloudflare's anycast IPs, not the origin).
- ✅ Absorbs volumetric and application-layer floods aimed at the web/API
  surface — Cloudflare's DDoS mitigation is on all plans, free included.
- ✅ WebSockets are proxied on **every** plan including Free (the "no WS on
  free" belief is a myth). `/ws` works fine.
- ✅ 100 MB free-tier request-body cap is a non-issue — the app caps uploads at
  16 MB.
- ❌ Does **not** protect the WebRTC/TURN media path. Cloudflare only proxies
  HTTP(S) ports; coturn is UDP (3479 + relay range) and needs a directly
  reachable address, so a TURN hostname must stay **DNS-only (grey cloud)** and
  therefore still exposes whatever IP it points at. See "The TURN tension".
- ❌ Does not help if an attacker already knows the origin IP and it is still
  directly reachable — you MUST also lock the origin to Cloudflare (step 5).

## Prerequisites

- The domain's DNS must be served by Cloudflare (free). Today DNS is on Porkbun
  (see `deploy/webapp/README.md`); moving nameservers to Cloudflare is required
  for the orange-cloud proxy to work. Cloudflare imports existing records during
  onboarding — verify every record carried over before switching nameservers.

## Steps

### 1. Add the site to Cloudflare
Create a free account, add `example.com`, let it import records, then change the
nameservers at Porkbun to the two Cloudflare gives you. Wait for activation.

### 2. Proxy the web/API records (orange cloud), keep TURN grey
- `chat` (API/WS)  → **Proxied** (orange)
- `app`  (web app) → **Proxied** (orange)
- `download`        → **Proxied** (orange)
- `turn` (new)      → **DNS only** (grey), A record → origin public IP
  Then set `TURN_SERVER=turn:turn.example.com:3479` in `/opt/puca/.env` so
  ICE hands out the grey hostname (not `chat.example.com`, which is now anycast and
  cannot carry UDP). `systemctl restart puca`.

### 3. TLS
Set SSL/TLS mode to **Full (strict)**. With the orange cloud in front, Caddy's
HTTP-01 ACME challenge can be intercepted by Cloudflare, so issue the origin
cert one of these ways instead:
- **Cloudflare Origin CA** cert on the origin (15-year cert, simplest), or
- **Caddy DNS-01** via the Cloudflare DNS plugin (`caddy-dns/cloudflare`) using
  a scoped API token — keeps Caddy's auto-renewal working behind the proxy.

### 4. Restore the real client IP at the origin (REQUIRED for rate limiting)
Behind Cloudflare every request arrives from a Cloudflare IP, so the backend
rate limiter would bucket ALL users under one key. Swap the `reverse_proxy`
block in your live Caddyfile to the CF-aware variant in
[`caddy-behind-cloudflare.snippet`](caddy-behind-cloudflare.snippet). It reads
the true client IP from `CF-Connecting-IP` — but that header is only
trustworthy once step 5 guarantees requests can *only* come from Cloudflare.

### 5. Lock the origin to Cloudflare (REQUIRED)
If the origin still answers 80/443 from the whole internet, an attacker just
skips Cloudflare (and can forge `CF-Connecting-IP`). Restrict inbound 80/443 to
Cloudflare's published ranges with [`origin-firewall.sh`](origin-firewall.sh).
Run it on the Caddy host; re-run when Cloudflare updates its ranges.

### 6. Cloudflare settings worth enabling
- A **rate-limiting rule** on `/auth/*` (free tier includes one) — defence in
  depth on top of the app limiter.
- **Do NOT** leave "Under Attack" mode on — it JS-challenges clients and breaks
  the native desktop/mobile apps hitting the API. Turn it on only during an
  active incident, off afterwards.
- **Bot Fight Mode**: leave off or scope carefully — it can challenge the native
  API clients too.
- **Caching**: make sure `chat.example.com` (API/WS) is NOT cached — add a cache
  rule to bypass, or Cloudflare may cache API responses.

## The TURN tension (read this)

Cloudflare cannot proxy the UDP media relay, so the `turn.` grey record still
publishes a reachable IP. Two honest options:

1. **Accept partial hiding** — anonymous scanners hitting `chat.example.com` see
   only Cloudflare, but anyone who resolves `turn.example.com` (or reads ICE
   candidates during a call) learns the origin IP and can flood it directly.
   Reasonable for a friends-scale server; combine with the coturn bandwidth caps
   already set in `deploy/turn/turnserver.conf` and per-source UDP rate-limiting
   on the router.
2. **Move coturn to a cheap VPS** — point `turn.` at the VPS instead of home, so
   the residential IP never appears anywhere. This is the only way to fully hide
   the origin including media. See the DDoS assessment for the VPS-front option.
