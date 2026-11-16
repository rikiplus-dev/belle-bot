// הכול על בל: תעודה, משקל, חיברות ופקודות, טיפים, תבנית חיסונים ודוח מלא.
import * as db from './db.js';
import { DOG, HEALTH_KINDS, isAdmin } from './config.js';
import { esc } from './telegram.js';
import { parts, startOfDay } from './time.js';
import { parseDate } from './parse.js';
import { fmtDate } from './health.js';
import { TIPS, FUN, tipFor, funFor, tipOfDay } from './tips.js';
import { insightsView } from './insights.js';

const DAY = 86400000;
const tzOf = (env) => env.TZ || 'Asia/Jerusalem';
const btn = (text, data) => ({ text, callback_data: data });
const kb = (rows) => ({ inline_keyboard: rows });
const kg = (g) => `${Number((g / 1000).toFixed(2))} ק״ג`;

export const PROFILE_FIELDS = {
  chip: '🔖 מספר שבב',
  license: '🪪 רישיון כלב',
  vet: '👩‍⚕️ וטרינר/ית',
  vetphone: '📞 טלפון הווטרינר',
  breeder: '🏡 מגדל/ת',
  look: '🎨 צבע וסימנים',
};

export const SOCIAL = [
  ['kids', '🧒 ילדים'], ['strangers', '🧑 אנשים זרים'], ['hat', '🧢 כובעים ומשקפיים'], ['dogs', '🐕 כלבים מחוסנים'],
  ['car', '🚗 נסיעה ברכב'], ['stairs', '🪜 מדרגות ומעלית'], ['grass', '🌿 דשא'], ['tile', '🧱 אריחים ומשטחים חלקים'],
  ['sand', '🏖 חול'], ['vacuum', '🧹 שואב אבק'], ['thunder', '⛈ רעמים וחזקות'], ['street', '🚦 רחוב ורעש'],
  ['brush', '🪮 צחצוח'], ['nails', '✂️ גזירת ציפורניים'], ['teeth', '🦷 נגיעה בשיניים'], ['bath', '🛁 אמבטיה ומייבש'],
  ['harness', '🦮 רתמה ורצועה'], ['vet', '🩺 ביקור אצל הווטרינר'], ['alone', '🏠 להישאר לבד 5 דקות'],
];

export const CMDS = [
  ['name', '📣 קריאה בשם'], ['sit', '🐕 שב'], ['come', '🏃 בואי'], ['no', '🚫 לא / עזבי'], ['place', '🛏 מקום'],
  ['drop', '🎾 תני'], ['heel', '🚶 הליכה לידי'], ['down', '⬇️ שכב'], ['wait', '✋ חכי'],
];
const LEVELS = ['עוד לא התחלנו', '🌱 לומדת', '🌿 מבינה', '🌳 אמינה'];

/* ---------- גיל ומשקל ---------- */

export function ageText(birth, now) {
  const days = Math.floor((now - birth) / DAY);
  if (days < 0) return null;
  const weeks = Math.floor(days / 7);
  if (weeks <= 20) return weeks === 1 ? 'שבוע' : weeks === 2 ? 'שבועיים' : `${weeks} שבועות`;
  const months = Math.floor(days / 30.44);
  if (months < 24) return `${months} חודשים`;
  return `${Math.floor(months / 12)} שנים`;
}

// "3.2" או "3,2 ק״ג" או "3200 גרם", ואפשר תאריך אחריו: "3.2 12.10"
export function parseWeight(text, now, tz) {
  const t = String(text).trim().replace(/[״"׳']/g, '');
  const toks = t.split(/\s+/);
  const m = toks[0].match(/^(\d+(?:[.,]\d+)?)(קג|ק"ג|kg|גרם|גר|g)?$/i);
  if (!m) return { error: 'כתבו משקל כמו 3.2 (בקילו) או 3200 (בגרמים). אפשר להוסיף תאריך: 3.2 12.10' };
  let n = parseFloat(m[1].replace(',', '.'));
  const unit = (m[2] || toks[1] || '').toLowerCase();
  const isGrams = /^(גרם|גר|g)$/.test(unit) || n >= 100;
  const grams = Math.round(isGrams ? n : n * 1000);
  if (grams < 100 || grams > 20000) return { error: 'המשקל נראה לא הגיוני. נסו שוב, למשל 3.2' };
  let ts = now;
  const dtok = toks.slice(1).find((x) => /\d/.test(x));
  if (dtok) {
    const d = parseDate(dtok, now, tz);
    if (d === null) return { error: 'לא הבנתי את התאריך. כתבו למשל 12.10' };
    if (d > now) return { error: 'התאריך עוד לא הגיע' };
    ts = d + 12 * 3600000;
  }
  return { grams, ts };
}

const spark = (vals) => {
  if (vals.length < 2) return '';
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const bars = '▁▂▃▄▅▆▇█';
  return vals.map((v) => bars[hi === lo ? 3 : Math.round(((v - lo) / (hi - lo)) * 7)]).join('');
};

/* ---------- המרכז ---------- */

export async function hub(env, user, now, notice = '') {
  const tz = tzOf(env);
  const [prof, ws, soc, cmd] = await Promise.all([db.getProfile(env), db.recentWeights(env, 1), db.progressAll(env, 'social'), db.progressAll(env, 'cmd')]);
  const lines = [`🐶 <b>הכול על ${esc(DOG)}</b>`];
  if (notice) lines.push(`<i>${esc(notice)}</i>`);
  lines.push('');
  const bits = [];
  if (prof.birth) bits.push(`בת ${ageText(+prof.birth, now) || '?'}`);
  if (ws[0]) bits.push(`⚖️ ${kg(ws[0].grams)}`);
  if (bits.length) lines.push(bits.join(' · '));
  lines.push(`🎓 חיברות ${Object.values(soc).filter((r) => r.level > 0).length}/${SOCIAL.length} · פקודות ${Object.values(cmd).filter((r) => r.level > 0).length}/${CMDS.length}`);
  lines.push('', `💡 <b>טיפ להיום</b>`, `${esc(tipOfDay(now).t)}`);
  const rows = [
    [btn('📇 תעודת בל', 'b:card'), btn('⚖️ משקל', 'b:w')],
    [btn('🎓 חיברות', 'b:soc'), btn('🗣 פקודות', 'b:cmd')],
    [btn('💡 טיפים וכיף', 'b:tip:0'), btn('📈 ניתוח ותובנות', 'b:ins')],
    [btn('🍖 מה מותר לאכול', 'f:home')],
  ];
  if (isAdmin(user)) {
    rows.push([btn('🩺 בריאות', 'h:home'), btn('💉 תבנית חיסונים', 'b:vt')]);
    rows.push([btn('📄 דוח מלא לווטרינר', 'b:rep')]);
  }
  rows.push([btn('⬅️ חזרה', 'm:menu')]);
  return { text: lines.join('\n'), reply_markup: kb(rows) };
}

/* ---------- תעודה ---------- */

export async function card(env, user, now) {
  const tz = tzOf(env);
  const [prof, ws] = await Promise.all([db.getProfile(env), db.recentWeights(env, 1)]);
  const lines = [`📇 <b>תעודת ${esc(DOG)}</b>`, '', `🐶 ${esc(DOG)} · שיצו · נקבה`];
  lines.push(prof.birth ? `🎂 נולדה ${fmtDate(+prof.birth, tz)} (בת ${ageText(+prof.birth, now) || '?'})` : '🎂 תאריך לידה: עוד לא הוגדר');
  if (ws[0]) lines.push(`⚖️ משקל אחרון: ${kg(ws[0].grams)} (${fmtDate(ws[0].ts, tz)})`);
  for (const [k, label] of Object.entries(PROFILE_FIELDS)) lines.push(`${label}: ${prof[k] ? esc(prof[k]) : '—'}`);
  const rows = [[btn(prof.birth ? '🎂 שינוי תאריך לידה' : '🎂 הגדרת תאריך לידה', 'b:bd')]];
  if (isAdmin(user)) {
    const keys = Object.keys(PROFILE_FIELDS);
    for (let i = 0; i < keys.length; i += 2) rows.push(keys.slice(i, i + 2).map((k) => btn(`✏️ ${PROFILE_FIELDS[k]}`, `b:e:${k}`)));
  } else lines.push('', '<i>את הפרטים מעדכנים אמתי וריקי.</i>');
  rows.push([btn('⬅️ חזרה', 'b:hub')]);
  if (!isAdmin(user)) rows[0] = []; // רק מנהלים משנים
  return { text: lines.join('\n'), reply_markup: kb(rows.filter((r) => r.length)) };
}

export function birthPicker() {
  const w = [8, 9, 10, 11, 12, 13, 14, 15, 16, 20, 24, 30];
  const rows = [];
  for (let i = 0; i < w.length; i += 4) rows.push(w.slice(i, i + 4).map((x) => btn(`${x} שב׳`, `b:bdw:${x}`)));
  rows.push([btn('✍️ תאריך מדויק', 'b:bdt')]);
  rows.push([btn('⬅️ חזרה', 'b:card')]);
  return { text: `🎂 <b>בת כמה ${esc(DOG)} היום?</b>\nבוחרים בערך, או כותבים תאריך לידה מדויק.`, reply_markup: kb(rows) };
}

const askText = (title, hint) => ({
  text: `${title}\n${hint}`,
  reply_markup: kb([[btn('✖️ ביטול', 'b:card')]]),
});

/* ---------- משקל ---------- */

export async function weightView(env, now, notice = '') {
  const tz = tzOf(env);
  const ws = await db.recentWeights(env, 10);
  const lines = [`⚖️ <b>משקל ${esc(DOG)}</b>`];
  if (notice) lines.push(`<i>${esc(notice)}</i>`);
  lines.push('');
  if (!ws.length) lines.push('עוד לא תועד משקל. שוקלים על משקל ביתי: מחזיקים אותה ושוקלים, ומפחיתים את המשקל שלכם.');
  else {
    lines.push(`${spark([...ws].reverse().map((w) => w.grams))}`);
    ws.slice(0, 6).forEach((w, i) => {
      const prev = ws[i + 1];
      const d = prev ? w.grams - prev.grams : null;
      lines.push(`${fmtDate(w.ts, tz)}  <b>${kg(w.grams)}</b>${d ? `  (${d > 0 ? '+' : ''}${d} גר׳)` : ''}`);
    });
  }
  return { text: lines.join('\n'), reply_markup: kb([[btn('➕ תיעוד משקל', 'b:wa')], ws.length ? [btn('↩️ ביטול המשקל האחרון', 'b:wu')] : [], [btn('⬅️ חזרה', 'b:hub')]].filter((r) => r.length)) };
}

export async function weightAdd(env) {
  const [last] = await db.recentWeights(env, 1);
  const rows = [];
  if (last) {
    const g = last.grams;
    rows.push([btn(`כמו קודם ${kg(g)}`, `b:wn:${g}`)]);
    rows.push([100, 200, 300, 500].map((d) => btn(`+${d} גר׳`, `b:wn:${g + d}`)));
  }
  rows.push([btn('✍️ מספר אחר או תאריך אחר', 'b:ww')]);
  rows.push([btn('⬅️ חזרה', 'b:w')]);
  return { text: `⚖️ <b>כמה שוקלת ${esc(DOG)}?</b>${last ? `\nבפעם הקודמת: ${kg(last.grams)}` : '\nכתבו את המשקל בקילו, למשל 2.4'}`, reply_markup: kb(rows) };
}

/* ---------- חיברות ופקודות ---------- */

export async function socialView(env) {
  const done = await db.progressAll(env, 'social');
  const n = SOCIAL.filter(([k]) => done[k] && done[k].level > 0).length;
  const rows = [];
  for (let i = 0; i < SOCIAL.length; i += 2) {
    rows.push(SOCIAL.slice(i, i + 2).map(([k, label], j) => btn(`${done[k] && done[k].level > 0 ? '✅' : '⬜'} ${label}`, `b:st:${i + j}`)));
  }
  rows.push([btn('⬅️ חזרה', 'b:hub')]);
  return {
    text: `🎓 <b>חיברות: ${n}/${SOCIAL.length}</b>\nגורים לומדים הכי טוב עד גיל כ-4 חודשים. כל דבר שבל פוגשת בנעימים עכשיו יהיה לה רגיל בהמשך.\nלוחצים כשהיא פגשה את זה והכול היה בסדר.`,
    reply_markup: kb(rows),
  };
}

export async function cmdView(env) {
  const st = await db.progressAll(env, 'cmd');
  const rows = [];
  const lines = [`🗣 <b>פקודות</b>`, 'לוחצים על פקודה כדי להתקדם בה: לומדת ← מבינה ← אמינה.', ''];
  CMDS.forEach(([k, label], i) => {
    const l = st[k] ? st[k].level : 0;
    lines.push(`${label}: ${LEVELS[l]}`);
    rows.push([btn(`${label} · ${LEVELS[l]}`, `b:ct:${i}`)]);
  });
  rows.push([btn('⬅️ חזרה', 'b:hub')]);
  return { text: lines.join('\n'), reply_markup: kb(rows) };
}

/* ---------- טיפים וכיף ---------- */

export function tipView(i, now) {
  const all = [...TIPS.map((t) => ({ ...t, kind: 'tip' })), ...FUN.map((t) => ({ ...t, kind: 'fun' }))];
  const n = ((i % all.length) + all.length) % all.length;
  const x = all[n];
  return {
    text: `${x.kind === 'tip' ? '💡 <b>טיפ לאילוף</b>' : '🎉 <b>עובדה כיפית</b>'}\n\n<b>${esc(x.t)}</b>\n${esc(x.b)}`,
    reply_markup: kb([[btn('◀️ הקודם', `b:tip:${n - 1}`), btn(`${n + 1}/${all.length}`, `b:tip:${n}`), btn('הבא ▶️', `b:tip:${n + 1}`)], [btn('⬅️ חזרה', 'b:hub')]]),
  };
}

/* ---------- תבנית חיסונים וטיפולים לגור ---------- */

// לוח לדוגמה לגורים בישראל. כדאי לאשר מול הווטרינר של בל.
export const VACCINE_PLAN = [
  { w: 8, kind: 'vaccine', title: 'משושה: מנה ראשונה' },
  { w: 8, kind: 'deworm', title: 'תילוע (8 שבועות)' },
  { w: 8, kind: 'flea', title: 'טיפול נגד פרעושים וקרציות (התחלה)' },
  { w: 12, kind: 'vaccine', title: 'משושה + כלבת + לפטו: מנה שנייה' },
  { w: 12, kind: 'deworm', title: 'תילוע (12 שבועות)' },
  { w: 16, kind: 'vaccine', title: 'כלבת ולפטו: חיזוק' },
  { w: 16, kind: 'deworm', title: 'תילוע (16 שבועות)' },
  { w: 65, kind: 'vaccine', title: 'חיזוק כללי (גיל 15 חודשים)' },
];

export async function vaccineView(env, now) {
  const tz = tzOf(env);
  const prof = await db.getProfile(env);
  if (!prof.birth) {
    return { text: '💉 <b>תבנית חיסונים וטיפולים</b>\nכדי לחשב תאריכים צריך קודם את תאריך הלידה של בל.', reply_markup: kb([[btn('🎂 הגדרת תאריך לידה', 'b:bd')], [btn('⬅️ חזרה', 'b:hub')]]) };
  }
  const today = startOfDay(now, tz);
  const lines = [`💉 <b>תבנית חיסונים וטיפולים</b>`, `<i>לפי גיל ${esc(ageText(+prof.birth, now) || '')}. זו הצעה כללית, לאשר מול הווטרינר.</i>`, ''];
  let future = 0;
  let past = 0;
  for (const it of VACCINE_PLAN) {
    const due = startOfDay(+prof.birth + it.w * 7 * DAY, tz);
    const have = await db.healthByTitle(env, it.title);
    const k = HEALTH_KINDS[it.kind];
    let mark;
    if (have && have.done) mark = '✅ בוצע';
    else if (have) mark = '⏳ מתוכנן';
    else if (due >= today) {
      mark = '⬜ להוסיף';
      future++;
    } else {
      mark = '❔ התאריך עבר';
      past++;
    }
    lines.push(`${k.emoji} ${esc(it.title)}\n   ${fmtDate(due, tz)} · ${mark}`);
  }
  const rows = [];
  if (future) rows.push([btn(`⏰ הוספת ${future} תזכורות עתידיות`, 'b:vta')]);
  if (past) rows.push([btn(`✅ ${past} שעברו: סימון כבוצעו`, 'b:vtd')]);
  rows.push([btn('➕ אירוע שהיה (יומן)', 'hw:new:past'), btn('📒 יומן', 'h:log')]);
  rows.push([btn('⬅️ חזרה', 'b:hub')]);
  if (past) lines.push('', '<i>"סימון כבוצעו" רושם אותם בתאריך המשוער. אם בוצעו בתאריך אחר, אפשר לתעד אותם ביומן.</i>');
  return { text: lines.join('\n'), reply_markup: kb(rows) };
}

export async function applyVaccinePlan(env, mode, member, now) {
  const tz = tzOf(env);
  const prof = await db.getProfile(env);
  if (!prof.birth) return 0;
  const today = startOfDay(now, tz);
  let n = 0;
  for (const it of VACCINE_PLAN) {
    const due = startOfDay(+prof.birth + it.w * 7 * DAY, tz);
    if (await db.healthByTitle(env, it.title)) continue;
    if (mode === 'future' && due >= today) {
      await db.addHealth(env, { kind: it.kind, title: it.title, at: today, notes: 'מהתבנית לגורים', due, member, done: 0 }, now);
      n++;
    } else if (mode === 'past' && due < today) {
      await db.addHealth(env, { kind: it.kind, title: it.title, at: due, notes: 'מהתבנית (תאריך משוער)', due: null, member, done: 1 }, now);
      n++;
    }
  }
  return n;
}

/* ---------- דוח מלא (קובץ להדפסה או לשליחה לווטרינר) ---------- */

export async function reportHtml(env, now) {
  const tz = tzOf(env);
  const [prof, ws, done, due, meds] = await Promise.all([
    db.getProfile(env),
    db.recentWeights(env, 50),
    db.allHealthDone(env),
    db.dueHealth(env, now + 365 * DAY),
    db.activeMeds(env, now),
  ]);
  const from = startOfDay(now, tz) - 13 * DAY;
  const ev = await db.eventsBetween(env, from, now + DAY);
  const days = new Map();
  for (let i = 0; i < 14; i++) days.set(fmtDate(from + i * DAY + 12 * 3600000, tz), { out: 0, home: 0, meal: 0 });
  for (const e of ev) {
    const d = days.get(fmtDate(e.ts, tz));
    if (!d) continue;
    if (e.kind === 'pee_out' || e.kind === 'poop_out') d.out++;
    else if (e.kind === 'pee_home' || e.kind === 'poop_home') d.home++;
    else if (e.kind === 'meal') d.meal++;
  }
  const row = (cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  const kindLabel = (k) => (HEALTH_KINDS[k] || HEALTH_KINDS.other).label;
  const html = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>דוח בריאות: ${esc(DOG)}</title>
<style>body{font:16px/1.5 system-ui,Arial,sans-serif;max-width:720px;margin:24px auto;padding:0 16px;color:#222}h1{margin:0 0 4px}h2{margin:28px 0 8px;border-bottom:2px solid #e6c9a8;padding-bottom:4px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:6px 8px;text-align:right}th{background:#f6efe6}.m{color:#666;font-size:14px}</style></head><body>
<h1>🐶 ${esc(DOG)} · דוח בריאות</h1><div class="m">נוצר ב-${fmtDate(now, tz)}</div>
<h2>פרטים</h2><table>
${row(['שם', esc(DOG)])}${row(['גזע', 'שיצו'])}${row(['מין', 'נקבה'])}
${row(['תאריך לידה', prof.birth ? `${fmtDate(+prof.birth, tz)} (בת ${esc(ageText(+prof.birth, now) || '')})` : '—'])}
${Object.entries(PROFILE_FIELDS).map(([k, l]) => row([esc(l), prof[k] ? esc(prof[k]) : '—'])).join('')}</table>
<h2>משקל</h2>${ws.length ? `<table><tr><th>תאריך</th><th>משקל</th></tr>${ws.map((w) => row([fmtDate(w.ts, tz), kg(w.grams)])).join('')}</table>` : '<p class="m">לא תועד.</p>'}
<h2>חיסונים וטיפולים שבוצעו</h2>${done.length ? `<table><tr><th>תאריך</th><th>סוג</th><th>מה</th><th>הערות</th></tr>${done.map((h) => row([fmtDate(h.at, tz), esc(kindLabel(h.kind)), esc(h.title), esc(h.notes || '')])).join('')}</table>` : '<p class="m">לא תועד.</p>'}
<h2>מועדים קרובים</h2>${due.length ? `<table><tr><th>מועד</th><th>סוג</th><th>מה</th></tr>${due.map((h) => row([fmtDate(h.next_due, tz), esc(kindLabel(h.kind)), esc(h.title)])).join('')}</table>` : '<p class="m">אין.</p>'}
<h2>תרופות פעילות</h2>${meds.length ? `<table><tr><th>תרופה</th><th>מינון</th><th>שעות</th></tr>${meds.map((m) => row([esc(m.name), esc(m.dose), esc(m.times)])).join('')}</table>` : '<p class="m">אין.</p>'}
<h2>14 הימים האחרונים</h2><table><tr><th>יום</th><th>יציאות בחוץ</th><th>תאונות בבית</th><th>ארוחות</th></tr>${[...days.entries()].map(([d, v]) => row([d, v.out, v.home, v.meal])).join('')}</table>
<p class="m">נוצר אוטומטית מבלבוט. המידע לתיעוד המשפחה ואינו תחליף לייעוץ וטרינרי.</p></body></html>`;
  return html;
}

/* ---------- ניתוב לחיצות ---------- */

const num = (s) => parseInt(s, 10);

// מחזיר { view, toast, alert, pend, doc }. pend: מצב המתנה להקלדה (ריק: מנקים).
export async function onBellCallback(env, data, user, now) {
  const tz = tzOf(env);
  const [, act, a1] = data.split(':');
  const admin = isAdmin(user);
  const needAdmin = () => ({ toast: 'זה רק לאמתי וריקי', alert: true });

  switch (act) {
    case 'hub':
      return { view: await hub(env, user, now) };
    case 'card':
      return { view: await card(env, user, now) };
    case 'bd':
      return admin ? { view: birthPicker() } : needAdmin();
    case 'bdw': {
      if (!admin) return needAdmin();
      const w = num(a1);
      if (!(w > 0 && w < 400)) return { toast: 'משהו השתבש', alert: true };
      await db.setProfileField(env, 'birth', startOfDay(now, tz) - w * 7 * DAY);
      return { view: await card(env, user, now), toast: 'נשמר' };
    }
    case 'bdt':
      return admin ? { view: askText('🎂 <b>תאריך לידה</b>', 'כתבו תאריך כמו 12.8.26'), pend: 'bp:birth' } : needAdmin();
    case 'e': {
      if (!admin) return needAdmin();
      if (!PROFILE_FIELDS[a1]) return { toast: 'משהו השתבש', alert: true };
      return { view: askText(`✏️ <b>${esc(PROFILE_FIELDS[a1])}</b>`, 'כתבו את הערך. כדי למחוק שלחו נקודה (.)'), pend: `bp:${a1}` };
    }
    case 'w':
      return { view: await weightView(env, now) };
    case 'wa':
      return { view: await weightAdd(env) };
    case 'ww':
      return { view: askText('⚖️ <b>משקל</b>', 'כתבו בקילו, למשל 2.4. אפשר גם תאריך: 2.4 12.10'), pend: 'bw' };
    case 'wn': {
      const g = num(a1);
      if (!(g >= 100 && g <= 20000)) return { toast: 'משהו השתבש', alert: true };
      await db.addWeight(env, now, g, user.member);
      return { view: await weightView(env, now, `נשמר: ${kg(g)}`), toast: '⚖️ נשמר' };
    }
    case 'wu': {
      const ok = await db.deleteLastWeight(env);
      return { view: await weightView(env, now, ok ? 'המשקל האחרון בוטל' : ''), toast: ok ? 'בוטל' : 'אין מה לבטל' };
    }
    case 'soc':
      return { view: await socialView(env) };
    case 'st': {
      const it = SOCIAL[num(a1)];
      if (!it) return { toast: 'משהו השתבש', alert: true };
      const cur = (await db.progressAll(env, 'social'))[it[0]];
      const next = cur && cur.level > 0 ? 0 : 1;
      await db.setProgress(env, 'social', it[0], next, next ? now : null, user.member);
      return { view: await socialView(env), toast: next ? '🎉 כל הכבוד לבל!' : 'בוטל' };
    }
    case 'cmd':
      return { view: await cmdView(env) };
    case 'ct': {
      const it = CMDS[num(a1)];
      if (!it) return { toast: 'משהו השתבש', alert: true };
      const cur = (await db.progressAll(env, 'cmd'))[it[0]];
      const next = ((cur ? cur.level : 0) + 1) % 4;
      await db.setProgress(env, 'cmd', it[0], next, now, user.member);
      return { view: await cmdView(env), toast: next === 3 ? '🌳 אמינה! כל הכבוד' : LEVELS[next] };
    }
    case 'ins':
      return { view: await insightsView(env, now) };
    case 'tip':
      return { view: tipView(num(a1) || 0, now) };
    case 'vt':
      return admin ? { view: await vaccineView(env, now) } : needAdmin();
    case 'vta':
    case 'vtd': {
      if (!admin) return needAdmin();
      const n = await applyVaccinePlan(env, act === 'vta' ? 'future' : 'past', user.member, now);
      return { view: await vaccineView(env, now), toast: n ? `נוספו ${n}` : 'אין מה להוסיף' };
    }
    case 'rep':
      if (!admin) return needAdmin();
      return { toast: 'שולח דוח...', doc: { name: `bell-report-${fmtDate(now, tz).replace(/\./g, '-')}.html`, html: await reportHtml(env, now), caption: `📄 דוח מלא של ${DOG}. אפשר לפתוח בדפדפן, להדפיס או להעביר לווטרינר.` } };
    default:
      return { view: await hub(env, user, now) };
  }
}

// הקלדה במצבי המתנה bp:<field> ו-bw
export async function onBellText(env, state, text, user, now) {
  const tz = tzOf(env);
  if (state === 'bw') {
    const r = parseWeight(text, now, tz);
    if (r.error) return { error: r.error };
    await db.addWeight(env, r.ts, r.grams, user.member);
    return { view: await weightView(env, now, `נשמר: ${kg(r.grams)}`) };
  }
  const field = state.slice(3);
  if (!isAdmin(user)) return { error: 'זה רק לאמתי וריקי' };
  if (field === 'birth') {
    const d = parseDate(text, now, tz);
    if (d === null || d > now || now - d > 20 * 365 * DAY) return { error: 'לא הבנתי. כתבו תאריך כמו 12.8.26' };
    await db.setProfileField(env, 'birth', d);
  } else if (PROFILE_FIELDS[field]) {
    const v = text.trim().slice(0, 80);
    await db.setProfileField(env, field, v === '.' ? null : v);
  } else return { error: 'משהו השתבש' };
  return { view: await card(env, user, now) };
}

