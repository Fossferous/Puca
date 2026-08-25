# Production Deployment Guide

Step-by-step guide to deploy Púca on a VPS with a custom domain.

---

## Prerequisites

- ✅ VPS (Ubuntu 22.04 recommended) - DigitalOcean, Linode, Vultr, etc.
- ✅ Domain name pointing to your VPS IP
- ✅ SSH access to your VPS

---

## Step 1: Connect to VPS & Install Dependencies

```bash
ssh root@your-vps-ip

# Update system
apt update && apt upgrade -y

# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env

# Install PostgreSQL
apt install postgresql postgresql-contrib -y

# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt install nodejs -y

# Install nginx (for reverse proxy + SSL)
apt install nginx certbot python3-certbot-nginx -y

# Install git
apt install git -y
```

---

## Step 2: Set Up PostgreSQL

```bash
# Switch to postgres user
sudo -u postgres psql

# Create database and user
CREATE DATABASE puca;
CREATE USER puca_user WITH ENCRYPTED PASSWORD 'STRONG_PASSWORD_HERE';
GRANT ALL PRIVILEGES ON DATABASE puca TO puca_user;
\c puca
GRANT ALL ON SCHEMA public TO puca_user;
\q
```

---

## Step 3: Clone & Build Púca

```bash
# Clone your repo
cd /opt
git clone https://github.com/Fossferous/puca.git
cd puca

# Do NOT apply the migrations by hand. The backend embeds them
# (sqlx::migrate!) and runs them itself at startup. Applying them with psql
# creates the tables WITHOUT the _sqlx_migrations bookkeeping rows, so on
# first boot sqlx tries to run 001 against tables that already exist, the
# migration call panics, and the service crash-loops.

# Build backend (release mode)
cargo build --release
```

Migrations are applied automatically the first time the service starts (Step 6);
watch for "Migrations complete" in `journalctl -u puca`.

---

## Step 4: Configure Environment

```bash
# Create environment file
cat > /opt/puca/.env << 'EOF'
DATABASE_URL=postgresql://puca_user:STRONG_PASSWORD_HERE@localhost:5432/puca
JWT_SECRET=GENERATE_A_LONG_RANDOM_STRING_HERE
APP_URL=https://yourdomain.com

# Optional: Email for password reset
# SMTP_HOST=smtp.example.com
# SMTP_PORT=587
# SMTP_USERNAME=your-email
# SMTP_PASSWORD=your-password
# SMTP_FROM=noreply@yourdomain.com
EOF

# Secure the file
chmod 600 /opt/puca/.env
```

**Generate JWT secret:**
```bash
openssl rand -base64 32
```

---

## Step 5: Create Systemd Service

```bash
cat > /etc/systemd/system/puca.service << 'EOF'
[Unit]
Description=Púca Chat Server
After=network.target postgresql.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/puca
EnvironmentFile=/opt/puca/.env
ExecStart=/opt/puca/target/release/puca
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Enable and start
systemctl daemon-reload
systemctl enable puca
systemctl start puca

# Check status
systemctl status puca
```

---

## Step 6: Configure Nginx Reverse Proxy

Use the maintained config from the repo — it proxies the whole origin (no
`/api` prefix), handles WebSocket upgrades, and sets `X-Forwarded-For`,
which the backend rate limiter requires to tell clients apart:

```bash
# Edit the domain inside the file first
cp deploy/nginx.conf /etc/nginx/sites-available/puca
ln -s /etc/nginx/sites-available/puca /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx
```

(There is no `/uploads/` route — file downloads are served at `/files/:id`
through the normal proxy. See `deploy/README.md` for the full runbook, or
`deploy/Caddyfile` for a simpler auto-HTTPS alternative.)

---

## Step 7: Enable HTTPS (SSL)

```bash
# Get free SSL certificate from Let's Encrypt
certbot --nginx -d yourdomain.com

# Auto-renewal is set up automatically
```

---

## Step 8: Update Desktop App Config

Do **not** edit `frontend/src/api/config.ts` — the API base URL is a
build-time env var (read by `frontend/src/api/platform.ts`), and the
WebSocket URL derives from it automatically. No `/api` suffix:

```bash
cd frontend
echo 'VITE_API_URL=https://yourdomain.com' > .env.production
npm run tauri build
```

Then rebuild:
```bash
cd frontend
npm run tauri:build
```

---

## Step 9: Firewall Setup

```bash
# Allow SSH, HTTP, HTTPS
ufw allow 22
ufw allow 80
ufw allow 443
ufw enable
```

---

## Quick Commands

```bash
# View logs
journalctl -u puca -f

# Restart server
systemctl restart puca

# Update from git
cd /opt/puca
git pull
cargo build --release
systemctl restart puca
```

---

## Checklist

- [ ] Domain DNS pointing to VPS IP
- [ ] PostgreSQL installed and configured
- [ ] Migrations run
- [ ] .env file with strong passwords
- [ ] Backend running as systemd service
- [ ] Nginx configured
- [ ] SSL certificate installed
- [ ] Firewall configured
- [ ] Desktop app rebuilt with production URL

---

## Troubleshooting

**Backend won't start:**
```bash
journalctl -u puca -n 50
```

**Database connection failed:**
```bash
sudo -u postgres psql -d puca -c "SELECT 1"
```

**Nginx errors:**
```bash
nginx -t
tail -f /var/log/nginx/error.log
```
