# HTTPS Setup Guide

> **Canonical configs live in [`deploy/`](../deploy/README.md)** (Caddyfile,
> nginx.conf, systemd unit) and are kept in sync with the code. This page is
> background reading; if it disagrees with `deploy/`, `deploy/` wins.

For production, use a reverse proxy for TLS termination. This is more secure and easier to maintain than embedding TLS in the application.

## Option 1: Caddy (Recommended - Auto-SSL)

```caddyfile
puca.example.com {
    reverse_proxy localhost:3000
    
    @websocket {
        header Connection *Upgrade*
        header Upgrade websocket
    }
    reverse_proxy @websocket localhost:3000
}
```

Caddy automatically obtains and renews Let's Encrypt certificates.

## Option 2: Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name puca.example.com;
    
    ssl_certificate /etc/letsencrypt/live/puca.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/puca.example.com/privkey.pem;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        # Set to the real peer, NOT $proxy_add_x_forwarded_for: that APPENDS to
        # any client-supplied X-Forwarded-For, letting a client spoof the value
        # the backend rate limiter keys on (leftmost XFF) and bypass the limits.
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    
    location /ws {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400s;
    }
}

server {
    listen 80;
    server_name puca.example.com;
    return 301 https://$server_name$request_uri;
}
```

## Get SSL Certificate (Let's Encrypt)

```bash
# Install certbot
sudo apt install certbot

# Get certificate
sudo certbot certonly --standalone -d puca.example.com

# Auto-renewal (already set up by certbot)
sudo systemctl status certbot.timer
```

## Update Frontend

Do **not** edit `frontend/src/api/config.ts` — the API base URL is a
build-time env var (read by `frontend/src/api/platform.ts`), and the
WebSocket URL is derived from it automatically. The whole origin is proxied,
so there is **no `/api` suffix**:

```bash
cd frontend
echo 'VITE_API_URL=https://puca.example.com' > .env.production
npm run build
```

## Security Headers

Add these headers in your reverse proxy for additional security:

```nginx
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-XSS-Protection "1; mode=block" always;
```
