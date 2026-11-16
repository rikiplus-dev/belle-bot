// כל השאילתות ל-D1 במקום אחד.
import { KINDS, MEMBERS, STAR_KINDS, WALK_STAR, DEFAULTS } from './config.js';
import { startOfDay } from './time.js';

const q = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);

/* ---------- משתמשים והצטרפות ---------- */

export const getUser = (env, tgId) => q(env, 'SELECT * FROM users WHERE tg_id=?', tgId).first();

export async function upsertUser(env, tgId, member, chatId, now) {
  await q(
    env,
    `INSERT INTO users(tg_id, member, chat_id, created_at) VALUES(?,?,?,?)
     ON CONFLICT(tg_id) DO UPDATE SET member=excluded.member, chat_id=COALESCE(excluded.chat_id, users.chat_id)`,
    tgId,
    member,
    chatId,
    now,
  ).run();
}

export const touchChat = (env, tgId, chatId) =>
  q(env, 'UPDATE users SET chat_id=? WHERE tg_id=? AND (chat_id IS NULL OR chat_id<>?)', chatId, tgId, chatId).run();

export const setUserFlag = (env, tgId, field, value) => {
  if (!['notify', 'notify_activity'].includes(field)) throw new Error('bad field');
  return q(env, `UPDATE users SET ${field}=? WHERE tg_id=?`, value ? 1 : 0, tgId).run();
};

export const listUsers = async (env) => (await q(env, 'SELECT * FROM users').all()).results;

export const getPending = (env, tgId) => q(env, 'SELECT * FROM pending WHERE tg_id=?', tgId).first();

export const setPending = (env, tgId, state, attempts, now) =>
  q(
    env,
    `INSERT INTO pending(tg_id,state,attempts,updated_at) VALUES(?,?,?,?)
     ON CONFLICT(tg_id) DO UPDATE SET state=excluded.state, attempts=excluded.attempts, updated_at=excluded.updated_at`,
    tgId,
    state,
    attempts,
    now,
  ).run();

export const clearPending = (env, tgId) => q(env, 'DELETE FROM pending WHERE tg_id=?', tgId).run();

/* ---------- טיולים ---------- */

export const activeWalk = (env) => q(env, 'SELECT * FROM walks WHERE ended_at IS NULL LIMIT 1').first();

export async function startWalk(env, member, now) {
  const open = await activeWalk(env);
  if (open) return { ok: false, walk: open };
  try {
    const r = await q(env, 'INSERT INTO walks(member, started_at) VALUES(?,?)', member, now).run();
    return { ok: true, walk: { id: r.meta.last_row_id, member, started_at: now, ended_at: null } };
  } catch (e) {
    const w = await activeWalk(env);
    if (w) return { ok: false, walk: w };
    throw e;
  }
}

export async function walkCounts(env, walkId) {
  const rows = (await q(env, 'SELECT kind, COUNT(*) n FROM events WHERE walk_id=? GROUP BY kind', walkId).all()).results;
  const c = { pee_out: 0, poop_out: 0 };
  for (const r of rows) c[r.kind] = r.n;
  return c;
}

// מסיים טיול. מחזיר null אם כבר נסגר.
export async function endWalk(env, walkId, now, auto = false) {
  const r = await q(env, 'UPDATE walks SET ended_at=?, auto_closed=? WHERE id=? AND ended_at IS NULL', now, auto ? 1 : 0, walkId).run();
  if (!r.meta.changes) return null;
  const walk = await q(env, 'SELECT * FROM walks WHERE id=?', walkId).first();
  return { walk, counts: await walkCounts(env, walkId) };
}

/* ---------- פעולות ---------- */

export async function logEvent(env, member, kind, now, source = 'bot') {
  const k = KINDS[kind];
  if (!k) return { ok: false, reason: 'bad_kind' };
  let walkId = null;
  if (k.out) {
    const w = await activeWalk(env);
    if (!w) return { ok: false, reason: 'no_walk' };
    walkId = w.id;
  }
  const r = await q(env, 'INSERT INTO events(ts,kind,member,walk_id,source) VALUES(?,?,?,?,?)', now, kind, member, walkId, source).run();
  return { ok: true, event: { id: r.meta.last_row_id, ts: now, kind, member, walk_id: walkId }, stars: k.star };
}

// מבטל את הפעולה האחרונה של בן הבית (עד 15 דקות אחורה)
export async function undoLast(env, member, now) {
  const limit = now - 15 * 60000;
  const ev = await q(env, 'SELECT * FROM events WHERE member=? AND ts>=? ORDER BY ts DESC, id DESC LIMIT 1', member, limit).first();
  const wk = await q(
    env,
    'SELECT * FROM walks WHERE member=? AND ended_at IS NULL AND started_at>=? ORDER BY started_at DESC LIMIT 1',
    member,
    limit,
  ).first();
  if (wk && (!ev || wk.started_at > ev.ts)) {
    await q(env, 'DELETE FROM walks WHERE id=?', wk.id).run();
    return { type: 'walk', walk: wk };
  }
  if (ev) {
    await q(env, 'DELETE FROM events WHERE id=?', ev.id).run();
    return { type: 'event', event: ev };
  }
  return null;
}

export async function deleteEvent(env, id, member) {
  const r = await q(env, 'DELETE FROM events WHERE id=? AND member=?', id, member).run();
  return r.meta.changes > 0;
}

export async function deleteWalk(env, id, member) {
  const w = await q(env, 'SELECT id FROM walks WHERE id=? AND member=?', id, member).first();
  if (!w) return false;
  await env.DB.batch([q(env, 'DELETE FROM events WHERE walk_id=?', id), q(env, 'DELETE FROM walks WHERE id=?', id)]);
  return true;
}

export const eventsSince = async (env, since, limit = 800) =>
  (await q(env, 'SELECT * FROM events WHERE ts>=? ORDER BY ts DESC, id DESC LIMIT ?', since, limit).all()).results;

export const walksSince = async (env, since, limit = 300) =>
  (await q(env, 'SELECT * FROM walks WHERE started_at>=? ORDER BY started_at DESC LIMIT ?', since, limit).all()).results;

export const lastHome = (env) =>
  q(env, "SELECT * FROM events WHERE kind IN ('pee_home','poop_home') ORDER BY ts DESC LIMIT 1").first();

/* ---------- כוכבים וסיכומים ---------- */

// מחזיר { memberId: { total, walks, out, cook } } לטווח זמן
export async function stars(env, since, until = 9e15) {
  const out = Object.fromEntries(MEMBERS.map((m) => [m.id, { total: 0, walks: 0, out: 0, cook: 0 }]));
  const marks = STAR_KINDS.map(() => '?').join(',');
  const ev = (
    await q(env, `SELECT member, kind, COUNT(*) n FROM events WHERE ts>=? AND ts<? AND kind IN (${marks}) GROUP BY member, kind`, since, until, ...STAR_KINDS).all()
  ).results;
  for (const r of ev) {
    const o = out[r.member];
    if (!o) continue;
    const pts = r.n * KINDS[r.kind].star;
    o.total += pts;
    if (KINDS[r.kind].out) o.out += r.n;
    else if (r.kind === 'cook') o.cook += r.n;
  }
  const wk = (
    await q(env, 'SELECT member, COUNT(*) n FROM walks WHERE ended_at IS NOT NULL AND started_at>=? AND started_at<? GROUP BY member', since, until).all()
  ).results;
  for (const r of wk) {
    const o = out[r.member];
    if (!o) continue;
    o.walks += r.n;
    o.total += r.n * WALK_STAR;
  }
  return out;
}

// ספירה של היום לפי סוג
export async function todaySummary(env, now, tz) {
  const since = startOfDay(now, tz);
  const rows = (await q(env, 'SELECT kind, COUNT(*) n FROM events WHERE ts>=? GROUP BY kind', since).all()).results;
  const c = Object.fromEntries(Object.keys(KINDS).map((k) => [k, 0]));
  for (const r of rows) c[r.kind] = r.n;
  const w = await q(env, 'SELECT COUNT(*) n FROM walks WHERE started_at>=?', since).first();
  return {
    out: c.pee_out + c.poop_out,
    home: c.pee_home + c.poop_home,
    pee_out: c.pee_out,
    poop_out: c.poop_out,
    pee_home: c.pee_home,
    poop_home: c.poop_home,
    meal: c.meal,
    cook: c.cook,
    walks: w ? w.n : 0,
  };
}

/* ---------- הגדרות ותזכורות ---------- */

export async function getSetting(env, key, fallback) {
  const r = await q(env, 'SELECT value FROM settings WHERE key=?', key).first();
  return r ? Number(r.value) : fallback;
}

export const setSetting = (env, key, value) =>
  q(env, 'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value)).run();

export async function thresholds(env) {
  return {
    mealNudgeMin: await getSetting(env, 'meal_nudge_min', DEFAULTS.mealNudgeMin),
    intervalMin: await getSetting(env, 'interval_min', DEFAULTS.intervalMin),
  };
}

export const reminderSent = async (env, key) => !!(await q(env, 'SELECT 1 x FROM reminders WHERE key=?', key).first());

export const markReminder = (env, key, now) =>
  q(env, 'INSERT OR IGNORE INTO reminders(key,sent_at) VALUES(?,?)', key, now).run();

export const pruneReminders = (env, before) => q(env, 'DELETE FROM reminders WHERE sent_at<?', before).run();

export const maxOutPee = async (env) => (await q(env, "SELECT MAX(ts) t FROM events WHERE kind='pee_out'").first())?.t || 0;
export const maxWalkStart = async (env) => (await q(env, 'SELECT MAX(started_at) t FROM walks').first())?.t || 0;
export const lastMeal = (env, from, to) =>
  q(env, "SELECT * FROM events WHERE kind='meal' AND ts>=? AND ts<=? ORDER BY ts DESC LIMIT 1", from, to).first();
export const walkStartedSince = async (env, ts) => !!(await q(env, 'SELECT 1 x FROM walks WHERE started_at>=? LIMIT 1', ts).first());
export const staleWalk = (env, before) => q(env, 'SELECT * FROM walks WHERE ended_at IS NULL AND started_at<? LIMIT 1', before).first();
export const lastWalkEventTs = async (env, walkId) =>
  (await q(env, 'SELECT MAX(ts) t FROM events WHERE walk_id=?', walkId).first())?.t || 0;
