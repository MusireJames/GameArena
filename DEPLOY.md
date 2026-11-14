# Deploying GameArena

## 0. Before you start
Real-money play needs (1) a Gambling Regulatory Authority (GRA) licence under Kenya's Gambling Control Act 2025, (2) your PalPluss account (KYC verified) with an API key, (3) a working email provider. If any is not ready, launch free play first with `STAKES_ENABLED=0`.

## 1. Choose how the data stays safe (important)
Customer data lives in one SQLite file. Pick ONE:
- **A VPS (Hetzner, DigitalOcean, Contabo): recommended.** The disk is permanent. Still set up the off-site backup in step 5.
- **Render:** the free plan wipes the disk on every deploy and refresh, which is what deleted your data before. Use a paid web service with a Persistent Disk (this repo's `render.yaml` does it: 5 GB at `/var/data`, `DB_FILE=/var/data/data.db`), and also set the `BACKUP_S3_*` backup. The site will refuse to start on Render without one of the two.

## 2. Render (Blueprint)
1. Push this folder to a private GitHub repo (never commit `.env` or `android/keys`).
2. Render > New > Blueprint > pick the repo. Fill in the secrets it asks for: `PALPLUSS_API_KEY`, `BASE_URL` (your https address, for example `https://gamearena.onrender.com` or your own domain), email settings, `ADMIN_PHONES`, `ADMIN_EMAIL`, `BACKUP_S3_*`, `BACKUP_KEY`. `JWT_SECRET` and `CALLBACK_SECRET` are generated for you.
3. Deploy. Open `/healthz`: it should say ok.

## 3. A VPS instead
```
apt update && apt install -y curl git build-essential python3 ufw
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs
npm install -g pm2
cd /opt/gamearena && npm install --omit=dev
npm run secret        # run twice: JWT_SECRET and CALLBACK_SECRET
cp .env.example .env && nano .env
pm2 start ecosystem.config.js && pm2 save && pm2 startup
apt install -y caddy
printf 'yourdomain.com {\n  encode gzip\n  reverse_proxy localhost:3000\n}\n' > /etc/caddy/Caddyfile && systemctl restart caddy
```
In `.env` set at least `NODE_ENV=production`, `BASE_URL`, `JWT_SECRET`, `CALLBACK_SECRET`, `PALPLUSS_API_KEY`, `ADMIN_PHONES`, `ADMIN_EMAIL`, `COMPANY_NAME`, `LICENCE_NO`, `SUPPORT_EMAIL`, `HELPLINE`, and delete `DEV_SHOW_CODES`. The server refuses to start in production if something unsafe is missing and tells you exactly what. Docker alternative: `docker compose up -d --build`.

## 4. PalPluss
- Deposits go to your default channel (your till). No webhook setup is needed: the site sends its callback address with each payment.
- **Fund your B2C payout wallet** (ask PalPluss how). Without money there, withdrawals queue and are refunded after 15 minutes.
- Keep `ADMIN_EMAIL` set: you are emailed when the payout wallet is low, a payout is stuck, or a payment needs a look.

## 5. Off-site backups (do this even with a disk)
Create a free bucket (Cloudflare R2 or Backblaze B2), then set `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY`, `BACKUP_S3_SECRET_KEY` and a long random `BACKUP_KEY` (it encrypts the data; **store it safely, without it backups cannot be read**). The site saves every 10 minutes when something changed, and once more at shutdown. If the database file is ever missing, it is restored automatically on start. Manual recovery: `node backup.js restore latest` (or `hourly/07`, `daily/2026-11-12`) writes `restored.db`.

## 6. After the first deploy
- Everyone is logged out once (a security fix); they simply log in again.
- Register with your admin phone and open /admin.html.
- Do a real KES 10 deposit and a KES 50 withdrawal yourself.
- Run one instance only (never two servers on one database).
- Have a lawyer review the legal pages (they read your `.env` details).
- Check /admin.html daily for payouts awaiting approval, queued or stuck, deposits needing a look, and fraud flags.
