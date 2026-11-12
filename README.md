# StakeArena
Multiplayer chess, checkers, Ludo and tic-tac-toe with free and staked tables, M-Pesa deposits and withdrawals.

## Run it
1. `npm install` then `npm rebuild better-sqlite3` (first time only)
2. `copy .env.example .env` (Mac/Linux: `cp`), then fill in `.env`
3. `npm start` and open http://localhost:3000
Local testing: keep `DEV_SHOW_CODES=1` so email codes appear on screen.

## Payments with Paystack
1. Paystack dashboard > Settings > API Keys & Webhooks (Test Mode). Copy the **Test Secret Key** into `PAYSTACK_SECRET_KEY` in `.env`.
2. Paystack cannot reach `localhost`. Run `ngrok http 3000`, put the https address in `BASE_URL`, and set the **Test Webhook URL** in the dashboard to `https://YOUR-ADDRESS/api/paystack/webhook`. Save.
3. Dashboard > Settings > Preferences: switch OFF the OTP requirement for transfers, otherwise payouts cannot complete.
4. Restart the server. Deposit in the Wallet tab: an M-Pesa prompt is sent, the player enters a PIN, and the balance updates by itself (webhook first, with a status check as a backup).
5. Withdrawals are Paystack transfers to the player's M-Pesa number (KES 1 to 150,000 each). Your Paystack balance must hold enough money to pay them out, and Paystack charges a fee per transfer.
6. Going live needs your live key (`sk_live_...`), the live webhook URL, and Paystack approval of your business. Gambling businesses are restricted on Paystack, so confirm with Paystack support first. Daraja is still available with `PAYMENT_PROVIDER=daraja`.

## Sign in with Google
1. console.cloud.google.com > create a project > APIs & Services > OAuth consent screen (External), then Credentials > Create credentials > OAuth client ID > Web application.
2. Add Authorized JavaScript origins: `http://localhost:3000` and your live https address.
3. Copy the Client ID into `GOOGLE_CLIENT_ID` in `.env` and restart. A "Continue with Google" button appears on the sign-in page. New players add their phone number and date of birth once.

## Email verification codes
Sign up and login send a 6-digit code to the player's email (SMTP: Brevo, Gmail, etc.). Codes expire after 10 minutes, allow 5 attempts and can be resent after 60 seconds. SMS through Africa's Talking is optional.

## Forgot password
On the login screen, "Forgot your password?" asks for the phone number or email, emails a 6-digit code (valid 10 minutes), then lets the player choose a new password and logs them in. Every other device is signed out. Accounts with no email on file get the code by SMS if SMS is set up. Players who joined with Google can use this to create a password, which also lets them sign in to the Android app.

## Tournaments
Anyone can create a knockout tournament in the Tournaments tab: name, game, size, entry fee and (for Ludo) how many players per match. Entry fees are taken from wallets when players join, and refunded if they leave or the tournament is cancelled before it starts. When the last place fills, it starts by itself: players are drawn at random, every match is created automatically, winners move up and meet each other, and each next match starts as soon as the matches feeding it are finished. Players get a "Your match is ready" prompt and have 3 minutes to step in or they forfeit. Drawn chess, checkers and tic-tac-toe games are replayed, and a third draw is settled by coin flip. The champion is paid automatically: 90% of the pool goes to their wallet and 10% stays with StakeArena (`TOURNAMENT_FEE`). Withdrawing pays whatever is in the wallet. Sizes: 4, 8, 16 or 32 for two-player games; Ludo with 3 per match: 9 or 27; with 4 per match: 16 or 64. Open tournaments that have not filled after 24 hours are cancelled and refunded. Real-money tournaments count as gambling, so they need your GRA licence like staked games.

## Public chat
The Chat tab is one room for everyone online. Players post, see new messages instantly, and reply to a message (the reply shows the original). Links and phone numbers are blocked and sending is rate limited to protect players from scams. The last 500 messages are kept. Admins (`ADMIN_PHONES`) see a Delete link on every message.

## Tests, backups, going live
- `npm test` runs the full money flow against a mock Paystack: deposits, webhook signatures, replays, staked games, payouts, refunds, Ludo rules, Google sign-in.
- `npm run backup` copies the database into `backups/`. Schedule it daily.
- Admin page: set `ADMIN_PHONES`, log in with that number, open /admin.html.
- See DEPLOY.md for putting it online. Real-money play in Kenya needs a Gambling Regulatory Authority (GRA) licence under the Gambling Control Act 2025. Use `STAKES_ENABLED=0` to launch free play only until you have it.
