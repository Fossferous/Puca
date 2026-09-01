# Caddy front-door config for example.com.
#
# One Caddy instance handles TLS + routing for BOTH Puca and your existing
# Matrix service, keyed by hostname. Point your router's 80/443 forward at the
# machine running this Caddy. Caddy auto-obtains and renews Let's Encrypt certs
# for every hostname below.
#
# See deploy/SELF_HOSTING_PROXMOX.md for the full runbook.

# ---------------------------------------------------------------------------
# Puca  —  chat.example.com
# This block is complete; it assumes the Puca backend runs on the SAME
# machine as Caddy (127.0.0.1:3000). If Puca is on a different LXC/VM,
# change 127.0.0.1:3000 to that box's internal address, e.g. 192.168.1.50:3000.
# ---------------------------------------------------------------------------
chat.example.com {
	reverse_proxy 127.0.0.1:3000 {
		# The backend rate limiter keys clients by X-Forwarded-For. Overwrite it
		# with the real TCP peer ({remote_host}) so a client cannot inject a
		# spoofed leftmost value and mint a fresh limiter bucket per request
		# (which would defeat the 5/s auth and 50/s API limits entirely).
		header_up X-Forwarded-For {remote_host}
		# Same reasoning, for the header the backend prefers when
		# TRUST_CF_CONNECTING_IP=true. Caddy forwards unknown client headers
		# verbatim, so without this a caller behind THIS proxy could still hand
		# the backend a CF-Connecting-IP of its choosing. Delete it here and the
		# backend cannot be fooled even if the flag is set by mistake.
		# If you later front this with Cloudflare, do NOT hand-edit this block:
		# swap in deploy/cloudflare/caddy-behind-cloudflare.snippet wholesale
		# (global options block included — it is required, and missing it
		# degrades silently to one rate-limit bucket for the entire internet)
		# and lock the origin with deploy/cloudflare/origin-firewall.sh.
		# Leave TRUST_CF_CONNECTING_IP unset in both modes.
		header_up -CF-Connecting-IP
		# Same again for X-Real-IP: the backend falls back to it when
		# X-Forwarded-For is absent, and Caddy forwards unknown client headers
		# verbatim — so a caller could hand the backend one of its choosing.
		header_up -X-Real-IP
	}

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "SAMEORIGIN"
	}

	# App caps uploads at 10 MB (12 MB request limit incl. multipart framing).
	request_body {
		max_size 32MB
	}

	encode gzip
}

# ---------------------------------------------------------------------------
# Web app  —  app.example.com  (the browser client / SPA)
# Serves the static Vite build. Add a Content-Security-Policy here (the API
# vhost above doesn't need one — it returns JSON). VERIFY this CSP against your
# build before trusting it: voice (WebRTC), the E2EE crypto (WASM), and web
# workers can all trip an over-tight policy. Adjust connect-src/img-src to your
# actual API hostname.
# ---------------------------------------------------------------------------
app.example.com {
	root * /opt/puca/webapp
	encode gzip
	try_files {path} /index.html
	file_server

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "SAMEORIGIN"
		# Do NOT add COOP/COEP here. This app deliberately does NOT use
		# SharedArrayBuffer (see frontend/src/api/deepFilter.ts), so it is not
		# cross-origin isolated, and COEP:require-corp would BLOCK the remote
		# image/GIF embeds the chat relies on. img-src/media-src therefore allow
		# https: so remote embeds load.
		#
		# ADD YOUR SFU TO connect-src IF YOU RUN ONE. When LIVEKIT_URL is set in
		# the backend's .env, the browser opens a WebSocket straight to that
		# host, and connect-src governs WebSockets. Leave it out and group voice
		# fails in the browser ONLY — desktop is unaffected, nothing logs an
		# error the operator sees, and the obvious suspect is the SFU rather
		# than a header on a different vhost. Append it here exactly as it
		# appears in .env, e.g. `wss://sfu.example.com`.
		#
		# STUN/TURN need no entry: ICE is not fetch or WebSocket traffic and CSP
		# does not govern it.
		Content-Security-Policy "default-src 'self'; connect-src 'self' https://chat.example.com wss://chat.example.com; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; font-src 'self' data:; worker-src 'self' blob:; child-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'"
	}
}

# ---------------------------------------------------------------------------
# Matrix (Synapse)  —  example.com  [TEMPLATE — verify against your setup]
#
# Only include this block if you are consolidating Matrix behind THIS Caddy.
# If Matrix already has its own working reverse proxy on another machine and
# you're keeping it, DELETE this block and instead point only chat.example.com
# here (use a separate public port for one of them — see Phase 0 of the runbook).
#
# Fill in MATRIX_UPSTREAM with wherever Synapse's client listener actually is:
#   - same machine as Caddy:      127.0.0.1:8008
#   - a separate Matrix VM/LXC:    192.168.1.40:8008   (its internal IP:port)
#
# This is the standard Synapse-behind-Caddy pattern. Confirm your Synapse
# homeserver.yaml listener port before trusting the 8008 default.
# ---------------------------------------------------------------------------
# example.com {
# 	# Matrix client-server + media + federation-over-443 traffic
# 	reverse_proxy /_matrix/*  MATRIX_UPSTREAM
# 	reverse_proxy /_synapse/client/*  MATRIX_UPSTREAM
#
# 	# Everything else on the apex (e.g. a landing page) — optional.
# 	# Remove this route if example.com should only serve Matrix.
# 	# respond "example.com" 200
# }
#
# # Matrix federation on the dedicated port 8448 (only if you federate and have
# # 8448 forwarded on your router). Not needed if you use .well-known delegation.
# example.com:8448 {
# 	reverse_proxy /_matrix/*  MATRIX_UPSTREAM
# }
#
# # Server-to-server delegation so other homeservers find you on 443 instead of
# # 8448. Only if you are NOT forwarding 8448. Adjust to your delegation choice.
# # example.com {
# #     handle /.well-known/matrix/server {
# #         respond `{"m.server": "example.com:443"}` 200
# #         header Content-Type application/json
# #     }
# # }

# --- Bare apex ---
# If you own the apex (example.com) and it has an A record to your IP but you
# only serve subdomains (chat., download.), add a block for it or visitors get
# a TLS "internal error" — Caddy refuses the handshake for hostnames it has no
# site/cert for. Simplest: redirect the apex to your download/landing page.
# (Only add hostnames that actually resolve, or Caddy will spin on failed
# ACME challenges.)
#
# example.com {
# 	redir https://download.example.com{uri} permanent
# }
