# 🛸 NEBULA PROTOCOL — Sci-Fi Riddle Game (Leaderboard Edition)

A high-security sci-fi quiz game: players crack 5 cipher nodes, score points, and climb a **persistent global leaderboard**. No rewards — pure competition.

- **Player frontend (`/`)** — animated starfield, glitch title, typewriter ciphers, HUD console, live leaderboard
- **Admin command deck (`/admin`)** — riddles, players, audit log, threat feed. Password + 2FA + lockout.

## Quick start (local)

```bash
cd quiz-arena
npm install
cp .env.example .env   # set a long SESSION_SECRET
node server.js
```

- Game: http://localhost:3000/ · Admin: http://localhost:3000/admin
- Local mode uses built-in **SQLite** (`data/quiz.db`) — zero setup.
- Without Discord keys it runs in **demo mode** (test with any username).

First run prints a one-time **admin password** in the console. First admin login forces: **change password → enroll 2FA**.

## Publish for FREE ($0, no card)

👉 Follow **[DEPLOY.md](DEPLOY.md)** — click-by-click guide: GitHub + Neon Postgres (free database) + Render (free hosting). ~30 minutes, email address only.

Production uses **Postgres** via `DATABASE_URL` (same code, auto-detected). Leaderboard survives forever — sleep/wake cycles never touch your data.

## Discord login (optional)

 discord.com/developers → OAuth2 → redirect `https://YOUR-DOMAIN/auth/discord/callback` → set `DISCORD_CLIENT_ID/SECRET` + `BASE_URL` → restart/redeploy.

## Security

Helmet CSP/HSTS/clickjacking defense · HttpOnly+SameSite sessions in DB · CSRF tokens · rate limits (global/login/admin/submit) · bcrypt(12) + TOTP 2FA + 15-min lockout · salted answer hashes, constant-time compare, never sent to clients · anti-cheat (10 tries/10min, 3s interval, fast-solve flags) · parameterized queries + input validation · full audit log · no stack-trace leaks.

## Files

```
server.js            → routes: pages, player API, admin API, OAuth
lib/db.js            → dual-driver DB (SQLite local / Postgres prod) + hashing + seed
lib/security.js      → sessions, CSRF, rate limits, guards
lib/discord.js       → Discord OAuth2
public/index.html    → sci-fi player frontend (single file, zero external JS)
public/admin.html    → sci-fi admin deck (single file)
render.yaml          → Render one-click blueprint (DB = Neon, set manually)
DEPLOY.md            → free publishing guide
```

## Forgot admin password (local)?

```bash
node -e "const D=require('better-sqlite3'),b=require('bcryptjs'),db=new D('./data/quiz.db');
db.prepare('UPDATE admin_users SET password_hash=?,totp_secret=NULL,totp_enabled=0,must_change_password=1,failed_logins=0,locked_until=NULL WHERE username=?')
.run(b.hashSync('NEW-Strong-Passw0rd!',12),'admin');console.log('reset done')"
```

(On production: Neon SQL Editor → `DELETE FROM admin_users;` → redeploy → fresh bootstrap. See DEPLOY.md.)
