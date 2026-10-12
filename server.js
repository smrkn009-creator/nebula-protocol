// QuizArena Secure — player frontend + private admin backend
// Leaderboard edition: no rewards, pure competition.
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const { authenticator } = require('otplib');
const { body, param, query, validationResult } = require('express-validator');

const { get, all, run, audit, initDb, hashIp, newId, hashAnswer, verifyAnswer, fmtTs } = require('./lib/db');
const { ah, sessionMiddleware, ensureCsrf, checkCsrf, globalLimiter, loginLimiter,
  adminLoginLimiter, submitLimiter, requirePlayer, requireAdmin, adminIpGate, isProd } = require('./lib/security');
const discord = require('./lib/discord');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: isProd ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
}));
app.use(express.json({ limit: '64kb' }));
app.use(sessionMiddleware());
app.use(ensureCsrf);
app.use(globalLimiter);

const checkValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  next();
};
const esc = (s) => String(s ?? '').slice(0, 500);
const num = (v) => Number(v) || 0;

// ============================================================ PAGES
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', adminIpGate, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/health', (req, res) => res.json({ ok: true, time: Date.now() }));

// ============================================================ PUBLIC API
app.get('/api/csrf', (req, res) => res.json({ csrf: req.session.csrf }));
app.get('/api/config', (req, res) => res.json({
  demoMode: !discord.discordConfigured(),
  discordLoginUrl: discord.discordConfigured() ? '/auth/discord' : null,
}));

let lbCache = { at: 0, data: [] };
app.get('/api/leaderboard', ah(async (req, res) => {
  if (Date.now() - lbCache.at > 30000) {
    lbCache = {
      at: Date.now(),
      data: await all(`SELECT username, avatar_url, score, riddles_solved
        FROM players WHERE is_banned=0 ORDER BY score DESC, riddles_solved DESC LIMIT 50`),
    };
  }
  res.json({ leaderboard: lbCache.data });
}));

// ============================================================ DISCORD OAUTH
app.get('/auth/discord', loginLimiter, (req, res) => {
  if (!discord.discordConfigured()) return res.status(503).send('Discord login not configured. Enable demo mode or set DISCORD_* in .env.');
  const state = discord.newState();
  req.session.oauthState = state;
  res.redirect(discord.authorizeUrl(state));
});

app.get('/auth/discord/callback', loginLimiter, ah(async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state || state !== req.session.oauthState) {
      audit('anon', 'oauth_state_mismatch', null, req.ip);
      return res.status(400).send('Invalid OAuth state. Please try logging in again.');
    }
    delete req.session.oauthState;
    const tok = await discord.exchangeCode(code);
    const du = await discord.fetchDiscordUser(tok.access_token);
    const display = esc(du.global_name || du.username || 'Agent').slice(0, 32);

    let player = await get('SELECT * FROM players WHERE discord_id=?', du.id);
    if (!player) {
      const id = newId('pl');
      await run('INSERT INTO players (id, discord_id, username, avatar_url, created_at, last_seen_at) VALUES (?,?,?,?,?,?)',
        [id, du.id, display, discord.avatarUrl(du), Date.now(), Date.now()]);
      player = await get('SELECT * FROM players WHERE id=?', id);
      audit('player:' + id, 'player_register', 'discord:' + du.id, req.ip);
    } else {
      await run('UPDATE players SET username=?, avatar_url=?, last_seen_at=? WHERE id=?',
        [display, discord.avatarUrl(du), Date.now(), player.id]);
      if (num(player.is_banned)) return res.status(403).send('Account suspended. Contact support.');
    }
    req.session.regenerate((err) => {
      if (err) return res.status(500).send('Session error. Try again.');
      req.session.playerId = player.id;
      req.session.loginAt = Date.now();
      req.session.csrf = crypto.randomBytes(24).toString('hex');
      audit('player:' + player.id, 'player_login', 'discord', req.ip);
      res.redirect('/?logged_in=1');
    });
  } catch (e) {
    console.error('[oauth]', e.message);
    res.status(500).send('Discord login failed. Please try again.');
  }
}));

app.post('/api/demo-login', loginLimiter, checkCsrf,
  body('username').trim().isLength({ min: 3, max: 24 }).matches(/^[a-zA-Z0-9_.-]+$/).withMessage('Username: 3-24 chars, letters/numbers/._-'),
  checkValidation, ah(async (req, res) => {
    if (discord.discordConfigured()) return res.status(403).json({ error: 'Demo login disabled (Discord is configured).' });
    const username = esc(req.body.username);
    let player = await get('SELECT * FROM players WHERE discord_id IS NULL AND username=?', username);
    if (!player) {
      const id = newId('pl');
      await run('INSERT INTO players (id, username, created_at, last_seen_at) VALUES (?,?,?,?)', [id, username, Date.now(), Date.now()]);
      player = await get('SELECT * FROM players WHERE id=?', id);
      audit('player:' + id, 'player_register', 'demo', req.ip);
    }
    if (num(player.is_banned)) return res.status(403).json({ error: 'Account suspended.' });
    await run('UPDATE players SET last_seen_at=? WHERE id=?', [Date.now(), player.id]);
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Session error.' });
      req.session.playerId = player.id;
      req.session.loginAt = Date.now();
      req.session.csrf = crypto.randomBytes(24).toString('hex');
      audit('player:' + player.id, 'player_login', 'demo', req.ip);
      res.json({ ok: true, csrf: req.session.csrf });
    });
  }));

app.post('/api/logout', checkCsrf, (req, res) => {
  const who = req.session.playerId ? 'player:' + req.session.playerId : 'anon';
  req.session.destroy(() => {});
  audit(who, 'player_logout', null, req.ip);
  res.json({ ok: true });
});

// ============================================================ PLAYER GAME API
app.get('/api/me', requirePlayer, ah(async (req, res) => {
  const p = await get('SELECT id, username, avatar_url, score, riddles_solved FROM players WHERE id=?', req.playerId);
  const total = num((await get('SELECT COUNT(*) AS c FROM riddles WHERE is_active=1')).c);
  const rank = num((await get('SELECT COUNT(*)+1 AS r FROM players WHERE is_banned=0 AND score > ?', p.score)).r);
  res.json({ player: { id: p.id, username: p.username, avatar_url: p.avatar_url, score: num(p.score), riddles_solved: num(p.riddles_solved), rank, totalRiddles: total } });
}));

async function currentRiddleFor(playerId) {
  return get(`SELECT id, level, title, poem, hint, points, time_bonus_max
    FROM riddles WHERE is_active=1 AND id NOT IN (SELECT riddle_id FROM solves WHERE player_id=?)
    ORDER BY level ASC LIMIT 1`, playerId);
}

app.get('/api/riddle/current', requirePlayer, ah(async (req, res) => {
  const r = await currentRiddleFor(req.playerId);
  if (!r) return res.json({ completed: true });
  req.session.riddleTimers = req.session.riddleTimers || {};
  if (!req.session.riddleTimers[r.id]) req.session.riddleTimers[r.id] = Date.now();
  const total = num((await get('SELECT COUNT(*) AS c FROM riddles WHERE is_active=1')).c);
  const solved = num((await get('SELECT COUNT(*) AS c FROM solves WHERE player_id=?', req.playerId)).c);
  const wrong = num((await get('SELECT COUNT(*) AS c FROM attempts WHERE player_id=? AND riddle_id=? AND correct=0 AND created_at > ?',
    req.playerId, r.id, Date.now() - 10 * 60 * 1000)).c);
  res.json({ riddle: r, progress: { solved, total }, wrongRecent: wrong });
}));

app.post('/api/riddle/submit', requirePlayer, submitLimiter, checkCsrf,
  body('answer').isString().trim().isLength({ min: 1, max: 100 }).withMessage('Answer must be 1-100 characters.'),
  checkValidation, ah(async (req, res) => {
    const r = await currentRiddleFor(req.playerId);
    if (!r) return res.json({ completed: true });

    const recent = num((await get('SELECT COUNT(*) AS c FROM attempts WHERE player_id=? AND riddle_id=? AND created_at > ?',
      req.playerId, r.id, Date.now() - 10 * 60 * 1000)).c);
    if (recent >= 10) {
      audit('player:' + req.playerId, 'submit_rate_abuse', 'riddle:' + r.level, req.ip);
      return res.status(429).json({ error: 'Too many attempts on this riddle. Wait 10 minutes.' });
    }
    const last = await get('SELECT created_at FROM attempts WHERE player_id=? AND riddle_id=? ORDER BY id DESC LIMIT 1', req.playerId, r.id);
    if (last && Date.now() - Number(last.created_at) < 3000) {
      return res.status(429).json({ error: 'Slow down — wait a few seconds between attempts.' });
    }

    const full = await get('SELECT answer_hash, answer_salt FROM riddles WHERE id=?', r.id);
    const ok = verifyAnswer(req.body.answer, full.answer_salt, full.answer_hash);

    await run('INSERT INTO attempts (player_id, riddle_id, correct, ip_hash, user_agent, created_at) VALUES (?,?,?,?,?,?)',
      [req.playerId, r.id, ok ? 1 : 0, hashIp(req.ip), esc(req.get('user-agent')).slice(0, 200), Date.now()]);

    if (!ok) {
      audit('player:' + req.playerId, 'riddle_fail', 'riddle:' + r.level, req.ip);
      return res.json({ correct: false, attemptsLeft: Math.max(0, 10 - recent - 1) });
    }

    const wrongTotal = num((await get('SELECT COUNT(*) AS c FROM attempts WHERE player_id=? AND riddle_id=? AND correct=0', req.playerId, r.id)).c);
    const bonus = Math.max(0, num(r.time_bonus_max) - wrongTotal * 50);
    const points = num(r.points) + bonus;

    const servedAt = (req.session.riddleTimers || {})[r.id] || 0;
    if (servedAt && Date.now() - servedAt < 5000) {
      audit('player:' + req.playerId, 'fast_solve_flag', `riddle:${r.level} in ${Date.now() - servedAt}ms`, req.ip);
    }
    if (req.session.riddleTimers) delete req.session.riddleTimers[r.id];

    try {
      await run('INSERT INTO solves (player_id, riddle_id, points_awarded, solve_time_ms, solved_at) VALUES (?,?,?,?,?)',
        [req.playerId, r.id, points, servedAt ? Date.now() - servedAt : 0, Date.now()]);
    } catch (e) {
      if (!/unique|duplicate|conflict/i.test(e.message)) throw e; // already solved (race) — safe to ignore
      return res.json({ correct: true, points: 0, totalScore: num((await get('SELECT score FROM players WHERE id=?', req.playerId)).score), completed: false });
    }
    await run('UPDATE players SET score=score+?, riddles_solved=riddles_solved+1 WHERE id=?', [points, req.playerId]);
    audit('player:' + req.playerId, 'riddle_solve', `riddle:${r.level} +${points}`, req.ip);
    lbCache.at = 0;

    const p = await get('SELECT score, riddles_solved FROM players WHERE id=?', req.playerId);
    const total = num((await get('SELECT COUNT(*) AS c FROM riddles WHERE is_active=1')).c);
    res.json({ correct: true, points, totalScore: num(p.score), completed: num(p.riddles_solved) >= total });
  }));

// ============================================================ ADMIN AUTH
const PW_POLICY = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z0-9]).{12,}$/;

app.post('/api/admin/login', adminIpGate, adminLoginLimiter, checkCsrf,
  body('username').isString().trim().isLength({ min: 2, max: 32 }).withMessage('Invalid credentials.'),
  body('password').isString().isLength({ min: 1, max: 200 }).withMessage('Invalid credentials.'),
  checkValidation, ah(async (req, res) => {
    const { username, password } = req.body;
    const admin = await get('SELECT * FROM admin_users WHERE username=?', username);
    const hash = admin ? admin.password_hash : bcrypt.hashSync('dummy', 10);
    const pwOk = bcrypt.compareSync(password, hash);

    if (admin && admin.locked_until && Number(admin.locked_until) > Date.now()) {
      audit('admin:' + username, 'admin_login_locked', null, req.ip);
      return res.status(423).json({ error: 'Account locked. Try again later.' });
    }
    if (!admin || !pwOk) {
      if (admin) {
        const fails = num(admin.failed_logins) + 1;
        if (fails >= 5) {
          await run('UPDATE admin_users SET failed_logins=?, locked_until=? WHERE id=?', [fails, Date.now() + 15 * 60 * 1000, admin.id]);
          audit('admin:' + username, 'admin_login_fail', `fails:${fails} LOCKED`, req.ip);
          return res.status(423).json({ error: 'Too many failures. Locked for 15 minutes.' });
        }
        await run('UPDATE admin_users SET failed_logins=? WHERE id=?', [fails, admin.id]);
        audit('admin:' + username, 'admin_login_fail', `fails:${fails}`, req.ip);
      }
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    await run('UPDATE admin_users SET failed_logins=0, locked_until=NULL WHERE id=?', admin.id);
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Session error.' });
      req.session.pendingAdmin = admin.id;
      req.session.csrf = crypto.randomBytes(24).toString('hex');
      audit('admin:' + username, 'admin_pw_ok', num(admin.totp_enabled) ? '2fa_required' : '2fa_setup_required', req.ip);
      res.json({ ok: true, need2fa: !!num(admin.totp_enabled), needSetup: !num(admin.totp_enabled), csrf: req.session.csrf });
    });
  }));

const requirePendingAdmin = ah(async (req, res, next) => {
  if (!req.session.pendingAdmin) return res.status(401).json({ error: 'Start with password login first.' });
  const a = await get('SELECT * FROM admin_users WHERE id=?', req.session.pendingAdmin);
  if (!a) return res.status(401).json({ error: 'Session invalid.' });
  req.pendingAdmin = a;
  next();
});

app.post('/api/admin/2fa/setup', adminIpGate, checkCsrf, requirePendingAdmin, ah(async (req, res) => {
  if (num(req.pendingAdmin.totp_enabled)) return res.status(400).json({ error: '2FA already enabled.' });
  const secret = authenticator.generateSecret();
  req.session.totpTemp = secret;
  const otpauth = authenticator.keyuri(req.pendingAdmin.username, 'QuizArena Admin', secret);
  QRCode.toDataURL(otpauth, (err, qr) => {
    if (err) return res.status(500).json({ error: 'QR generation failed.' });
    res.json({ qr, manualKey: secret });
  });
}));
app.post('/api/admin/2fa/enable', adminIpGate, checkCsrf, requirePendingAdmin,
  body('token').isString().trim().matches(/^[0-9]{6}$/).withMessage('Enter the 6-digit code.'),
  checkValidation, ah(async (req, res) => {
    if (num(req.pendingAdmin.totp_enabled) || !req.session.totpTemp) return res.status(400).json({ error: 'No setup in progress.' });
    if (!authenticator.check(req.body.token, req.session.totpTemp)) {
      audit('admin:' + req.pendingAdmin.username, '2fa_enable_fail', null, req.ip);
      return res.status(401).json({ error: 'Wrong code. Try again.' });
    }
    await run('UPDATE admin_users SET totp_secret=?, totp_enabled=1 WHERE id=?', [req.session.totpTemp, req.pendingAdmin.id]);
    delete req.session.totpTemp;
    req.session.adminId = req.pendingAdmin.id;
    req.session.admin2fa = true;
    req.session.adminLoginAt = Date.now();
    delete req.session.pendingAdmin;
    audit('admin:' + req.pendingAdmin.username, '2fa_enabled', null, req.ip);
    const mustChange = !!num((await get('SELECT must_change_password FROM admin_users WHERE id=?', req.session.adminId)).must_change_password);
    res.json({ ok: true, mustChange });
  }));

app.post('/api/admin/2fa/verify', adminIpGate, adminLoginLimiter, checkCsrf, requirePendingAdmin,
  body('token').isString().trim().matches(/^[0-9]{6}$/).withMessage('Enter the 6-digit code.'),
  checkValidation, ah(async (req, res) => {
    if (!num(req.pendingAdmin.totp_enabled)) return res.status(400).json({ error: '2FA not set up. Use setup first.' });
    if (!authenticator.check(req.body.token, req.pendingAdmin.totp_secret)) {
      audit('admin:' + req.pendingAdmin.username, '2fa_verify_fail', null, req.ip);
      return res.status(401).json({ error: 'Wrong code.' });
    }
    req.session.adminId = req.pendingAdmin.id;
    req.session.admin2fa = true;
    req.session.adminLoginAt = Date.now();
    delete req.session.pendingAdmin;
    audit('admin:' + req.pendingAdmin.username, 'admin_login', '2fa_ok', req.ip);
    const mustChange = !!num((await get('SELECT must_change_password FROM admin_users WHERE id=?', req.session.adminId)).must_change_password);
    res.json({ ok: true, mustChange });
  }));

app.post('/api/admin/logout', checkCsrf, (req, res) => {
  const who = req.session.adminId ? 'admin:' + req.session.adminId : 'anon';
  req.session.destroy(() => {});
  audit(who, 'admin_logout', null, req.ip);
  res.json({ ok: true });
});

app.get('/api/admin/me', adminIpGate, ah(async (req, res) => {
  if (!req.session.adminId || !req.session.admin2fa) return res.json({ loggedIn: false });
  const a = await get('SELECT username, must_change_password, totp_enabled FROM admin_users WHERE id=?', req.session.adminId);
  if (!a) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, username: a.username, mustChange: !!num(a.must_change_password), totp: !!num(a.totp_enabled) });
}));

app.post('/api/admin/change-password', adminIpGate, requireAdmin, checkCsrf,
  body('current').isString().isLength({ min: 1, max: 200 }).withMessage('Current password required.'),
  body('next').isString().matches(PW_POLICY).withMessage('Min 12 chars with upper, lower, number & symbol.'),
  checkValidation, ah(async (req, res) => {
    const a = await get('SELECT * FROM admin_users WHERE id=?', req.adminId);
    if (!bcrypt.compareSync(req.body.current, a.password_hash)) {
      audit('admin:' + a.username, 'pw_change_fail', 'bad_current', req.ip);
      return res.status(401).json({ error: 'Current password is wrong.' });
    }
    await run('UPDATE admin_users SET password_hash=?, must_change_password=0 WHERE id=?', [bcrypt.hashSync(req.body.next, 12), req.adminId]);
    audit('admin:' + a.username, 'pw_changed', null, req.ip);
    res.json({ ok: true });
  }));

const requireSetupDone = ah(async (req, res, next) => {
  const a = await get('SELECT must_change_password FROM admin_users WHERE id=?', req.adminId);
  if (a && num(a.must_change_password)) return res.status(403).json({ error: 'Change the default password first.', mustChange: true });
  next();
});

// ============================================================ ADMIN: STATS
app.get('/api/admin/stats', adminIpGate, requireAdmin, requireSetupDone, ah(async (req, res) => {
  const players = num((await get('SELECT COUNT(*) AS c FROM players')).c);
  const banned = num((await get('SELECT COUNT(*) AS c FROM players WHERE is_banned=1')).c);
  const solves = num((await get('SELECT COUNT(*) AS c FROM solves')).c);
  const attempts24 = num((await get('SELECT COUNT(*) AS c FROM attempts WHERE created_at > ?', Date.now() - 24 * 3600 * 1000)).c);
  const topScore = num((await get('SELECT COALESCE(MAX(score),0) AS m FROM players WHERE is_banned=0')).m);
  const riddles = num((await get('SELECT COUNT(*) AS c FROM riddles')).c);
  const suspicious = (await all(`SELECT action, detail, actor, created_at FROM audit_log
    WHERE action IN ('fast_solve_flag','submit_rate_abuse','csrf_blocked','admin_login_fail','2fa_verify_fail','oauth_state_mismatch')
    ORDER BY id DESC LIMIT 20`)).map(s => ({ ...s, created_at: fmtTs(s.created_at) }));
  res.json({ players, banned, solves, attempts24, topScore, riddles, suspicious });
}));

// ============================================================ ADMIN: RIDDLES
app.get('/api/admin/riddles', adminIpGate, requireAdmin, requireSetupDone, ah(async (req, res) => {
  // Counts merged in JS (keeps SQL elementary & identical on SQLite/Postgres).
  const rows = await all('SELECT id, level, title, poem, hint, points, time_bonus_max, is_active FROM riddles ORDER BY level ASC');
  const solveCounts = await all('SELECT riddle_id, COUNT(*) AS c FROM solves GROUP BY riddle_id');
  const attemptCounts = await all('SELECT riddle_id, COUNT(*) AS c FROM attempts GROUP BY riddle_id');
  const sm = Object.fromEntries(solveCounts.map(r => [r.riddle_id, num(r.c)]));
  const am = Object.fromEntries(attemptCounts.map(r => [r.riddle_id, num(r.c)]));
  res.json({ riddles: rows.map(r => ({ ...r, solve_count: sm[r.id] || 0, attempt_count: am[r.id] || 0 })) });
}));

const riddleValidators = [
  body('title').trim().isLength({ min: 3, max: 80 }).withMessage('Title: 3-80 chars.'),
  body('poem').trim().isLength({ min: 10, max: 2000 }).withMessage('Riddle text: 10-2000 chars.'),
  body('hint').optional().trim().isLength({ max: 500 }).withMessage('Hint too long.'),
  body('points').isInt({ min: 100, max: 100000 }).withMessage('Points: 100-100000.'),
  body('level').optional().isInt({ min: 1, max: 1000 }).withMessage('Invalid level.'),
];
app.post('/api/admin/riddles', adminIpGate, requireAdmin, requireSetupDone, checkCsrf,
  [...riddleValidators, body('answer').trim().isLength({ min: 1, max: 100 }).withMessage('Answer required (1-100 chars).')],
  checkValidation, ah(async (req, res) => {
    const { title, poem, hint, points, level } = req.body;
    const lvl = level || (num((await get('SELECT COALESCE(MAX(level),0)+1 AS n FROM riddles')).n));
    if (await get('SELECT 1 AS x FROM riddles WHERE level=?', lvl)) return res.status(409).json({ error: 'Level already exists.' });
    const { salt, hash } = hashAnswer(req.body.answer);
    const id = newId('rid');
    await run('INSERT INTO riddles (id, level, title, poem, hint, answer_hash, answer_salt, points, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, lvl, esc(title).slice(0, 80), esc(poem).slice(0, 2000), esc(hint || '').slice(0, 500), hash, salt, points, Date.now()]);
    audit('admin:' + req.adminId, 'riddle_create', 'level:' + lvl, req.ip);
    res.json({ ok: true, id });
  }));

app.put('/api/admin/riddles/:id', adminIpGate, requireAdmin, requireSetupDone, checkCsrf,
  [param('id').isLength({ min: 5, max: 64 }).withMessage('Bad id.'),
   ...riddleValidators,
   body('answer').optional().trim().isLength({ min: 1, max: 100 }).withMessage('Answer 1-100 chars.'),
   body('is_active').optional().isInt({ min: 0, max: 1 }).withMessage('Bad active flag.')],
  checkValidation, ah(async (req, res) => {
    const cur = await get('SELECT * FROM riddles WHERE id=?', req.params.id);
    if (!cur) return res.status(404).json({ error: 'Not found.' });
    const { title, poem, hint, points, level, is_active } = req.body;
    if (level && level !== num(cur.level) && await get('SELECT 1 AS x FROM riddles WHERE level=?', level))
      return res.status(409).json({ error: 'Level already exists.' });
    let { answer_hash, answer_salt } = cur;
    if (req.body.answer) { const h = hashAnswer(req.body.answer); answer_hash = h.hash; answer_salt = h.salt; }
    await run('UPDATE riddles SET level=?, title=?, poem=?, hint=?, points=?, is_active=?, answer_hash=?, answer_salt=? WHERE id=?',
      [level || cur.level, esc(title).slice(0, 80), esc(poem).slice(0, 2000), esc(hint ?? '').slice(0, 500),
        points, is_active ?? cur.is_active, answer_hash, answer_salt, cur.id]);
    audit('admin:' + req.adminId, 'riddle_update', 'id:' + cur.id, req.ip);
    res.json({ ok: true });
  }));

app.delete('/api/admin/riddles/:id', adminIpGate, requireAdmin, requireSetupDone, checkCsrf,
  param('id').isLength({ min: 5, max: 64 }).withMessage('Bad id.'), checkValidation, ah(async (req, res) => {
    await run('DELETE FROM solves WHERE riddle_id=?', req.params.id);
    await run('DELETE FROM attempts WHERE riddle_id=?', req.params.id);
    const r = await run('DELETE FROM riddles WHERE id=?', req.params.id);
    if (!r.changes) return res.status(404).json({ error: 'Not found.' });
    audit('admin:' + req.adminId, 'riddle_delete', 'id:' + req.params.id, req.ip);
    res.json({ ok: true });
  }));

// ============================================================ ADMIN: PLAYERS
app.get('/api/admin/players', adminIpGate, requireAdmin, requireSetupDone,
  query('q').optional().isString().isLength({ max: 50 }), checkValidation, ah(async (req, res) => {
    const search = (req.query.q || '').trim().replace(/[%_]/g, '');
    const rows = search
      ? await all('SELECT id, discord_id, username, avatar_url, score, riddles_solved, is_banned, created_at, last_seen_at FROM players WHERE username LIKE ? ORDER BY score DESC LIMIT 100', '%' + search + '%')
      : await all('SELECT id, discord_id, username, avatar_url, score, riddles_solved, is_banned, created_at, last_seen_at FROM players ORDER BY score DESC LIMIT 100');
    res.json({ players: rows.map(p => ({ ...p, created_at: p.created_at ? fmtTs(p.created_at) : null, last_seen_at: p.last_seen_at ? fmtTs(p.last_seen_at) : null })) });
  }));

app.post('/api/admin/players/:id/ban', adminIpGate, requireAdmin, requireSetupDone, checkCsrf,
  param('id').isLength({ min: 5, max: 64 }), checkValidation, ah(async (req, res) => {
    await run('UPDATE players SET is_banned=1 WHERE id=?', req.params.id);
    await run('DELETE FROM sessions WHERE sess LIKE ?', '%' + req.params.id + '%');
    audit('admin:' + req.adminId, 'player_ban', 'id:' + req.params.id, req.ip);
    res.json({ ok: true });
  }));
app.post('/api/admin/players/:id/unban', adminIpGate, requireAdmin, requireSetupDone, checkCsrf,
  param('id').isLength({ min: 5, max: 64 }), checkValidation, ah(async (req, res) => {
    await run('UPDATE players SET is_banned=0 WHERE id=?', req.params.id);
    audit('admin:' + req.adminId, 'player_unban', 'id:' + req.params.id, req.ip);
    res.json({ ok: true });
  }));
app.post('/api/admin/players/:id/reset', adminIpGate, requireAdmin, requireSetupDone, checkCsrf,
  param('id').isLength({ min: 5, max: 64 }), checkValidation, ah(async (req, res) => {
    await run('DELETE FROM solves WHERE player_id=?', req.params.id);
    await run('DELETE FROM attempts WHERE player_id=?', req.params.id);
    await run('UPDATE players SET score=0, riddles_solved=0 WHERE id=?', req.params.id);
    lbCache.at = 0;
    audit('admin:' + req.adminId, 'player_reset', 'id:' + req.params.id, req.ip);
    res.json({ ok: true });
  }));

// ============================================================ ADMIN: AUDIT
app.get('/api/admin/audit', adminIpGate, requireAdmin, requireSetupDone,
  query('limit').optional().isInt({ min: 1, max: 200 }).withMessage('Bad limit.'),
  query('offset').optional().isInt({ min: 0 }).withMessage('Bad offset.'),
  checkValidation, ah(async (req, res) => {
    const limit = Number(req.query.limit || 100), offset = Number(req.query.offset || 0);
    const rows = (await all('SELECT id, actor, action, detail, ip_hash, created_at FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?', limit, offset))
      .map(a => ({ ...a, created_at: fmtTs(a.created_at) }));
    const total = num((await get('SELECT COUNT(*) AS c FROM audit_log')).c);
    res.json({ audit: rows, total });
  }));

// ---------- 404 + error handler ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: 'Something went wrong.' });
});

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[quiz-arena] Player site : http://localhost:${PORT}/`);
    console.log(`[quiz-arena] Admin panel: http://localhost:${PORT}/admin`);
    console.log(`[quiz-arena] Discord login: ${discord.discordConfigured() ? 'CONFIGURED' : 'demo mode (set DISCORD_* in .env for real logins)'}`);
  });
}).catch((e) => {
  console.error('[fatal] DB init failed:', e.message);
  process.exit(1);
});
