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

// טיול שהסתיים כבר (עדכון אחורה), עם פיפי וקקי שמפוזרים בתוכו
export async function insertPastWalk(env, member, start, end, pee, poop) {
  const w = await q(env, 'INSERT INTO walks(member, started_at, ended_at, auto_closed) VALUES(?,?,?,0)', member, start, end).run();
  const id = w.meta.last_row_id;
  const kinds = [...Array(pee).fill('pee_out'), ...Array(poop).fill('poop_out')];
  const n = kinds.length;
  if (n) {
    await env.DB.batch(
      kinds.map((k, i) =>
        q(env, 'INSERT INTO events(ts,kind,member,walk_id,source) VALUES(?,?,?,?,?)', Math.round(start + ((end - start) * (i + 1)) / (n + 1)), k, member, id, 'late'),
      ),
    );
  }
  return { id, member, started_at: start, ended_at: end, pee_out: pee, poop_out: poop };
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

// מה יבוטל בלחיצה על ביטול (בלי לבטל בפועל)
export async function peekUndo(env, member, now) {
  const limit = now - 15 * 60000;
  const ev = await q(env, 'SELECT * FROM events WHERE member=? AND ts>=? ORDER BY ts DESC, id DESC LIMIT 1', member, limit).first();
  const wk = await q(env, 'SELECT * FROM walks WHERE member=? AND ended_at IS NULL AND started_at>=? ORDER BY started_at DESC LIMIT 1', member, limit).first();
  if (wk && (!ev || wk.started_at > ev.ts)) return { type: 'walk', ts: wk.started_at };
  if (ev) return { type: 'event', kind: ev.kind, ts: ev.ts };
  return null;
}

export const setPanelMsg = (env, tgId, msgId) => q(env, 'UPDATE users SET panel_msg=? WHERE tg_id=?', msgId, tgId).run();
export const saveWalkMsg = (env, walkId, chatId, msgId) =>
  q(env, 'INSERT OR REPLACE INTO walk_msgs(walk_id,chat_id,message_id) VALUES(?,?,?)', walkId, chatId, msgId).run();
export const walkMsgs = async (env, walkId) => (await q(env, 'SELECT * FROM walk_msgs WHERE walk_id=?', walkId).all()).results;
export const maxWalkId = async (env) => (await q(env, 'SELECT MAX(id) m FROM walks').first())?.m || 0;
export const pruneWalkMsgs = (env, minWalkId) => q(env, 'DELETE FROM walk_msgs WHERE walk_id<?', minWalkId).run();

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
    mealNudgeMin: await getSetting(env, 'meal_nudge_min', 0), // 0 = אוטומטי
    intervalMin: await getSetting(env, 'interval_min', 0),
  };
}

export const reminderSent = async (env, key) => !!(await q(env, 'SELECT 1 x FROM reminders WHERE key=?', key).first());

export const markReminder = (env, key, now) =>
  q(env, 'INSERT OR IGNORE INTO reminders(key,sent_at) VALUES(?,?)', key, now).run();

// תופס תזכורת באופן אטומי: true רק למי שהצליח לתפוס, כך שהרצות חופפות לא שולחות פעמיים
export const claimReminder = async (env, key, now) =>
  (await q(env, 'INSERT OR IGNORE INTO reminders(key,sent_at) VALUES(?,?)', key, now).run()).meta.changes === 1;
export const unclaimReminder = (env, key) => q(env, 'DELETE FROM reminders WHERE key=?', key).run();

// עדכון טלגרם: true אם זו הפעם הראשונה שרואים אותו
export const claimUpdate = async (env, updateId, now) =>
  (await q(env, 'INSERT OR IGNORE INTO processed_updates(update_id,ts) VALUES(?,?)', updateId, now).run()).meta.changes === 1;
export const pruneUpdates = (env, before) => q(env, 'DELETE FROM processed_updates WHERE ts<?', before).run();

// צ'אט שנחסם או נמחק: מפסיקים לשלוח אליו
export const dropChat = (env, chatId) => q(env, 'UPDATE users SET chat_id=NULL WHERE chat_id=?', chatId).run();

export const pruneReminders = (env, before) => q(env, 'DELETE FROM reminders WHERE sent_at<?', before).run();

export const maxOutPee = async (env) => (await q(env, "SELECT MAX(ts) t FROM events WHERE kind='pee_out'").first())?.t || 0;
export const maxWalkStart = async (env) => (await q(env, 'SELECT MAX(started_at) t FROM walks').first())?.t || 0;
export const lastMeal = (env, from, to) =>
  q(env, "SELECT * FROM events WHERE kind='meal' AND ts>=? AND ts<=? ORDER BY ts DESC LIMIT 1", from, to).first();
export const walkStartedSince = async (env, ts) => !!(await q(env, 'SELECT 1 x FROM walks WHERE started_at>=? LIMIT 1', ts).first());
export const staleWalk = (env, before) => q(env, 'SELECT * FROM walks WHERE ended_at IS NULL AND started_at<? LIMIT 1', before).first();
export const lastWalkEventTs = async (env, walkId) =>
  (await q(env, 'SELECT MAX(ts) t FROM events WHERE walk_id=?', walkId).first())?.t || 0;

/* ---------- בריאות ---------- */

export async function addHealth(env, h, now) {
  const r = await q(
    env,
    'INSERT INTO health_log(kind,title,at,notes,next_due,member,created_at,done) VALUES(?,?,?,?,?,?,?,?)',
    h.kind,
    h.title,
    h.at,
    h.notes || null,
    h.due ?? null,
    h.member,
    now,
    h.done === 0 ? 0 : 1,
  ).run();
  return r.meta.last_row_id;
}

export const recentHealth = async (env, limit = 12) =>
  (await q(env, 'SELECT * FROM health_log WHERE done=1 ORDER BY at DESC, id DESC LIMIT ?', limit).all()).results;

export const getHealth = (env, id) => q(env, 'SELECT * FROM health_log WHERE id=?', id).first();
export const setHealthDue = (env, id, due) => q(env, 'UPDATE health_log SET next_due=? WHERE id=?', due, id).run();
// תזכורת עתידית שבוצעה: הופכת לאירוע שהיה, בלי מועד חזרה (בוחרים אותו אחר כך)
export const markHealthDone = (env, id, at) => q(env, 'UPDATE health_log SET done=1, at=?, next_due=NULL WHERE id=?', at, id).run();
export const deleteHealth = (env, id) => q(env, 'DELETE FROM health_log WHERE id=?', id).run();

// מוחק את הרשומה האחרונה שבן הבית הזה הוסיף (עד שבוע אחורה)
export async function deleteLastHealth(env, member, now) {
  const row = await q(env, 'SELECT * FROM health_log WHERE member=? AND created_at>=? ORDER BY id DESC LIMIT 1', member, now - 7 * 86400000).first();
  if (!row) return null;
  await q(env, 'DELETE FROM health_log WHERE id=?', row.id).run();
  return row;
}

// מועדי חזרה שעוד לא טופלו (אין רשומה חדשה יותר עם אותו תיאור)
export const dueHealth = async (env, until) =>
  (
    await q(
      env,
      `SELECT * FROM health_log h WHERE next_due IS NOT NULL AND next_due<=?
       AND NOT EXISTS (SELECT 1 FROM health_log x WHERE x.title=h.title AND x.at>h.at)
       ORDER BY next_due`,
      until,
    ).all()
  ).results;

export async function addMed(env, m, now) {
  const r = await q(
    env,
    'INSERT INTO meds(name,dose,times,start_at,end_at,active,member,created_at) VALUES(?,?,?,?,?,1,?,?)',
    m.name,
    m.dose,
    m.times.join(','),
    now,
    m.end ?? null,
    m.member,
    now,
  ).run();
  return r.meta.last_row_id;
}

export const activeMeds = async (env, now) =>
  (await q(env, 'SELECT * FROM meds WHERE active=1 AND (end_at IS NULL OR end_at>?) ORDER BY id', now).all()).results;

export const stopMed = async (env, id) => (await q(env, 'UPDATE meds SET active=0 WHERE id=? AND active=1', id).run()).meta.changes > 0;
export const getMed = (env, id) => q(env, 'SELECT * FROM meds WHERE id=?', id).first();

export const dosesFor = async (env, medId) => (await q(env, 'SELECT * FROM med_doses WHERE med_id=?', medId).all()).results;
export const getDose = (env, medId, slot) => q(env, 'SELECT * FROM med_doses WHERE med_id=? AND slot=?', medId, slot).first();
export async function recordDose(env, medId, slot, status, member, now) {
  const r = await q(env, 'INSERT OR IGNORE INTO med_doses(med_id,slot,status,at,member) VALUES(?,?,?,?,?)', medId, slot, status, now, member).run();
  return r.meta.changes > 0;
}

/* ---------- שעות אחריות ---------- */

export const listDuty = async (env) => (await q(env, 'SELECT * FROM duty ORDER BY member, start_min').all()).results;
export async function addDuty(env, d) {
  const r = await q(env, 'INSERT INTO duty(member,days,start_min,end_min) VALUES(?,?,?,?)', d.member, d.days.join(','), d.start, d.end).run();
  return r.meta.last_row_id;
}
export const deleteDuty = async (env, id) => (await q(env, 'DELETE FROM duty WHERE id=?', id).run()).meta.changes > 0;

/* ---------- תעודת בל: פרטים, משקל והתקדמות ---------- */

export const getProfile = async (env) => {
  const rows = (await q(env, "SELECT key, value FROM settings WHERE key LIKE 'dog:%'").all()).results;
  return Object.fromEntries(rows.map((r) => [r.key.slice(4), r.value]));
};
export const setProfileField = (env, field, value) =>
  value === null || value === ''
    ? q(env, 'DELETE FROM settings WHERE key=?', `dog:${field}`).run()
    : q(env, 'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', `dog:${field}`, String(value)).run();

export const addWeight = async (env, ts, grams, member) =>
  (await q(env, 'INSERT INTO weights(ts,grams,member) VALUES(?,?,?)', ts, grams, member).run()).meta.last_row_id;
export const recentWeights = async (env, limit = 10) =>
  (await q(env, 'SELECT * FROM weights ORDER BY ts DESC, id DESC LIMIT ?', limit).all()).results;
export const deleteLastWeight = async (env) => {
  const r = await q(env, 'SELECT id FROM weights ORDER BY id DESC LIMIT 1').first();
  if (r) await q(env, 'DELETE FROM weights WHERE id=?', r.id).run();
  return !!r;
};

export const progressAll = async (env, kind) =>
  Object.fromEntries((await q(env, 'SELECT * FROM progress WHERE kind=?', kind).all()).results.map((r) => [r.item, r]));
export const setProgress = (env, kind, item, level, at, member) =>
  q(
    env,
    `INSERT INTO progress(kind,item,level,at,member) VALUES(?,?,?,?,?)
     ON CONFLICT(kind,item) DO UPDATE SET level=excluded.level, at=excluded.at, member=excluded.member`,
    kind,
    item,
    level,
    at,
    member,
  ).run();

export const healthByTitle = (env, title) => q(env, 'SELECT * FROM health_log WHERE title=? LIMIT 1', title).first();
export const allHealthDone = async (env) => (await q(env, 'SELECT * FROM health_log WHERE done=1 ORDER BY at ASC, id ASC').all()).results;
export const eventsBetween = async (env, from, to) =>
  (await q(env, 'SELECT * FROM events WHERE ts>=? AND ts<? ORDER BY ts ASC', from, to).all()).results;
