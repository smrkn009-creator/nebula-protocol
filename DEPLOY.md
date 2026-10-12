# 🚀 Publish Your Website for FREE — Complete Guide (No Money, No Card)

Follow this exactly, step by step. You only need an **email address**. Total time: ~30 minutes.

## What you will get

- Your game live at `https://YOUR-NAME.onrender.com` — free forever, with HTTPS 🔒
- Leaderboard + players **saved permanently** in a free cloud database (Neon Postgres)
- Total cost: **$0**, no credit card asked anywhere

**Honest caveats of free hosting (read this!):**
- If nobody visits for 15 minutes, the site **sleeps**. The next visitor waits **~1 minute** while it wakes up. Then it's fast again. This is normal on free plans.
- Your **data is safe** during sleep — only the running app pauses. Scores/players live in Neon, which never deletes them.
- Free = shared/slow-ish. Perfect for starting out. You can upgrade later when the game grows.

---

## PART 1 — Put your code on GitHub (10 min)

GitHub stores your code for free and Render reads it from there.

1. Go to **https://github.com/signup** and create an account (email + password). Verify your email.
2. Click the **+** (top right) → **New repository**.
   - Repository name: `nebula-protocol` (or anything)
   - ✅ Public (required for free Render deploys from GitHub)
   - Click **Create repository**.
3. On the new repo page, click **uploading an existing file** (the link in the middle).
4. From your computer, upload **these files/folders from the `quiz-arena` folder**:
   - `server.js`, `package.json`, `package-lock.json`, `render.yaml`, `.gitignore`
   - `.env.example` (⚠️ NOT your real `.env` — never upload that!)
   - the `lib/` folder (3 files inside)
   - the `public/` folder (2 files inside)
   - `README.md`, `DEPLOY.md` (optional)
   - ❌ Do **NOT** upload: `node_modules/`, `.env`, `data/`
   - Tip: drag-and-drop works. You may need 2–3 uploads to include subfolders (GitHub web upload flattens — recreate `lib/` and `public/` folders: type `lib/` in the name field... simplest: upload files, then use **Add file → Create new file**, type `lib/placeholder`, then upload into it. OR install GitHub Desktop app which handles folders automatically.)
5. Click **Commit changes**. Your code is now on GitHub. ✅

> Easier alternative: install **GitHub Desktop** (free app), clone the empty repo, copy the files in, commit + push. Same result, folders handled automatically.

---

## PART 2 — Free database on Neon (5 min)

This is where players + scores live forever.

1. Go to **https://neon.tech** → **Sign Up** → continue with **GitHub** (no card needed).
2. Click **New Project**:
   - Name: `nebula-protocol`
   - Region: **Singapore** (`ap-southeast-1`) — closest to Pakistan = fastest
   - Database name: leave default (`neondb`)
   - Click **Create project**.
3. You'll see a **Connection Details** box. Make sure it shows the **Direct** connection (not pooled) and click to **show password**.
4. Click **Copy** on the connection string. It looks like:
   ```
   postgresql://neondb_owner:PASSWORD@ep-xxxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
   ```
5. **Save this string in a private note** (you'll paste it into Render in Part 3). Never share it publicly — it's your database password.

Done. Neon dashboard will show your project sleeping/waking automatically — that's normal and free. ✅

---

## PART 3 — Free website hosting on Render (10 min)

1. Go to **https://render.com** → **Sign Up** → continue with **GitHub** (no card needed).
2. Dashboard → **New +** → **Web Service** → **Connect** your `nebula-protocol` repo (authorize Render to see it if asked).
3. Settings (fill exactly):
   - **Name:** `nebula-protocol` (this becomes `nebula-protocol.onrender.com`)
   - **Region:** Singapore
   - **Branch:** main (default)
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** **Free** ✅
4. Scroll to **Environment Variables** → **Add** each of these (exact names!):

   | Key | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `NODE_VERSION` | `20` |
   | `SESSION_SECRET` | any long random text, 40+ characters (make one up with letters+numbers+symbols, e.g. from a password generator) |
   | `DATABASE_URL` | paste the Neon string from Part 2 |
   | `ADMIN_USERNAME` | `admin` |
   | `ADMIN_BOOTSTRAP_PASSWORD` | invent a strong one-time password (e.g. `Galaxy#Start!88Qx`) — you'll change it right after first login |
   | `BASE_URL` | `https://nebula-protocol.onrender.com` (use YOUR actual name) |

5. Click **Create Web Service**. Render now builds your site (~3–5 min). Watch the **Logs** tab — you should end with:
   ```
   [db] driver: pg
   [quiz-arena] Player site : ...
   ```
6. Click the `https://...onrender.com` URL at the top. **Your game is LIVE!** 🎉

---

## PART 4 — Your first admin login (5 min)

1. Open `https://YOUR-NAME.onrender.com/admin`
2. Log in with:
   - Username: `admin`
   - Password: the `ADMIN_BOOTSTRAP_PASSWORD` you set in Part 3
3. You'll be forced to: **scan the 2FA QR code** (Google Authenticator / Authy app on your phone) → **set a new strong password**.
4. Done — you now control riddles, players, and the leaderboard from anywhere. 🔐

---

## PART 5 — Discord login (optional, later)

Players can already play in demo mode. For real Discord logins:

1. https://discord.com/developers/applications → **New Application** → **OAuth2**.
2. **Redirects → Add Another**: `https://YOUR-NAME.onrender.com/auth/discord/callback` → Save.
3. Copy **Client ID** + **Client Secret**.
4. Render dashboard → your service → **Environment** → add:
   - `DISCORD_CLIENT_ID` = your ID
   - `DISCORD_CLIENT_SECRET` = your secret
   - (BASE_URL is already set from Part 3)
5. **Manual Deploy → Deploy latest commit**. Done — Discord button appears automatically.

---

## PART 6 — Everyday use

- **Play:** `https://YOUR-NAME.onrender.com`
- **Admin:** `.../admin`
- **Update your site:** change files → upload/commit to GitHub → Render **auto-redeploys** in ~3 min. (Players/scores are NOT touched — they're in Neon.)
- **View logs:** Render dashboard → your service → **Logs**.
- **Site sleeping?** Just open it and wait ~1 min. First visit of the day is always slow — totally normal on free tier.

---

## 🆘 Troubleshooting

| Problem | Fix |
|---|---|
| Build fails / "engine" error | Check env var `NODE_VERSION=20` is set; check Build Command is `npm install` |
| `[fatal] DB init failed` in logs | `DATABASE_URL` is wrong — re-copy from Neon (must end with `?sslmode=require`, password included) |
| Site shows "waking up" / slow first load | Normal — wait ~60 seconds and refresh |
| Admin says "locked" | 5 wrong tries = 15-min lock. Wait, then try again. |
| Forgot admin password | Render → Environment → change `ADMIN_BOOTSTRAP_PASSWORD` → redeploy does NOT reset it (only works on empty DB). Instead: Neon dashboard → SQL Editor → run: `DELETE FROM admin_users;` → redeploy → fresh bootstrap account is created. Then re-do Part 4. |
| Discord button missing | Normal until Part 5 is done — demo mode works meanwhile |
| `npm install` works locally but Render fails | Make sure `package-lock.json` was uploaded to GitHub |

---

## 🔒 Security reminders

- NEVER upload your real `.env` file or post `DATABASE_URL` / passwords publicly.
- Your repo is Public (required) — that's fine: secrets live only in Render's Environment tab, never in code.
- Keep your admin password + 2FA phone safe. Without them, recovery = the SQL reset above.

## 🌱 When you grow (later, still cheap/free)

- **Custom domain:** buy any domain (~$10/year) → Render dashboard → Settings → Custom Domain (free to attach, HTTPS included).
- **No more sleeping:** Render Starter ($7/mo) — only when your players demand it.
- **More riddles/players:** Neon free tier (0.5–1 GB) handles thousands of players. You'll be fine for a long time.
