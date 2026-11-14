# GameArena
Multiplayer chess, checkers, Ludo and tic-tac-toe with free and staked tables, M-Pesa deposits and withdrawals.

## Run it
1. `npm install` then `npm rebuild better-sqlite3` (first time only)
2. `copy .env.example .env` (Mac/Linux: `cp`), then fill in `.env`
3. `npm start` and open http://localhost:3000
Local testing: keep `DEV_SHOW_CODES=1` so email codes appear on screen.

## Payments with PalPluss (M-Pesa)
Deposits are M-Pesa STK pushes into your PalPluss default channel (your till). Withdrawals are PalPluss B2C payouts to the player's M-Pesa number.
1. PalPluss console > API Keys: create a key and put it in `PALPLUSS_API_KEY`. Set `CALLBACK_SECRET` (16+ random characters, `npm run secret`) and `BASE_URL` (your public **https** address).
2. PalPluss cannot reach `localhost`. For local testing run `ngrok http 3000` and use that https address as `BASE_URL`. You do not configure a webhook in the dashboard: the site sends its own callback address with every payment.
3. **Fund the B2C payout wallet.** Withdrawals are paid from your PalPluss B2C wallet, not from your till. Ask PalPluss support how to top it up. The admin page shows its balance. If it runs low, withdrawals wait in a queue and retry automatically (and the admin is emailed when `ADMIN_EMAIL` is set); they are refunded to the player after 15 minutes.
4. How it stays correct: PalPluss webhooks are not signed, so the site treats them only as a hint and re-checks every payment with PalPluss before moving money. Every 10 seconds it also re-checks anything still pending, so a lost webhook never loses a payment. Credits and refunds happen exactly once, and a payout whose reply was lost is looked up before it is ever re-sent, so nobody is paid twice.
5. Withdrawals over `WITHDRAW_REVIEW_OVER` (default KES 5,000) wait for admin approval on /admin.html.
6. First test: deposit KES 10, then withdraw KES 50 (the minimum), before announcing anything.

## Keeping customer data safe
- The database is SQLite in `DB_FILE`, in WAL mode with full sync, so a committed deposit survives a crash.
- **Hosts that wipe the disk (Render, Heroku, Railway free plans) lose everything on each deploy.** Either attach a Persistent Disk (Render: paid plan, mount `/var/data`, `DB_FILE=/var/data/data.db`) or set `BACKUP_S3_*` and `BACKUP_KEY` (see `.env.example`) so the site saves an encrypted copy to Cloudflare R2, Backblaze B2 or AWS S3 every 10 minutes and on shutdown, and restores it automatically on start. On Render the site refuses to start without one of these.
- Never run two copies of the site against the same database. Run one instance.
- Sessions: every account has a permanent random id and logins are tied to it, so a login can never land on someone else's account, even after a restore.

## Sign in with Google
1. console.cloud.google.com > create a project > APIs & Services > OAuth consent screen (External), then Credentials > Create credentials > OAuth client ID > Web application.
2. Add Authorized JavaScript origins: `http://localhost:3000` and your live https address.
3. Copy the Client ID into `GOOGLE_CLIENT_ID` in `.env` and restart. A "Continue with Google" button appears on the sign-in page. New players add their phone number and date of birth once.

## Email verification codes
Sign up and login send a 6-digit code to the player's email (SMTP: Brevo, Gmail, etc.). Codes expire after 10 minutes, allow 5 attempts and can be resent after 60 seconds. SMS through Africa's Talking is optional.

## Forgot password
On the login screen, "Forgot your password?" asks for the phone number or email, emails a 6-digit code (valid 10 minutes), then lets the player choose a new password and logs them in. Every other device is signed out. Accounts with no email on file get the code by SMS if SMS is set up. Players who joined with Google can use this to create a password, which also lets them sign in to the Android app.

## Tournaments
Anyone can create a knockout tournament in the Tournaments tab: name, game, size, entry fee and (for Ludo) how many players per match. Entry fees are taken from wallets when players join, and refunded if they leave or the tournament is cancelled before it starts. When the last place fills, it starts by itself: players are drawn at random, every match is created automatically, winners move up and meet each other, and each next match starts as soon as the matches feeding it are finished. Players get a "Your match is ready" prompt and have 3 minutes to step in or they forfeit. Drawn chess, checkers and tic-tac-toe games are replayed, and a third draw is settled by coin flip. The champion is paid automatically: 90% of the pool goes to their wallet and 10% stays with GameArena (`TOURNAMENT_FEE`). Withdrawing pays whatever is in the wallet. Sizes: 4, 8, 16 or 32 for two-player games; Ludo with 3 per match: 9 or 27; with 4 per match: 16 or 64. Open tournaments that have not filled after 24 hours are cancelled and refunded. Real-money tournaments count as gambling, so they need your GRA licence like staked games.

## Public chat
The Chat tab is one room for everyone online. Players post, see new messages instantly, and reply to a message (the reply shows the original). Links and phone numbers are blocked and sending is rate limited to protect players from scams. The last 500 messages are kept. Admins (`ADMIN_PHONES`) see a Delete link on every message.

## Tests, backups, going live
- `npm test` runs the whole site against a mock PalPluss: deposits, forged webhooks, replays, staked games, payouts, refunds, tournaments, chat. `npm run test:payments` runs the fast money and backup tests (Node 22, no install needed).
- `npm run backup` copies the database into `backups/`. Schedule it daily.
- Admin page: set `ADMIN_PHONES`, log in with that number, open /admin.html.
- See DEPLOY.md for putting it online. Real-money play in Kenya needs a Gambling Regulatory Authority (GRA) licence under the Gambling Control Act 2025. Use `STAKES_ENABLED=0` to launch free play only until you have it.
