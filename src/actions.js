// הפעולות עצמן. הבוט ולוח הבקרה משתמשים באותן פונקציות.
import * as db from './db.js';
import { KINDS, MEMBER_BY_ID, WALK_STAR } from './config.js';
import { dur } from './time.js';

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
