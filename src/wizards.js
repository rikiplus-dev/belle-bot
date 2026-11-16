// שאלונים בלחצנים: שעות אחריות והוספת תרופה. הטיוטה נשמרת בטבלת pending כ-JSON.
import * as db from './db.js';
import { MEMBERS, MEMBER_BY_ID } from './config.js';
import { esc } from './telegram.js';
import { startOfDay } from './time.js';
import { addSpan } from './parse.js';
import { daysText, clock } from './duty.js';

const btn = (text, data) => ({ text, callback_data: data });
const pad = (n) => String(n).padStart(2, '0');
const rowsOf = (arr, n = 2) => {
  const rows = [];
  for (let i = 0; i < arr.length; i += n) rows.push(arr.slice(i, i + n));
  return rows;
};
const LETTERS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];

export async function getWiz(env, tgId, prefix) {
  const p = await db.getPending(env, tgId);
  if (!p || !p.state.startsWith(`${prefix}:`)) return null;
  try {
    return { ...JSON.parse(p.state.slice(prefix.length + 1)), updated_at: p.updated_at };
  } catch {
    return null;
  }
}
export const saveWiz = (env, tgId, prefix, d, now) => {
  const { updated_at, ...rest } = d;
  return db.setPending(env, tgId, `${prefix}:${JSON.stringify(rest)}`, 0, now);
};

const hourGrid = (cb, selected = []) =>
  rowsOf(
    Array.from({ length: 24 }, (_, h) => btn(`${selected.includes(h) ? '✅ ' : ''}${pad(h)}:00`, `${cb}:${h}`)),
    4,
  );

/* ---------- שעות אחריות ---------- */

export const dutyStart = () => ({});

function dutyStep(d) {
  if (!d.who) return 'who';
  if (!d.days) return 'days';
  if (d.s === undefined) return 'start';
  if (d.e === undefined) return 'end';
  return 'save';
}

export function dutyView(d) {
  const step = dutyStep(d);
  const cancel = [btn('✖️ ביטול', 'dw:cancel')];
  const head = [];
  if (d.who) head.push(`👤 ${esc(MEMBER_BY_ID[d.who].name)}`);
  if (d.days) head.push(`📆 ${daysText(d.days.join(','))}`);
  if (d.s !== undefined) head.push(`🕐 מ-${clock(d.s)}`);
  const h = head.length ? head.join(' · ') + '\n\n' : '';
  if (step === 'who') {
    const ms = MEMBERS.map((m) => btn(m.name, `dw:p:${m.id}`));
    return { text: '📅 <b>שעות אחריות</b>\nמי יהיה באחריות?', reply_markup: { inline_keyboard: [...rowsOf(ms, 3), cancel] } };
  }
  if (step === 'days') {
    if (d.pick) {
      const sel = d.sel || [];
      const ds = LETTERS.map((l, i) => btn(`${sel.includes(i) ? '✅ ' : ''}${l}`, `dw:t:${i}`));
      return {
        text: h + 'באילו ימים? לוחצים כדי לסמן ולבטל.',
        reply_markup: { inline_keyboard: [...rowsOf(ds, 4), [btn('המשך ◀️', 'dw:ok')], cancel] },
      };
    }
    return {
      text: h + 'באילו ימים?',
      reply_markup: {
        inline_keyboard: [[btn('כל יום', 'dw:d:all'), btn('א׳-ה׳', 'dw:d:wk'), btn('סופ״ש', 'dw:d:we')], [btn('🔧 לבחור ימים', 'dw:d:pick')], cancel],
      },
    };
  }
  if (step === 'start') return { text: h + 'מאיזו שעה?', reply_markup: { inline_keyboard: [...hourGrid('dw:s'), cancel] } };
  if (step === 'end') {
    return {
      text: h + 'עד איזו שעה?\n<i>אם השעה קטנה מההתחלה, זה נמשך עד הבוקר שאחרי</i>',
      reply_markup: { inline_keyboard: [...hourGrid('dw:e'), cancel] },
    };
  }
  return null;
}

export function dutyChoice(d, field, value) {
  const n = { ...d };
  if (field === 'p') {
    if (!MEMBER_BY_ID[value]) return { error: 'לא מוכר' };
    n.who = value;
  } else if (field === 'd') {
    if (value === 'all') n.days = [0, 1, 2, 3, 4, 5, 6];
    else if (value === 'wk') n.days = [0, 1, 2, 3, 4];
    else if (value === 'we') n.days = [5, 6];
    else if (value === 'pick') {
      n.pick = true;
      n.sel = [];
    } else return { error: 'לא מוכר' };
  } else if (field === 't') {
    const i = Number(value);
    if (!(i >= 0 && i < 7)) return { error: 'לא מוכר' };
    const sel = new Set(d.sel || []);
    sel.has(i) ? sel.delete(i) : sel.add(i);
    n.sel = [...sel].sort();
  } else if (field === 'ok') {
    if (!d.sel || !d.sel.length) return { error: 'סמנו לפחות יום אחד' };
    n.days = d.sel;
    n.pick = false;
  } else if (field === 's') {
    const h = Number(value);
    if (!(h >= 0 && h < 24)) return { error: 'לא מוכר' };
    n.s = h * 60;
  } else if (field === 'e') {
    const h = Number(value);
    if (!(h >= 0 && h < 24)) return { error: 'לא מוכר' };
    if (h * 60 === d.s) return { error: 'שעת הסיום צריכה להיות שונה משעת ההתחלה' };
    n.e = h * 60;
  } else return { error: 'לא מוכר' };
  return { draft: n };
}

export async function dutySave(env, d) {
  await db.addDuty(env, { member: d.who, days: d.days, start: d.s, end: d.e });
}

/* ---------- תרופה חדשה ---------- */

const MED_NAMES = ['אנטיביוטיקה', 'משכך כאבים', 'ויטמין', 'טיפות עיניים', 'טיפות אוזניים', 'תרופה לעור'];
const MED_DOSES = ['חצי כדור', 'כדור אחד', 'טיפה אחת', '2 טיפות', '1 מ״ל', '2 מ״ל'];
const FREQ = { 1: [9], 2: [8, 20], 3: [8, 14, 20], 4: [6, 12, 18, 22] };
const FREQ_LABEL = { 1: 'פעם ביום', 2: 'פעמיים ביום', 3: '3 פעמים ביום', 4: '4 פעמים ביום' };
const DURS = { '5': 5, '7': 7, '10': 10, '14': 14, '30': 30 };

export const medStart = () => ({});

function medStep(d) {
  if (!d.n) return 'name';
  if (!d.o) return 'dose';
  if (!d.h) return 'freq';
  if (!d.tc) return 'tconfirm';
  if (d.u === undefined) return 'dur';
  return 'save';
}

export function medView(d) {
  const cancel = [btn('✖️ ביטול', 'mw:cancel')];
  const head = [];
  if (d.n) head.push(`💊 <b>${esc(d.n)}</b>`);
  if (d.o) head.push(`מינון: ${esc(d.o)}`);
  if (d.h && d.tc) head.push(`⏰ ${d.h.map((x) => `${pad(x)}:00`).join('  ')}`);
  const h = head.length ? head.join('\n') + '\n\n' : '';
  if (d.a) {
    return { text: h + (d.a === 'name' ? '✏️ כתבו את שם התרופה' : '✏️ כתבו את המינון, למשל: רבע כדור'), reply_markup: { inline_keyboard: [cancel] } };
  }
  const step = medStep(d);
  if (step === 'name') {
    const ps = MED_NAMES.map((t, i) => btn(t, `mw:n:${i}`));
    ps.push(btn('✏️ אחר', 'mw:n:x'));
    return { text: '💊 <b>תרופה חדשה</b>\nמה התרופה?', reply_markup: { inline_keyboard: [...rowsOf(ps), cancel] } };
  }
  if (step === 'dose') {
    const ps = MED_DOSES.map((t, i) => btn(t, `mw:o:${i}`));
    ps.push(btn('✏️ אחר', 'mw:o:x'));
    return { text: h + 'איזה מינון בכל פעם?', reply_markup: { inline_keyboard: [...rowsOf(ps), cancel] } };
  }
  if (step === 'freq') {
    const ps = Object.keys(FREQ).map((k) => btn(FREQ_LABEL[k], `mw:f:${k}`));
    return { text: h + 'כמה פעמים ביום?', reply_markup: { inline_keyboard: [...rowsOf(ps), cancel] } };
  }
  if (step === 'tconfirm') {
    if (d.edit) {
      return {
        text: h + 'באילו שעות? לוחצים כדי לסמן ולבטל.',
        reply_markup: { inline_keyboard: [...hourGrid('mw:t', d.h), [btn('המשך ◀️', 'mw:tok')], cancel] },
      };
    }
    return {
      text: `${h}⏰ השעות: ${d.h.map((x) => `${pad(x)}:00`).join('  ')}\nמתאים?`,
      reply_markup: { inline_keyboard: [[btn('✅ מתאים', 'mw:tc:ok'), btn('🕐 לשנות שעות', 'mw:tc:edit')], cancel] },
    };
  }
  if (step === 'dur') {
    return {
      text: h + 'למשך כמה זמן?',
      reply_markup: { inline_keyboard: [[btn('5 ימים', 'mw:u:5'), btn('7 ימים', 'mw:u:7'), btn('10 ימים', 'mw:u:10')], [btn('שבועיים', 'mw:u:14'), btn('חודש', 'mw:u:30')], [btn('♾ קבועה, בלי סוף', 'mw:u:none')], cancel] },
    };
  }
  return null;
}

export function medChoice(d, field, value) {
  const n = { ...d, a: null };
  if (field === 'n') {
    if (value === 'x') n.a = 'name';
    else if (MED_NAMES[Number(value)]) n.n = MED_NAMES[Number(value)];
    else return { error: 'לא מוכר' };
  } else if (field === 'o') {
    if (value === 'x') n.a = 'dose';
    else if (MED_DOSES[Number(value)]) n.o = MED_DOSES[Number(value)];
    else return { error: 'לא מוכר' };
  } else if (field === 'f') {
    if (!FREQ[value]) return { error: 'לא מוכר' };
    n.h = FREQ[value];
    n.tc = false;
    n.edit = false;
  } else if (field === 'tc') {
    if (value === 'ok') n.tc = true;
    else if (value === 'edit') n.edit = true;
    else return { error: 'לא מוכר' };
  } else if (field === 't') {
    const h = Number(value);
    if (!(h >= 0 && h < 24)) return { error: 'לא מוכר' };
    const sel = new Set(d.h || []);
    sel.has(h) ? sel.delete(h) : sel.add(h);
    if (sel.size > 6) return { error: 'עד 6 שעות ביום' };
    n.h = [...sel].sort((a, b) => a - b);
  } else if (field === 'tok') {
    if (!d.h || !d.h.length) return { error: 'סמנו לפחות שעה אחת' };
    n.tc = true;
    n.edit = false;
  } else if (field === 'u') {
    if (value === 'none') n.u = null;
    else if (DURS[value]) n.u = DURS[value];
    else return { error: 'לא מוכר' };
  } else return { error: 'לא מוכר' };
  return { draft: n };
}

export function medText(d, text) {
  const t = String(text || '').trim();
  if (!t || t.length > 60) return { error: 'כתבו טקסט קצר (עד 60 תווים)' };
  const n = { ...d, a: null };
  if (d.a === 'name') n.n = t;
  else if (d.a === 'dose') n.o = t;
  else return { error: '' };
  return { draft: n };
}

export async function medSave(env, d, member, now) {
  const tz = env.TZ || 'Asia/Jerusalem';
  const end = d.u ? addSpan(startOfDay(now, tz), { days: d.u }, tz) : null;
  const times = d.h.map((h) => `${pad(h)}:00`);
  const id = await db.addMed(env, { name: d.n, dose: d.o, times, end, member }, now);
  return { id, name: d.n, dose: d.o, times, end };
}
