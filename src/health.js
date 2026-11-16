// מעקב בריאות: תרופות עם שעות, יומן רפואי ומועדי חזרה. רק מי שברשימת ADMINS רואה ומעדכן.
import * as db from './db.js';
import { DOG, MEMBER_BY_ID, HEALTH_KINDS, isAdmin } from './config.js';
import { esc, tgSafe } from './telegram.js';
import { parts, startOfDay, hhmm } from './time.js';
import { parseMedLine, parseHealthLine } from './parse.js';

const DAY = 86400000;
const tzOf = (env) => env.TZ || 'Asia/Jerusalem';
const name = (id) => (MEMBER_BY_ID[id] ? MEMBER_BY_ID[id].name : 'מישהו/י');
const btn = (text, data) => ({ text, callback_data: data });
const pad = (n) => String(n).padStart(2, '0');

export const fmtDate = (ts, tz) => {
  const p = parts(ts, tz);
  return `${p.d}.${p.m}.${String(p.y).slice(2)}`;
};
const daysBetween = (a, b, tz) => Math.round((startOfDay(b + 12 * 3600000, tz) - startOfDay(a + 12 * 3600000, tz)) / DAY);

/* ---------- חלונות מתן תרופה ---------- */

export const dayCode = (ts, tz) => {
  const p = parts(ts, tz);
  return `${p.y}${pad(p.m)}${pad(p.d)}`;
};

// timestamp של שעה מסוימת ביום שמתחיל ב-dayStart
export function slotTs(dayStart, time, tz) {
  const [h, m] = time.split(':').map(Number);
  let t = dayStart + (h * 60 + m) * 60000;
  const p = parts(t, tz);
  t += ((h * 60 + m) - (p.h * 60 + p.mi)) * 60000; // תיקון ליום עם שינוי שעון
  return t;
}

// כל החלונות של היום (ושל אתמול, לחצות) לתרופה אחת
export function medSlots(med, now, tz) {
  const days = [startOfDay(now - DAY + 12 * 3600000, tz), startOfDay(now, tz)];
  const out = [];
  for (const d of days) {
    for (const time of med.times.split(',')) {
      const ts = slotTs(d, time, tz);
      if (ts < med.start_at) continue;
      if (med.end_at && ts >= med.end_at) continue;
      out.push({ med, time, ts, day: dayCode(d, tz), slot: `${dayCode(d, tz)} ${time.replace(':', '')}` });
    }
  }
  return out;
}

/* ---------- פעולות ---------- */

export async function addMedFromText(env, member, text, now) {
  const r = parseMedLine(text, now, tzOf(env));
  if (r.error) return { ok: false, error: r.error };
  const id = await db.addMed(env, { ...r, member }, now);
  return { ok: true, id, med: r };
}

export async function addHealthFromText(env, member, kind, text, now) {
  if (!HEALTH_KINDS[kind]) return { ok: false, error: 'סוג לא מוכר' };
  const r = parseHealthLine(text, now, tzOf(env));
  if (r.error) return { ok: false, error: r.error };
  const id = await db.addHealth(env, { kind, title: r.title, at: r.at, notes: r.notes, due: r.due, member }, now);
  return { ok: true, id, entry: { kind, ...r } };
}

export async function giveDose(env, medId, day, time, status, member, now) {
  const med = await db.getMed(env, medId);
  if (!med) return { ok: false, text: 'התרופה לא נמצאה' };
  const slot = `${day} ${time}`;
  const done = await db.recordDose(env, medId, slot, status, member, now);
  if (!done) {
    const d = await db.getDose(env, medId, slot);
    return { ok: false, text: `כבר עודכן על ידי ${name(d.member)}`, med };
  }
  return { ok: true, med, text: status === 'given' ? '✅ נרשם שניתנה' : '⏭ נרשם שדילגנו', time: `${time.slice(0, 2)}:${time.slice(2)}` };
}

/* ---------- תצוגות ---------- */

const back = (to = 'h:home') => [btn('⬅️ חזרה', to)];

async function todayDoseLines(env, now, tz) {
  const meds = await db.activeMeds(env, now);
  const lines = [];
  for (const med of meds) {
    const doses = new Map((await db.dosesFor(env, med.id)).map((d) => [d.slot, d]));
    const today = dayCode(now, tz);
    const marks = medSlots(med, now, tz)
      .filter((s) => s.day === today)
      .map((s) => {
        const d = doses.get(s.slot);
        const mark = d ? (d.status === 'given' ? '✅' : '⏭') : s.ts <= now ? '❗' : '⏳';
        return `${s.time} ${mark}`;
      });
    lines.push({ med, text: `💊 <b>${esc(med.name)}</b> · ${esc(med.dose)}${marks.length ? '\n     ' + marks.join('  ') : ''}` });
  }
  return lines;
}

export async function healthHome(env, now, notice = '') {
  const tz = tzOf(env);
  const [doseLines, due, recent] = await Promise.all([todayDoseLines(env, now, tz), db.dueHealth(env, now + 60 * DAY), db.recentHealth(env, 1)]);
  const lines = [`🩺 <b>בריאות · ${esc(DOG)}</b>`];
  if (notice) lines.push(`<i>${esc(notice)}</i>`);
  lines.push('');
  lines.push('<b>תרופות היום</b>');
  if (doseLines.length) doseLines.forEach((l) => lines.push(l.text));
  else lines.push('אין תרופות פעילות.');
  lines.push('');
  lines.push('<b>מועדים קרובים</b>');
  if (due.length) {
    for (const h of due.slice(0, 6)) {
      const k = HEALTH_KINDS[h.kind] || HEALTH_KINDS.other;
      const n = daysBetween(now, h.next_due, tz);
      const when = n < 0 ? `⚠️ עבר לפני ${-n} ימים` : n === 0 ? 'היום' : n === 1 ? 'מחר' : `בעוד ${n} ימים`;
      lines.push(`${k.emoji} ${esc(h.title)} · ${fmtDate(h.next_due, tz)} · ${when}`);
    }
  } else lines.push('אין מועדים בחודשיים הקרובים.');
  if (recent[0]) {
    const h = recent[0];
    lines.push('');
    lines.push(`<i>אחרון ביומן: ${(HEALTH_KINDS[h.kind] || HEALTH_KINDS.other).emoji} ${esc(h.title)} · ${fmtDate(h.at, tz)}</i>`);
  }
  return {
    text: lines.join('\n'),
    reply_markup: {
      inline_keyboard: [
        [btn('💊 תרופות', 'h:meds'), btn('📒 יומן', 'h:log')],
        [btn('➕ אירוע רפואי', 'h:add'), btn('➕ תרופה', 'h:medadd')],
        [btn('⬅️ ללוח הראשי', 'm:menu')],
      ],
    },
  };
}

export async function medsView(env, now) {
  const tz = tzOf(env);
  const meds = await db.activeMeds(env, now);
  const lines = ['💊 <b>תרופות פעילות</b>', ''];
  const kb = [];
  if (!meds.length) lines.push('אין תרופות פעילות כרגע.');
  for (const m of meds) {
    const end = m.end_at ? `עד ${fmtDate(m.end_at - DAY, tz)}` : 'קבועה';
    lines.push(`• <b>${esc(m.name)}</b> · ${esc(m.dose)}\n   ⏰ ${m.times.split(',').join('  ')} · ${end}`);
    kb.push([btn(`⏹ הפסקת ${m.name}`.slice(0, 40), `h:stop:${m.id}`)]);
  }
  kb.push([btn('➕ תרופה חדשה', 'h:medadd')]);
  kb.push(back());
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: kb } };
}

export async function logView(env) {
  const tz = tzOf(env);
  const rows = await db.recentHealth(env, 12);
  const lines = ['📒 <b>יומן רפואי</b>', ''];
  if (!rows.length) lines.push('עדיין אין רשומות.');
  for (const h of rows) {
    const k = HEALTH_KINDS[h.kind] || HEALTH_KINDS.other;
    let l = `${k.emoji} <b>${esc(h.title)}</b> · ${fmtDate(h.at, tz)}`;
    if (h.next_due) l += `\n     🔁 לחזור: ${fmtDate(h.next_due, tz)}`;
    if (h.notes) l += `\n     📝 ${esc(h.notes)}`;
    lines.push(l);
  }
  return {
    text: lines.join('\n'),
    reply_markup: { inline_keyboard: [[btn('➕ אירוע רפואי', 'h:add'), btn('↩️ מחיקת האחרון שלי', 'h:undo')], back()] },
  };
}

export function kindPicker() {
  const ks = Object.entries(HEALTH_KINDS);
  const rows = [];
  for (let i = 0; i < ks.length; i += 2) rows.push(ks.slice(i, i + 2).map(([id, k]) => btn(`${k.emoji} ${k.label}`, `h:k:${id}`)));
  rows.push(back());
  return { text: '➕ <b>אירוע רפואי</b>\nמה היה?', reply_markup: { inline_keyboard: rows } };
}

export const eventPrompt = (kind) => ({
  text: [
    `${HEALTH_KINDS[kind].emoji} <b>${HEALTH_KINDS[kind].label}</b>`,
    '',
    'שלחו הודעה אחת בפורמט:',
    '<code>תיאור | תאריך | מתי לחזור | הערה</code>',
    '',
    'רק התיאור חובה. בלי תאריך זה היום.',
    'למשל:',
    '<code>חיסון משושה שני | 12.11 | 3 שבועות</code>',
    '<code>בדיקת דם | | | הכול תקין, ברזל קצת נמוך</code>',
    '<code>עיקור | 20.12.26 | | הוטרינר ד"ר כהן</code>',
  ].join('\n'),
  reply_markup: { inline_keyboard: [back('h:add')] },
});

export const medPrompt = () => ({
  text: [
    '💊 <b>תרופה חדשה</b>',
    '',
    'שלחו הודעה אחת בפורמט:',
    '<code>שם | מינון | שעות | כמה זמן</code>',
    '',
    'כמה זמן לא חובה. בלי זה התרופה קבועה.',
    'למשל:',
    '<code>אמוקסיצילין | חצי כדור | 08:00 20:00 | 7 ימים</code>',
    '<code>ויטמין | טיפה אחת | 09:00</code>',
  ].join('\n'),
  reply_markup: { inline_keyboard: [back()] },
});

export function medReminderText(med, time, second) {
  return `${second ? '⏰ <b>תזכורת שנייה</b>\n' : ''}💊 <b>${esc(med.name)}</b> ל${esc(DOG)}\nמינון: ${esc(med.dose)}\nשעה: ${time}`;
}

export const medReminderMarkup = (med, day, time) => ({
  inline_keyboard: [[btn('✅ ניתנה', `hg:${med.id}:${day}:${time.replace(':', '')}:g`), btn('⏭ דילגנו', `hg:${med.id}:${day}:${time.replace(':', '')}:s`)]],
});

/* ---------- תזכורות (מהקרון) ---------- */

async function sendToAdmins(env, text, markup) {
  const users = (await db.listUsers(env)).filter((u) => isAdmin(u) && u.chat_id);
  await Promise.all(
    users.map((u) => tgSafe(env, 'sendMessage', { chat_id: u.chat_id, text, parse_mode: 'HTML', ...(markup ? { reply_markup: markup } : {}) })),
  );
  return users.length;
}

export async function healthCron(env, now) {
  const tz = tzOf(env);
  const out = { meds: 0, due: 0 };

  // תרופות: תזכורת בשעה, ועוד אחת אחרי חצי שעה אם לא עודכן. אפשר גם בשעות שקט.
  for (const med of await db.activeMeds(env, now)) {
    const doses = new Map((await db.dosesFor(env, med.id)).map((d) => [d.slot, d]));
    for (const s of medSlots(med, now, tz)) {
      if (now < s.ts || now - s.ts > 3 * 3600000 || doses.has(s.slot)) continue;
      const k1 = `med1:${med.id}:${s.slot}`;
      const k2 = `med2:${med.id}:${s.slot}`;
      const first = !(await db.reminderSent(env, k1));
      let stage = 0;
      if (first && now - s.ts < 30 * 60000) stage = 1;
      else if (!first && now - s.ts >= 30 * 60000 && !(await db.reminderSent(env, k2))) stage = 2;
      if (!stage) continue;
      await db.markReminder(env, stage === 1 ? k1 : k2, now);
      out.meds += await sendToAdmins(env, medReminderText(med, s.time, stage === 2), medReminderMarkup(med, s.day, s.time));
    }
  }

  // חיסונים וטיפולים: שבוע לפני, ביום עצמו, ופעם אחת אחרי שעבר. רק בין 09:00 ל-20:00.
  const p = parts(now, tz);
  if (p.h >= 9 && p.h < 20) {
    for (const h of await db.dueHealth(env, now + 7 * DAY)) {
      const n = daysBetween(now, h.next_due, tz);
      const stage = n < -30 ? null : n < 0 ? 'late' : n === 0 ? '0' : '7';
      if (!stage) continue;
      const key = `hdue:${h.id}:${stage}`;
      if (await db.reminderSent(env, key)) continue;
      await db.markReminder(env, key, now);
      const k = HEALTH_KINDS[h.kind] || HEALTH_KINDS.other;
      const when = stage === 'late' ? `⚠️ המועד עבר לפני ${-n} ימים` : stage === '0' ? 'המועד הוא <b>היום</b>' : `בעוד ${n} ימים (${fmtDate(h.next_due, tz)})`;
      out.due += await sendToAdmins(env, `${k.emoji} <b>${esc(h.title)}</b> ל${esc(DOG)}\n${when}\n\nאחרי שזה נעשה, מוסיפים ביומן ב-🩺 בריאות.`);
    }
  }
  return out;
}

export { hhmm };

/* ---------- למסך לוח הבקרה (קריאה בלבד) ---------- */

export async function healthState(env, now) {
  const tz = tzOf(env);
  const [meds, due, log] = await Promise.all([db.activeMeds(env, now), db.dueHealth(env, now + 60 * DAY), db.recentHealth(env, 6)]);
  const today = dayCode(now, tz);
  const medOut = [];
  for (const med of meds) {
    const doses = new Map((await db.dosesFor(env, med.id)).map((d) => [d.slot, d]));
    const slots = medSlots(med, now, tz)
      .filter((s) => s.day === today)
      .map((s) => {
        const d = doses.get(s.slot);
        return { time: s.time, status: d ? d.status : s.ts <= now ? 'missed' : 'later' };
      });
    medOut.push({ name: med.name, dose: med.dose, slots, until: med.end_at ? med.end_at - DAY : null });
  }
  const one = (h) => ({ kind: h.kind, label: (HEALTH_KINDS[h.kind] || HEALTH_KINDS.other).label, title: h.title, at: h.at, next_due: h.next_due, notes: h.notes });
  return {
    meds: medOut,
    due: due.slice(0, 8).map((h) => ({ ...one(h), days: daysBetween(now, h.next_due, tz) })),
    log: log.map(one),
  };
}
