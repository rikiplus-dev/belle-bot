// מעקב בריאות: תרופות עם שעות, יומן רפואי ומועדי חזרה. רק מי שברשימת ADMINS רואה ומעדכן.
import * as db from './db.js';
import { DOG, MEMBER_BY_ID, HEALTH_KINDS, isAdmin } from './config.js';
import { esc, tgSafe } from './telegram.js';
import { parts, startOfDay, hhmm } from './time.js';
import { parseMedLine, parseHealthLine, parseDate, parseSpan, addSpan } from './parse.js';
import { googleCalendarUrl, icsFile } from './calendar.js';
import { tgDocument } from './telegram.js';

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
        [btn('⏰ תזכורת עתידית', 'hw:new:future'), btn('➕ אירוע שהיה', 'hw:new:past')],
        [btn('📅 מועדים קרובים', 'h:due'), btn('📒 יומן', 'h:log')],
        [btn('💊 תרופות', 'h:meds'), btn('➕ תרופה', 'h:medadd')],
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
    reply_markup: { inline_keyboard: [[btn('➕ אירוע שהיה', 'hw:new:past'), btn('↩️ מחיקת האחרון שלי', 'h:undo')], back()] },
  };
}

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
      const key = `hdue:${h.id}:${h.next_due}:${stage}`;
      if (await db.reminderSent(env, key)) continue;
      await db.markReminder(env, key, now);
      const k = HEALTH_KINDS[h.kind] || HEALTH_KINDS.other;
      const when = stage === 'late' ? `⚠️ המועד עבר לפני ${-n} ימים` : stage === '0' ? 'המועד הוא <b>היום</b>' : `בעוד ${n} ימים (${fmtDate(h.next_due, tz)})`;
      out.due += await sendToAdmins(env, `${k.emoji} <b>${esc(h.title)}</b> ל${esc(DOG)}\n${when}`, {
        inline_keyboard: [[btn('✅ בוצע', `hd:${h.id}`), btn('⏳ בעוד שבוע', `hs:${h.id}`)], [btn('📅 הוספה ליומן', `hc:${h.id}`)]],
      });
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

/* ---------- שאלון: אירוע שהיה או תזכורת עתידית, שלב אחרי שלב ---------- */

const PRESETS = {
  vaccine: ['כלבת', 'משושה', 'משושה (מנה שנייה)', 'משושה (מנה שלישית)', 'לפטוספירוזיס', 'שעלת מכלבים'],
  deworm: ['תילוע'],
  flea: ['פרעושים וקרציות'],
  blood: ['בדיקת דם'],
  vet: ['ביקור וטרינר', 'בדיקה שנתית'],
  surgery: ['עיקור', 'הוצאת שן', 'ניתוח אחר'],
  other: [],
};
const DATE_OPTS = [['היום', 0], ['אתמול', 1], ['לפני 3 ימים', 3], ['לפני שבוע', 7], ['לפני חודש', 30]];
const SPANS = {
  '1w': { days: 7 },
  '2w': { days: 14 },
  '3w': { days: 21 },
  '1m': { months: 1 },
  '3m': { months: 3 },
  '6m': { months: 6 },
  '1y': { months: 12 },
};
const DUE_LABEL = { '1w': 'שבוע', '2w': 'שבועיים', '3w': '3 שבועות', '1m': 'חודש', '3m': '3 חודשים', '6m': 'חצי שנה', '1y': 'שנה' };
const DUE_PAST = ['3w', '1m', '3m', '6m', '1y'];
const DUE_FUTURE = ['1w', '2w', '1m', '3m', '6m', '1y'];
const rowsOf = (arr, n = 2) => {
  const rows = [];
  for (let i = 0; i < arr.length; i += n) rows.push(arr.slice(i, i + n));
  return rows;
};

export async function getDraft(env, tgId) {
  const p = await db.getPending(env, tgId);
  if (!p || !p.state.startsWith('hw:')) return null;
  try {
    return { ...JSON.parse(p.state.slice(3)), updated_at: p.updated_at };
  } catch {
    return null;
  }
}
export const saveDraft = (env, tgId, d, now) => {
  const { updated_at, ...rest } = d;
  return db.setPending(env, tgId, `hw:${JSON.stringify(rest)}`, 0, now);
};

function nextStep(d) {
  if (d.m === 'return') return d.r === undefined ? 'due' : 'save';
  if (!d.k) return 'kind';
  if (!d.t) return 'title';
  if (d.m === 'past' && d.d === undefined) return 'date';
  if (d.r === undefined) return 'due';
  if (d.n === undefined) return 'notes';
  return 'save';
}

const cancelRow = [btn('✖️ ביטול', 'hw:cancel')];

function summary(d, tz) {
  const lines = [];
  if (d.k) lines.push(`${HEALTH_KINDS[d.k].emoji} <b>${esc(d.t || HEALTH_KINDS[d.k].label)}</b>${d.m === 'future' ? ' · תזכורת עתידית' : ''}`);
  if (d.d !== undefined && d.d !== null) lines.push(`📅 בוצע: ${fmtDate(d.d, tz)}`);
  if (d.r) lines.push(`🔁 ${d.m === 'future' ? 'מועד' : 'לחזור'}: ${fmtDate(d.r, tz)}`);
  else if (d.r === null) lines.push('🔁 בלי מועד חזרה');
  if (d.n) lines.push(`📝 ${esc(d.n)}`);
  return lines.length ? lines.join('\n') + '\n\n' : '';
}

export function wizardView(d, tz) {
  const step = nextStep(d);
  const head = summary(d, tz);
  if (d.a) {
    const prompts = {
      title: '✏️ כתבו את שם האירוע, למשל: חיסון כלבת',
      date: '📅 כתבו את התאריך שבו זה היה, למשל 12.11 או 12.11.26',
      due: d.m === 'future' ? '📅 כתבו מתי צריך לעשות את זה: תאריך כמו 20.12.26, או "בעוד 5 שבועות"' : '📅 כתבו מתי לחזור על זה: תאריך כמו 20.12.26, או "6 שבועות"',
      notes: '📝 כתבו את ההערה',
    };
    return { text: head + prompts[d.a], reply_markup: { inline_keyboard: [cancelRow] } };
  }
  if (step === 'kind') {
    const ks = Object.entries(HEALTH_KINDS).map(([id, k]) => btn(`${k.emoji} ${k.label}`, `hw:k:${id}`));
    return {
      text: d.m === 'future' ? '⏰ <b>תזכורת עתידית</b>\nעל מה להזכיר?' : '➕ <b>אירוע שהיה</b>\nמה היה?',
      reply_markup: { inline_keyboard: [...rowsOf(ks), cancelRow] },
    };
  }
  if (step === 'title') {
    const ps = (PRESETS[d.k] || []).map((t, i) => btn(t, `hw:t:${i}`));
    ps.push(btn('✏️ אחר', 'hw:t:x'));
    return { text: head + 'איזה אירוע?', reply_markup: { inline_keyboard: [...rowsOf(ps), cancelRow] } };
  }
  if (step === 'date') {
    const ds = DATE_OPTS.map(([l, n]) => btn(l, `hw:d:${n}`));
    ds.push(btn('📅 תאריך אחר', 'hw:d:x'));
    return { text: head + 'מתי זה היה?', reply_markup: { inline_keyboard: [...rowsOf(ds), cancelRow] } };
  }
  if (step === 'due') {
    const opts = (d.m === 'future' ? DUE_FUTURE : DUE_PAST).map((k) => btn(d.m === 'future' ? `בעוד ${DUE_LABEL[k]}` : DUE_LABEL[k], `hw:r:${k}`));
    opts.push(btn('📅 תאריך אחר', 'hw:r:x'));
    const rows = rowsOf(opts, 3);
    if (d.m === 'past') rows.push([btn('🚫 אין צורך לחזור', 'hw:r:none')]);
    rows.push(cancelRow);
    const q = d.m === 'future' ? '⏰ מתי צריך לעשות את זה?' : d.m === 'return' ? '✅ נרשם.\n🔁 מתי לחזור על זה?' : '🔁 מתי לחזור על זה?\n<i>אזכיר שבוע לפני וביום עצמו</i>';
    return { text: head + q, reply_markup: { inline_keyboard: rows } };
  }
  if (step === 'notes') {
    return { text: head + '📝 רוצים להוסיף הערה?', reply_markup: { inline_keyboard: [[btn('בלי הערה', 'hw:n:skip'), btn('✏️ הערה', 'hw:n:x')], cancelRow] } };
  }
  return null;
}

// מעדכן את הטיוטה לפי לחיצה. מחזיר { draft } או { error }
export function applyChoice(d, field, value, now, tz) {
  const today = startOfDay(now, tz);
  const next = { ...d, a: null };
  if (field === 'k') {
    if (!HEALTH_KINDS[value]) return { error: 'לא מוכר' };
    next.k = value;
    if (value === 'other') next.a = 'title';
  } else if (field === 't') {
    if (value === 'x') next.a = 'title';
    else {
      const t = (PRESETS[d.k] || [])[Number(value)];
      if (!t) return { error: 'לא מוכר' };
      next.t = t;
    }
  } else if (field === 'd') {
    if (value === 'x') next.a = 'date';
    else next.d = startOfDay(today - Number(value) * DAY + 12 * 3600000, tz);
  } else if (field === 'r') {
    if (value === 'x') next.a = 'due';
    else if (value === 'none') next.r = null;
    else if (SPANS[value]) next.r = addSpan(d.m === 'past' ? d.d : today, SPANS[value], tz);
    else return { error: 'לא מוכר' };
  } else if (field === 'n') {
    if (value === 'x') next.a = 'notes';
    else next.n = null;
  }
  return { draft: next };
}

// טקסט חופשי בשלב שמחכה להקלדה
export function applyText(d, text, now, tz) {
  const today = startOfDay(now, tz);
  const t = String(text || '').trim();
  const next = { ...d, a: null };
  if (d.a === 'title') {
    if (!t || t.length > 80) return { error: 'כתבו שם קצר (עד 80 תווים)' };
    next.t = t;
  } else if (d.a === 'date') {
    const ts = parseDate(t, now, tz);
    if (ts === null) return { error: 'לא הבנתי. כתבו תאריך כמו 12.11 או 12.11.26' };
    if (ts > now) return { error: 'זה תאריך עתידי. לתזכורת עתידית חוזרים ללחוץ ⏰' };
    next.d = ts;
  } else if (d.a === 'due') {
    let ts = parseDate(t, now, tz);
    if (ts === null) {
      const sp = parseSpan(t);
      if (!sp) return { error: 'לא הבנתי. כתבו תאריך כמו 20.12.26, או "6 שבועות"' };
      ts = addSpan(d.m === 'past' ? d.d : today, sp, tz);
    }
    if (ts < today || (d.m === 'past' && ts <= d.d)) return { error: 'המועד צריך להיות בעתיד' };
    next.r = ts;
  } else if (d.a === 'notes') {
    if (t.length > 200) return { error: 'ההערה ארוכה מדי' };
    next.n = t || null;
  } else return { error: '' };
  return { draft: next };
}

export const startDraft = (mode) => ({ m: mode });

// שמירה סופית. מחזיר { id, title, due }
export async function saveDraftResult(env, d, member, now) {
  const tz = tzOf(env);
  const today = startOfDay(now, tz);
  if (d.m === 'return') {
    const row = await db.getHealth(env, d.id);
    if (!row) return null;
    if (d.r) await db.setHealthDue(env, d.id, d.r);
    return { id: d.id, title: row.title, kind: row.kind, due: d.r || null, notes: row.notes };
  }
  const id = await db.addHealth(
    env,
    { kind: d.k, title: d.t, at: d.m === 'past' ? d.d : today, notes: d.n || null, due: d.r || null, member, done: d.m === 'past' ? 1 : 0 },
    now,
  );
  return { id, title: d.t, kind: d.k, due: d.r || null, notes: d.n || null };
}

export function calendarUrl(env, item) {
  return googleCalendarUrl({ title: `${(HEALTH_KINDS[item.kind] || HEALTH_KINDS.other).emoji} ${item.title} · ${DOG}`, dueTs: item.due, notes: item.notes }, tzOf(env));
}

export function savedView(env, item, future) {
  const tz = tzOf(env);
  const k = HEALTH_KINDS[item.kind] || HEALTH_KINDS.other;
  const lines = [`✅ <b>נשמר</b>`, `${k.emoji} ${esc(item.title)}`];
  const kb = [];
  if (item.due) {
    lines.push(`🔁 ${future ? 'מועד' : 'לחזור'}: <b>${fmtDate(item.due, tz)}</b>`);
    lines.push('<i>אזכיר שבוע לפני, וביום עצמו.</i>');
    kb.push([{ text: '📅 הוספה ליומן בטלפון', url: calendarUrl(env, item) }]);
    kb.push([btn('📎 קובץ ליומן (אייפון ועוד)', `hc:${item.id}`)]);
  }
  kb.push([btn('⏰ עוד תזכורת', 'hw:new:future'), btn('➕ אירוע שהיה', 'hw:new:past')]);
  kb.push([btn('🩺 לבריאות', 'h:home')]);
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: kb } };
}

// שולח קובץ ליומן וגם הודעה עם קישור ליומן גוגל
export async function sendCalendar(env, chatId, row) {
  if (!row || !row.next_due) return false;
  const tz = tzOf(env);
  const k = HEALTH_KINDS[row.kind] || HEALTH_KINDS.other;
  const title = `${k.emoji} ${row.title} · ${DOG}`;
  const ics = icsFile({ title, dueTs: row.next_due, notes: row.notes, uid: `health-${row.id}` }, tz);
  await tgSafe(env, 'sendMessage', {
    chat_id: chatId,
    text: `📅 <b>${esc(row.title)}</b> · ${fmtDate(row.next_due, tz)}\nלחיצה על הכפתור פותחת את היומן עם האירוע מוכן.`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '📅 הוספה ליומן בטלפון', url: googleCalendarUrl({ title, dueTs: row.next_due, notes: row.notes }, tz) }]] },
  });
  await tgDocument(env, chatId, 'bell-event.ics', ics, 'text/calendar', 'פותחים את הקובץ ובוחרים "הוספה ליומן"');
  return true;
}

export async function dueView(env, now) {
  const tz = tzOf(env);
  const rows = (await db.dueHealth(env, now + 365 * DAY)).slice(0, 8);
  const lines = ['📅 <b>מועדים קרובים</b>', ''];
  const kb = [];
  if (!rows.length) lines.push('אין מועדים עתידיים. אפשר להוסיף ב-⏰ תזכורת עתידית.');
  for (const h of rows) {
    const k = HEALTH_KINDS[h.kind] || HEALTH_KINDS.other;
    const n = daysBetween(now, h.next_due, tz);
    const when = n < 0 ? `⚠️ עבר לפני ${-n} ימים` : n === 0 ? 'היום' : n === 1 ? 'מחר' : `בעוד ${n} ימים`;
    lines.push(`${k.emoji} <b>${esc(h.title)}</b> · ${fmtDate(h.next_due, tz)} · ${when}`);
    const short = h.title.length > 14 ? h.title.slice(0, 13) + '…' : h.title;
    kb.push([btn(`✅ ${short}`, `hd:${h.id}`), btn('📅', `hc:${h.id}`), btn('⏳', `hs:${h.id}`), btn('🗑', `hx:${h.id}`)]);
  }
  if (rows.length) lines.push('', '<i>✅ בוצע · 📅 ליומן · ⏳ בעוד שבוע · 🗑 ביטול התזכורת</i>');
  kb.push([btn('⏰ תזכורת חדשה', 'hw:new:future')]);
  kb.push(back());
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: kb } };
}
