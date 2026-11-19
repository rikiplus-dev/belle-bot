// הפעולות עצמן. הבוט ולוח הבקרה משתמשים באותן פונקציות.
import * as db from './db.js';
import { KINDS, MEMBER_BY_ID, WALK_STAR, LATE_KINDS, MAX_LATE_MIN } from './config.js';
import { dur, hhmm } from './time.js';

const name = (id) => (MEMBER_BY_ID[id] ? MEMBER_BY_ID[id].name : 'מישהו/י');

export async function walkStart(env, member, now) {
  const r = await db.startWalk(env, member, now);
  if (!r.ok) {
    return { ok: false, reason: 'walk_active', walk: r.walk, toast: `כבר יש טיול פעיל (${name(r.walk.member)})` };
  }
  return { ok: true, walk: r.walk, toast: '🚶 הטיול התחיל', notice: `🚶 טיול התחיל · ${name(member)}` };
}

export async function walkEnd(env, member, now) {
  const w = await db.activeWalk(env);
  if (!w) return { ok: false, reason: 'no_walk', toast: 'אין טיול פעיל' };
  const r = await db.endWalk(env, w.id, now);
  if (!r) return { ok: false, reason: 'no_walk', toast: 'אין טיול פעיל' };
  const c = r.counts;
  const bits = [];
  if (c.pee_out) bits.push(`💧${c.pee_out}`);
  if (c.poop_out) bits.push(`💩${c.poop_out}`);
  const summary = bits.length ? bits.join(' ') : 'בלי פיפי וקקי הפעם';
  const took = dur(now - w.started_at);
  return {
    ok: true,
    walk: r.walk,
    counts: c,
    toast: `🏁 חזרנו · ${took} · ⭐ +${WALK_STAR} ל${name(w.member)}`,
    notice: `🏁 הטיול הסתיים · ${took} · ${summary} · ⭐ +${WALK_STAR} ל${name(w.member)}`,
    walker: w.member,
    summary,
    took,
  };
}

export async function log(env, member, kind, now, source = 'bot') {
  const k = KINDS[kind];
  if (!k) return { ok: false, reason: 'bad_kind', toast: 'פעולה לא מוכרת' };
  const r = await db.logEvent(env, member, kind, now, source);
  if (!r.ok) {
    if (r.reason === 'no_walk') {
      return { ok: false, reason: 'no_walk', toast: 'אין טיול פעיל. קודם לוחצים על "יוצאים לטיול"' };
    }
    return { ok: false, reason: r.reason, toast: 'לא הצלחנו לתעד' };
  }
  const star = k.star ? ` · ⭐ +${k.star}` : '';
  return {
    ok: true,
    event: r.event,
    toast: `${k.emoji} ${k.label}${star}`,
    notice: `${name(member)}: ${k.emoji} ${k.label}${k.star ? ' ⭐' : ''}`,
  };
}

export async function undo(env, member, now) {
  const r = await db.undoLast(env, member, now);
  if (!r) return { ok: false, toast: 'אין מה לבטל (אפשר לבטל עד 15 דקות אחורה)' };
  if (r.type === 'walk') return { ok: true, toast: '↩️ הטיול בוטל', notice: `${name(member)}: ↩️ הטיול בוטל` };
  const k = KINDS[r.event.kind];
  return { ok: true, toast: `↩️ בוטל: ${k.label}`, notice: `${name(member)}: ↩️ בוטל ${k.label}` };
}

/* ---------- עדכון אחורה ---------- */

const validMin = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_LATE_MIN;
const tzOf = (env) => env.TZ || 'Asia/Jerusalem';
const clampN = (n) => Math.max(0, Math.min(5, Number.isInteger(n) ? n : 0));

// פיפי/קקי בבית, אוכל או הכנת אוכל שנשכחו. minAgo = לפני כמה דקות.
// who = מי עשה (ברירת מחדל: מי שמעדכן)
export async function logLate(env, who, kind, minAgo, now) {
  if (!LATE_KINDS.includes(kind)) return { ok: false, toast: 'את זה אי אפשר לעדכן אחורה' };
  if (!MEMBER_BY_ID[who]) return { ok: false, toast: 'לא מכירים את בן הבית' };
  if (!validMin(minAgo)) return { ok: false, toast: 'אפשר לעדכן עד יממה אחורה' };
  const ts = now - minAgo * 60000;
  const r = await db.logEvent(env, who, kind, ts, 'late');
  if (!r.ok) return { ok: false, toast: 'לא הצלחנו לתעד' };
  const k = KINDS[kind];
  const when = `${hhmm(ts, tzOf(env))} (לפני ${dur(minAgo * 60000)})`;
  const star = k.star ? ` · ⭐ +${k.star}` : '';
  return {
    ok: true,
    event: r.event,
    toast: `${k.emoji} ${k.label} · ${when}${star}`,
    notice: `${name(who)}: ${k.emoji} ${k.label} · ${when}${k.star ? ' ⭐' : ''}`,
  };
}

// טיול שהיה ונשכח: התחיל לפני minAgo דקות, ארך durMin דקות
export async function walkLate(env, who, minAgo, durMin, pee, poop, now) {
  if (!MEMBER_BY_ID[who]) return { ok: false, toast: 'לא מכירים את בן הבית' };
  if (!validMin(minAgo)) return { ok: false, toast: 'אפשר לעדכן עד יממה אחורה' };
  if (!Number.isInteger(durMin) || durMin < 5 || durMin > 240) return { ok: false, toast: 'משך הטיול לא תקין' };
  const start = now - minAgo * 60000;
  const end = Math.min(start + durMin * 60000, now);
  pee = clampN(pee);
  poop = clampN(poop);
  const w = await db.insertPastWalk(env, who, start, end, pee, poop);
  const bits = [pee ? `💧${pee}` : '', poop ? `💩${poop}` : ''].filter(Boolean).join(' ') || 'בלי פיפי וקקי';
  const when = `${hhmm(start, tzOf(env))} · ${dur(end - start)}`;
  return {
    ok: true,
    walk: w,
    toast: `🚶 טיול נוסף · ${when} · ⭐ +${WALK_STAR}`,
    notice: `${name(who)}: 🚶 טיול שהיה · ${when} · ${bits} · ⭐ +${WALK_STAR}`,
  };
}

/* ---------- עריכת פעולה שכבר נרשמה ---------- */

const EDIT_WINDOW = 7 * 86400000;
const shiftOf = (n) => (Number.isFinite(Number(n)) ? Math.max(-1440, Math.min(1440, Math.round(Number(n)))) : 0);
// אפשר להחליף סוג רק בתוך אותה קבוצה: בחוץ / בבית / אוכל, כדי לא לשבור את הקישור לטיול
const kindClass = (k) => (KINDS[k]?.out ? 'out' : KINDS[k]?.accident ? 'home' : 'care');

// canEdit: הפונקציה שמחליטה אם מותר לערוך את השורה (בעלים או מנהל)
export async function editEvent(env, id, { shiftMin = 0, kind = null }, now, canEdit) {
  const e = await db.getEvent(env, id);
  if (!e || !canEdit(e)) return { ok: false, toast: 'אפשר לערוך רק פעולות שלך' };
  const newKind = kind || e.kind;
  if (!KINDS[newKind] || kindClass(newKind) !== kindClass(e.kind)) return { ok: false, toast: 'אי אפשר להחליף לסוג כזה' };
  const ts = e.ts + shiftOf(shiftMin) * 60000;
  if (ts > now + 60000 || ts < now - EDIT_WINDOW) return { ok: false, toast: 'השעה לא הגיונית (לא בעתיד, ולא יותר משבוע אחורה)' };
  await db.updateEvent(env, id, Math.min(ts, now), newKind);
  return { ok: true, toast: '✏️ עודכן' };
}

export async function editWalk(env, id, { shiftStart = 0, shiftEnd = 0 }, now, canEdit) {
  const w = await db.getWalk(env, id);
  if (!w || !canEdit(w)) return { ok: false, toast: 'אפשר לערוך רק פעולות שלך' };
  const s = w.started_at + shiftOf(shiftStart) * 60000;
  const e = w.ended_at ? w.ended_at + shiftOf(shiftEnd) * 60000 : null;
  if (s > now + 60000 || s < now - EDIT_WINDOW || (e !== null && (e <= s || e > now + 60000))) {
    return { ok: false, toast: 'השעות לא הגיוניות (הסיום חייב להיות אחרי ההתחלה, ולא בעתיד)' };
  }
  await db.updateWalk(env, id, Math.min(s, now), e === null ? null : Math.min(e, now));
  return { ok: true, toast: '✏️ עודכן' };
}
