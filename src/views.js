// מה שהבוט מציג: טקסטים ומקלדות. הכול בעברית.
import * as db from './db.js';
import { isAdmin, CHEERS, DOG, MEMBERS, MEMBER_BY_ID, KINDS, MEAL_NUDGE_OPTIONS, INTERVAL_OPTIONS, LATE_OFFSETS, LATE_WALK_DURS } from './config.js';
import { esc } from './telegram.js';
import { dateLine, dur, ago, hhmm, startOfDay, startOfWeek } from './time.js';
import { onDutyMembers, daysText, clock } from './duty.js';

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
  rows.push([btn('🕐 שכחתי לעדכן', 'm:late'), btn('💌 עידוד', 'c:home')]);
  const last = [];
  if (isPrivate && origin) last.push({ text: '📊 לוח בקרה', web_app: { url: origin } });
  if (isAdmin(user)) {
    rows.push([btn('🩺 בריאות', 'h:home'), btn('⚙️ הגדרות', 'm:settings')]);
  }
  if (last.length) rows.push(last);

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

export const adminOnly = {
  text: '⚙️ ההגדרות והבריאות מנוהלות על ידי אמתי וריקי.',
  reply_markup: { inline_keyboard: [[btn('⬅️ חזרה', 'm:menu')]] },
};

export async function settingsView(env, user) {
  const t = await db.thresholds(env);
  const duty = await db.listDuty(env);
  const nowOn = onDutyMembers(duty, Date.now(), tzOf(env));
  const dutyLines = ['<b>📅 שעות אחריות</b>', '<i>בשעות האלה רק מי שבאחריות מקבל תזכורות אילוף, עד שהוא מוציא את בל</i>'];
  if (!duty.length) dutyLines.push('עוד לא הוגדרו. התזכורות מגיעות לכולם.');
  for (const d of duty) dutyLines.push(`• ${esc(name(d.member))} · ${daysText(d.days)} · ${clock(d.start_min)}-${clock(d.end_min)}`);
  dutyLines.push(nowOn.length ? `עכשיו באחריות: <b>${nowOn.map((m) => esc(name(m))).join(', ')}</b>` : 'עכשיו אין מי שבאחריות, אז התזכורות מגיעות לכולם.');
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
    '',
    ...dutyLines,
  ].join('\n');
  const kb = [
    [btn(`תזכורות: ${user.notify ? 'כבה' : 'הפעל'}`, 's:notify')],
    [btn(`הודעות על טיולים: ${user.notify_activity ? 'כבה' : 'הפעל'}`, 's:activity')],
    [btn(`אחרי ארוחה: ${t.mealNudgeMin} דק׳ ⟳`, 's:meal')],
    [btn(`אם לא יצאו: ${dur(t.intervalMin * 60000)} ⟳`, 's:interval')],
    ...duty.slice(0, 8).map((d) => [btn(`🗑 ${name(d.member)} · ${daysText(d.days)} · ${clock(d.start_min)}-${clock(d.end_min)}`, `s:dd:${d.id}`)]),
    [btn('➕ הוספת שעות אחריות', 's:da')],
    [btn('⬅️ חזרה', 'm:menu')],
  ];
  return { text, reply_markup: { inline_keyboard: kb } };
}

export const nextOption = (options, current) => options[(Math.max(0, options.indexOf(current)) + 1) % options.length];
export { MEAL_NUDGE_OPTIONS, INTERVAL_OPTIONS };

/* ---------- עדכון אחורה ---------- */

const pairs = (arr) => {
  const rows = [];
  for (let i = 0; i < arr.length; i += 2) rows.push(arr.slice(i, i + 2));
  return rows;
};
const nextMember = (id) => MEMBERS[(MEMBERS.findIndex((m) => m.id === id) + 1) % MEMBERS.length].id;
const lateBack = [btn('⬅️ חזרה', 'm:late')];

export function lateStart(who) {
  return {
    text: `🕐 <b>שכחתם לעדכן?</b>
מה קרה? אפשר להוסיף עד יממה אחורה.

עבור: <b>${esc(name(who))}</b>`,
    reply_markup: {
      inline_keyboard: [
        [btn('🚶 טיול שהיה', `lk:${who}:walk`)],
        [btn('🏠 פיפי בבית', `lk:${who}:pee_home`), btn('🏠 קקי בבית', `lk:${who}:poop_home`)],
        [btn('🍽 בל אכלה', `lk:${who}:meal`), btn('👩‍🍳 הכנת אוכל', `lk:${who}:cook`)],
        [btn(`👤 מי עשה: ${name(who)} ⟳`, `lw:${nextMember(who)}`)],
        [btn('⬅️ חזרה', 'm:menu')],
      ],
    },
  };
}

export function lateWhen(who, kind) {
  const label = kind === 'walk' ? '🚶 טיול' : `${KINDS[kind].emoji} ${KINDS[kind].label}`;
  const word = kind === 'walk' ? 'יצאו' : 'זה היה';
  const rows = pairs(LATE_OFFSETS.map((m) => btn(`לפני ${dur(m * 60000)}`, `lt:${who}:${kind}:${m}`)));
  rows.push([btn('⌨️ שעה מדויקת', `lx:${who}:${kind}`)]);
  rows.push(lateBack);
  return { text: `${label} · ${esc(name(who))}
מתי ${word}?`, reply_markup: { inline_keyboard: rows } };
}

export const lateTimePrompt = (who, kind) => ({
  text: `⌨️ שלחו את השעה כאן בהודעה, למשל <b>14:30</b>.
אם השעה עוד לא הגיעה היום, נניח שהכוונה לאתמול.`,
  reply_markup: { inline_keyboard: [lateBack] },
});

export function lateDur(who, off) {
  const rows = pairs(LATE_WALK_DURS.map((d) => btn(dur(d * 60000), `ld:${who}:${off}:${d}`)));
  rows.push(lateBack);
  return { text: `🚶 כמה זמן נמשך הטיול?`, reply_markup: { inline_keyboard: rows } };
}

export function lateWalkBuilder(who, off, d, pee, poop) {
  const key = (p, q) => `lb:${who}:${off}:${d}:${p}:${q}`;
  return {
    text: `🚶 <b>טיול שהיה</b> · ${esc(name(who))} · ${dur(d * 60000)}

מה היה בטיול?
💧 פיפי <b>${pee}</b>   💩 קקי <b>${poop}</b>`,
    reply_markup: {
      inline_keyboard: [
        [btn('💧 +1', key(Math.min(5, pee + 1), poop)), btn('💩 +1', key(pee, Math.min(5, poop + 1)))],
        [btn('🔄 איפוס', key(0, 0)), btn('✅ שמירה', `ls:${who}:${off}:${d}:${pee}:${poop}`)],
        lateBack,
      ],
    },
  };
}

export const dutyPrompt = () => ({
  text: [
    '📅 <b>שעות אחריות</b>',
    '',
    'שלחו הודעה אחת בפורמט:',
    '<code>שם | ימים | שעות</code>',
    '',
    'ימים: <code>א-ה</code>, <code>כל יום</code>, <code>סופש</code> או אותיות מופרדות כמו <code>א,ג,ה</code>',
    'שעות: <code>14:00-18:00</code>. אם הסיום קטן מההתחלה זה נמשך עד הבוקר.',
    '',
    'למשל:',
    '<code>שולי | א-ה | 14:00-18:00</code>',
    '<code>ריקי | כל יום | 20:00-07:00</code>',
  ].join('\n'),
  reply_markup: { inline_keyboard: [[btn('⬅️ חזרה', 'm:settings')]] },
});

/* ---------- עידוד וסטיקרים ---------- */

export function cheerPick(user) {
  const others = MEMBERS.filter((m) => m.id !== user.member);
  const rows = [];
  for (let i = 0; i < others.length; i += 2) rows.push(others.slice(i, i + 2).map((m) => btn(m.name, `c:to:${m.id}`)));
  rows.push([btn('👨‍👩‍👧‍👦 לכולם', 'c:to:all')]);
  rows.push([btn('⬅️ חזרה', 'm:menu')]);
  return { text: '💌 <b>עידוד</b>\nלמי לשלוח?', reply_markup: { inline_keyboard: rows } };
}

export function cheerCompose(to) {
  const who = to === 'all' ? 'כולם' : name(to);
  const rows = [];
  for (let i = 0; i < CHEERS.length; i += 2) rows.push(CHEERS.slice(i, i + 2).map((c, k) => btn(c, `c:p:${to}:${i + k}`)));
  rows.push([btn('⬅️ חזרה', 'c:home')]);
  return {
    text: `💌 <b>עידוד ל${esc(who)}</b>\n\nלוחצים על הודעה מוכנה, או שולחים לי כאן <b>הודעה משלכם</b> או <b>סטיקר</b> והם יגיעו אליהם.`,
    reply_markup: { inline_keyboard: rows },
  };
}

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
  '• 🩺 <b>בריאות</b> (לאמתי וריקי): תרופות עם תזכורות, יומן רפואי ומועדי חיסונים.',
  '• 💌 <b>עידוד</b> שולח הודעה מוכנה, הודעה חופשית או סטיקר לבן בית או לכולם.',
  '• 🕐 <b>שכחתי לעדכן</b> מוסיף אחורה טיול, פיפי/קקי בבית או אוכל, עד יממה אחורה, וגם על שם מישהו אחר.',
  '',
  'אפשר גם לכתוב "פיפי" או "קקי" והבוט ישאל איפה.',
  '',
  '<b>פקודות</b>',
  '/menu לוח ראשי · /walk התחלת טיול · /stars כוכבים',
  '/today מה היה היום · /late עדכון אחורה · /cheer עידוד · /settings הגדרות · /help העזרה הזאת',
].join('\n');

/* ---------- הודעות אוטומטיות ---------- */

const takeOut = (id) => {
  const g = MEMBER_BY_ID[id]?.g;
  return g === 'f' ? 'הוציאה' : g === 'm' ? 'הוציא' : null;
};

const num = (n, w) => (n > 1 ? `${w} ×${n}` : w);

// "עשתה קקי, לא פיפי"
export function outcomeText(c) {
  const pee = c.pee_out || 0;
  const poop = c.poop_out || 0;
  if (pee && poop) return `עשתה ${num(pee, 'פיפי')} ו${num(poop, 'קקי')}`;
  if (pee) return `עשתה ${num(pee, 'פיפי')}, לא קקי`;
  if (poop) return `עשתה ${num(poop, 'קקי')}, לא פיפי`;
  return 'בלי פיפי וקקי הפעם';
}

export function walkStartedText(who) {
  const verb = takeOut(who);
  return verb ? `🚶 ${esc(name(who))} ${verb} את ${DOG} לטיול` : `🚶 ${DOG} יצאה לטיול עם ${esc(name(who))}`;
}

export function walkEndedText(r) {
  const verb = takeOut(r.walker);
  const head = verb ? `🏁 ${esc(name(r.walker))} ${verb} את ${DOG} לטיול · ${r.took}` : `🏁 ${DOG} חזרה מטיול עם ${esc(name(r.walker))} · ${r.took}`;
  return `${head}\n${DOG} ${outcomeText(r.counts || {})} · ⭐ +1`;
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
