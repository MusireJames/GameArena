# Deploying StakeArena

## 0. Decide your launch mode
Real-money play needs (1) a Gambling Regulatory Authority (GRA) licence under Kenya's Gambling Control Act 2025, (2) a live payment account that accepts your business (Paystack, or Daraja with B2C approval), (3) a working email provider (SMS is optional).
If any of these is not ready today, **launch free play first**: set `STAKES_ENABLED=0`. Players can play, rank and chat; deposits and staked tables stay off. Switch to `1` when everything is approved.

## 1. Get a server and a domain
Any Ubuntu 22.04 or 24.04 server with 1 GB RAM (Hetzner, DigitalOcean, Contabo...). Point your domain's A record to the server's IP address.

## 2. Prepare the server (SSH in as root, then)
```
apt update && apt install -y curl git build-essential python3 ufw
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs
npm install -g pm2
```

## 3. Upload and install
Copy the project folder to the server (for example with WinSCP, or `scp -r stakearena root@SERVER_IP:/opt/`), then:
```
cd /opt/stakearena
npm install --omit=dev
npm run secret        # run twice: one value for JWT_SECRET, one for CALLBACK_SECRET
cp .env.example .env && nano .env
```
In `.env` set at least: `NODE_ENV=production`, `BASE_URL=https://yourdomain.com`, `JWT_SECRET`, `CALLBACK_SECRET`, SMS or email settings, `ADMIN_PHONES`, `COMPANY_NAME`, `LICENCE_NO`, `SUPPORT_EMAIL`, `HELPLINE`, and **delete the `DEV_SHOW_CODES` line**. For real money also set `PAYSTACK_SECRET_KEY` to your live key (`sk_live_...`) and point the Paystack webhook at `https://yourdomain.com/api/paystack/webhook` (see README).
The server refuses to start in production if something unsafe is missing, and tells you exactly what.

## 4. Run it
```
pm2 start ecosystem.config.js && pm2 save && pm2 startup
```

## 5. HTTPS with Caddy
```
apt install -y caddy
printf 'yourdomain.com {\n  encode gzip\n  reverse_proxy localhost:3000\n}\n' > /etc/caddy/Caddyfile
systemctl restart caddy
```
Open https://yourdomain.com and https://yourdomain.com/healthz (it should say ok).

## 6. Backups
```
crontab -e     # add:  0 3 * * * cd /opt/stakearena && npm run backup
```
Copy the `backups` folder off the server regularly (another machine or cloud storage).

## 7. Before you announce it
- Register with your admin phone number, then open /admin.html.
- Do a real KES 10 deposit and a small withdrawal yourself.
- Fill in and have a lawyer review the legal pages (they read your `.env` details).
- Check the admin page daily for withdrawals awaiting approval, ID checks, support messages and collusion flags.

## Docker instead
Add `DOMAIN=yourdomain.com` to `.env`, then `docker compose up -d --build`. Data lives in a Docker volume; use `docker compose exec app npm run backup` for backups.
