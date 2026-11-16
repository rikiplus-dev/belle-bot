// מה שהבוט מציג: טקסטים ומקלדות. הכול בעברית.
import * as db from './db.js';
import { DOG, MEMBERS, MEMBER_BY_ID, KINDS, MEAL_NUDGE_OPTIONS, INTERVAL_OPTIONS } from './config.js';
import { esc } from './telegram.js';
import { dateLine, dur, ago, hhmm, startOfDay, startOfWeek } from './time.js';

const tzOf = (env) => env.TZ || 'Asia/Jerusalem';
const name = (id) => (MEMBER_BY_ID[id] ? MEMBER_BY_ID[id].name : 'מישהו/י');
const btn = (text, data) => ({ text, callback_data: data });

/* ---------- הלוח הראשי ---------- */

export async function panel(env, user, { notice = '', isPrivate = true, origin = '' } = {}) {
  const now = Date.now();
  const tz = tzOf(env);
  const [sum, home, walk] = await Promise.all([db.todaySummary(env, now, tz), db.lastHome(env), db.activeWalk(env)]);

  const lines = [`🐶 <b>${esc(DOG)}</b> · ${dateLine(now, tz)}`];
  if (notice) lines.push(`<i>${esc(notice)}</i>`);
  lines.push('');
  lines.push(`<b>היום</b>  🌳 בחוץ <b>${sum.out}</b>  ·  🏠 בבית <b>${sum.home}</b>  ·  🍽 <b>${sum.meal}</b>`);
  if (home) lines.push(`⚠️ תאונה אחרונה בבית: ${ago(home.ts, now)}`);
  else lines.push('✅ עדיין אין תאונות בבית');

  if (walk) {
    const c = await db.walkCounts(env, walk.id);
    lines.push('');
    lines.push(`🚶 <b>בטיול עכשיו</b> · ${esc(name(walk.member))} · ${dur(now - walk.started_at)}`);
    lines.push(`💧 ${c.pee_out}   💩 ${c.poop_out}`);
  }

  const rows = [];
  if (walk) {
    rows.push([btn('💧 פיפי בחוץ', 'a:pee_out'), btn('💩 קקי בחוץ', 'a:poop_out')]);
    rows.push([btn('🏁 חזרנו הביתה', 'a:walk_end')]);
  } else {
    rows.push([btn('🚶 יוצאים לטיול', 'a:walk_start')]);
  }
  rows.push([btn('🏠 פיפי בבית', 'a:pee_home'), btn('🏠 קקי בבית', 'a:poop_home')]);
  rows.push([btn('🍽 בל אכלה', 'a:meal'), btn('👩‍🍳 הכנתי אוכל', 'a:cook')]);
  rows.push([btn('⭐ כוכבים', 'm:stars'), btn('📋 היום', 'm:today'), btn('↩️ ביטול', 'm:undo')]);
  const last = [];
  if (isPrivate && origin) last.push({ text: '📊 לוח בקרה', web_app: { url: origin } });
  last.push(btn('⚙️ הגדרות', 'm:settings'));
  rows.push(last);

  return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

const back = [[btn('⬅️ חזרה', 'm:menu')]];

/* ---------- כוכבים ---------- */

const MEDALS = ['🥇', '🥈', '🥉'];
const bar = (n, max) => {
  const filled = max ? Math.round((n / max) * 8) : 0;
  return '▰'.repeat(filled) + '▱'.repeat(8 - filled);
};

export async function starsView(env) {
  const now = Date.now();
  const tz = tzOf(env);
  const week = await db.stars(env, startOfWeek(now, tz));
  const all = await db.stars(env, 0);
  const ranked = MEMBERS.map((m) => ({ m, s: week[m.id] })).sort((a, b) => b.s.total - a.s.total);
  const max = Math.max(1, ...ranked.map((r) => r.s.total));
  const lines = ['⭐ <b>כוכבים השבוע</b>', '<i>השבוע מתחיל ביום ראשון</i>', ''];
  ranked.forEach((r, i) => {
    const medal = r.s.total > 0 && i < 3 ? MEDALS[i] : '▫️';
    lines.push(`${medal} ${esc(r.m.name)}  ⭐ <b>${r.s.total}</b>  ${bar(r.s.total, max)}`);
  });
  lines.push('');
  lines.push('<b>מאז ההתחלה</b>');
  lines.push(
    MEMBERS.map((m) => `${esc(m.name)} ${all[m.id].total}`).join(' · '),
  );
  lines.push('');
  lines.push('<i>כוכב על: טיול שהסתיים, פיפי או קקי בחוץ, והכנת אוכל</i>');
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: back } };
}

/* ---------- היום ---------- */

export async function todayView(env) {
  const now = Date.now();
  const tz = tzOf(env);
  const since = startOfDay(now, tz);
  const [events, walks] = await Promise.all([db.eventsSince(env, since), db.walksSince(env, since)]);
  const items = [];
  for (const w of walks) {
    const inside = events.filter((e) => e.walk_id === w.id);
    const pee = inside.filter((e) => e.kind === 'pee_out').length;
    const poop = inside.filter((e) => e.kind === 'poop_out').length;
    const bits = [pee ? `💧${pee}` : '', poop ? `💩${poop}` : ''].filter(Boolean).join(' ');
    const end = w.ended_at ? `${dur(w.ended_at - w.started_at)}` : 'בטיול עכשיו';
    items.push({ ts: w.started_at, line: `${hhmm(w.started_at, tz)} 🚶 טיול · ${esc(name(w.member))} · ${end}${bits ? ' · ' + bits : ''}` });
  }
  for (const e of events) {
    if (e.walk_id) continue;
    const k = KINDS[e.kind];
    if (!k) continue;
    items.push({ ts: e.ts, line: `${hhmm(e.ts, tz)} ${k.emoji} ${k.label} · ${esc(name(e.member))}` });
  }
  items.sort((a, b) => a.ts - b.ts);
  const lines = ['📋 <b>היום</b>', ''];
  if (!items.length) lines.push('עדיין לא תועד כלום היום.');
  for (const it of items.slice(-25)) lines.push(it.line);
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: back } };
}

/* ---------- הגדרות ---------- */

export async function settingsView(env, user) {
  const t = await db.thresholds(env);
  const onoff = (v) => (v ? 'פעיל ✅' : 'כבוי ❌');
  const text = [
    '⚙️ <b>הגדרות</b>',
    '',
    `<b>שלך (${esc(name(user.member))})</b>`,
    `תזכורות אילוף: ${onoff(user.notify)}`,
    `הודעות על טיולים של אחרים: ${onoff(user.notify_activity)}`,
    '',
    '<b>לכל הבית</b>',
    `תזכורת אחרי ארוחה: ${t.mealNudgeMin} דק׳`,
    `תזכורת אם לא יצאו: כל ${dur(t.intervalMin * 60000)}`,
    '',
    '<i>תזכורות לא נשלחות בין 22:00 ל-07:00</i>',
  ].join('\n');
  const kb = [
    [btn(`תזכורות: ${user.notify ? 'כבה' : 'הפעל'}`, 's:notify')],
    [btn(`הודעות על טיולים: ${user.notify_activity ? 'כבה' : 'הפעל'}`, 's:activity')],
    [btn(`אחרי ארוחה: ${t.mealNudgeMin} דק׳ ⟳`, 's:meal')],
    [btn(`אם לא יצאו: ${dur(t.intervalMin * 60000)} ⟳`, 's:interval')],
    [btn('⬅️ חזרה', 'm:menu')],
  ];
  return { text, reply_markup: { inline_keyboard: kb } };
}

export const nextOption = (options, current) => options[(Math.max(0, options.indexOf(current)) + 1) % options.length];
export { MEAL_NUDGE_OPTIONS, INTERVAL_OPTIONS };

/* ---------- הצטרפות ועזרה ---------- */

export const askCodeText = `👋 היי! זה בלבוט, העוזר של המשפחה לאילוף של ${DOG} 🐶\n\nכדי להצטרף, שלחו כאן את <b>קוד המשפחה</b>.`;

export function memberPicker() {
  const rows = [];
  for (let i = 0; i < MEMBERS.length; i += 2) {
    rows.push(MEMBERS.slice(i, i + 2).map((m) => btn(m.name, `reg:${m.id}`)));
  }
  return {
    text: '✅ הקוד נכון! מי אתם?\nהבחירה קובעת על שם מי יירשמו הכוכבים.',
    reply_markup: { inline_keyboard: rows },
  };
}

export const helpText = [
  `🐶 <b>בלבוט: אילוף ${DOG}</b>`,
  '',
  'הכול דרך הלחצנים. שולחים /menu ומקבלים לוח:',
  '• 🚶 <b>יוצאים לטיול</b> פותח טיול. בתוכו מתעדים 💧 פיפי ו-💩 קקי בחוץ, והם נשמרים בטיול הזה.',
  '• 🏁 <b>חזרנו</b> סוגר את הטיול ונותן כוכב.',
  '• 🏠 פיפי או קקי <b>בבית</b> לא מורידים כוכבים, הם עוזרים לראות מתי זה קורה.',
  '• 🍽 אכלה, 👩‍🍳 הכנתי אוכל.',
  '• ↩️ ביטול מבטל את הפעולה האחרונה שלך (עד 15 דקות).',
  '',
  'אפשר גם לכתוב "פיפי" או "קקי" והבוט ישאל איפה.',
  '',
  '<b>פקודות</b>',
  '/menu לוח ראשי · /walk התחלת טיול · /stars כוכבים',
  '/today מה היה היום · /settings הגדרות · /help העזרה הזאת',
].join('\n');

/* ---------- הודעות אוטומטיות ---------- */

export function walkStartedText(who) {
  return `🚶 טיול עם ${DOG} התחיל · ${esc(name(who))}`;
}

export function walkEndedText(r) {
  return `🏁 ${DOG} חזרה · ${esc(name(r.walker))} · ${r.took} · ${r.summary} · ⭐ +1`;
}

export async function weeklyText(env, now) {
  const tz = tzOf(env);
  const thisWeek = startOfWeek(now, tz);
  const prevWeek = startOfWeek(thisWeek - 86400000, tz);
  const st = await db.stars(env, prevWeek, thisWeek);
  const ranked = MEMBERS.map((m) => ({ m, s: st[m.id] })).sort((a, b) => b.s.total - a.s.total);
  const ev = await db.eventsSince(env, prevWeek, 2000);
  const inWeek = ev.filter((e) => e.ts < thisWeek);
  const out = inWeek.filter((e) => e.kind === 'pee_out' || e.kind === 'poop_out').length;
  const home = inWeek.filter((e) => e.kind === 'pee_home' || e.kind === 'poop_home').length;
  const lines = [`🌟 <b>סיכום שבועי · ${DOG}</b>`, ''];
  const top = ranked[0];
  if (top && top.s.total > 0) lines.push(`🥇 הכוכב/ת של השבוע: <b>${esc(top.m.name)}</b> עם ⭐ ${top.s.total}`);
  else lines.push('השבוע שעבר עבר בלי כוכבים. השבוע הזה מתחיל מאפס!');
  lines.push('');
  ranked.forEach((r) => lines.push(`${esc(r.m.name)}  ⭐ ${r.s.total}`));
  lines.push('');
  const tot = out + home;
  if (tot) lines.push(`🌳 בחוץ ${out}  ·  🏠 בבית ${home}  (${Math.round((out / tot) * 100)}% בחוץ)`);
  return lines.join('\n');
}
