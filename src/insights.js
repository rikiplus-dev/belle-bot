// ניתוח הנתונים של בל: תאונות, שעות, וסף התזכורות שלומד מההיסטוריה.
import * as db from './db.js';
import { DEFAULTS } from './config.js';
import { esc } from './telegram.js';
import { parts, startOfDay } from './time.js';

const DAY = 86400000;
const MIN = 60000;
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

// כמה זמן אחרי ארוחה בל בדרך כלל יוצאת לעשות בחוץ (בדקות). ריק אם אין מספיק נתונים.
export function mealGaps(events) {
  const gaps = [];
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].kind !== 'meal') continue;
    const next = sorted.slice(i + 1).find((e) => e.kind === 'pee_out' || e.kind === 'poop_out');
    if (next && next.ts - sorted[i].ts <= 90 * MIN) gaps.push((next.ts - sorted[i].ts) / MIN);
  }
  return gaps;
}

export function analyze(events, now, tz) {
  const isOut = (k) => k === 'pee_out' || k === 'poop_out';
  const isHome = (k) => k === 'pee_home' || k === 'poop_home';
  const out = events.filter((e) => isOut(e.kind));
  const home = events.filter((e) => isHome(e.kind));
  const part = (ts) => {
    const h = parts(ts, tz).h;
    return h >= 6 && h < 11 ? 'morning' : h >= 11 && h < 16 ? 'noon' : h >= 16 && h < 21 ? 'evening' : 'night';
  };
  const byPart = { morning: 0, noon: 0, evening: 0, night: 0 };
  home.forEach((e) => byPart[part(e.ts)]++);
  const today = startOfDay(now, tz);
  const lastHome = home.length ? Math.max(...home.map((e) => e.ts)) : null;
  const firstEv = events.length ? Math.min(...events.map((e) => e.ts)) : null;
  const streak = lastHome ? Math.floor((today - startOfDay(lastHome, tz)) / DAY) : firstEv ? Math.floor((today - startOfDay(firstEv, tz)) / DAY) : 0;
  const wk = today - 6 * DAY;
  const prevWk = today - 13 * DAY;
  const cnt = (from, to) => ({
    out: events.filter((e) => e.ts >= from && e.ts < to && isOut(e.kind)).length,
    home: events.filter((e) => e.ts >= from && e.ts < to && isHome(e.kind)).length,
  });
  const gaps = mealGaps(events);
  return {
    out: out.length,
    home: home.length,
    outRate: out.length + home.length ? Math.round((out.length / (out.length + home.length)) * 100) : null,
    byPart,
    streak,
    neverHome: !lastHome,
    lastHome,
    week: cnt(wk, now + DAY),
    prevWeek: cnt(prevWk, wk),
    gapMedian: median(gaps),
    gapN: gaps.length,
  };
}

// זמני התזכורת בפועל: לפי מה שהוגדר ידנית (מספר), או אוטומטית (0 או לא הוגדר)
export async function effectiveThresholds(env, now) {
  const rawMeal = await db.getSetting(env, 'meal_nudge_min', 0);
  const rawInt = await db.getSetting(env, 'interval_min', 0);
  const out = { mealNudgeMin: rawMeal || DEFAULTS.mealNudgeMin, intervalMin: rawInt || DEFAULTS.intervalMin, mealAuto: !rawMeal, intervalAuto: !rawInt, why: {},
    sleepFrom: await db.getSetting(env, 'sleep_from', DEFAULTS.quietFrom), sleepTo: await db.getSetting(env, 'sleep_to', DEFAULTS.quietTo),
    meal1By: await db.getSetting(env, 'meal1_by', 10), meal2By: await db.getSetting(env, 'meal2_by', 20) };
  if (!rawMeal) {
    const events = await db.eventsBetween(env, now - 30 * DAY, now);
    const gaps = mealGaps(events);
    if (gaps.length >= 6) {
      const m = median(gaps);
      out.mealNudgeMin = Math.min(40, Math.max(10, Math.round((m * 0.7) / 5) * 5));
      out.why.meal = `לפי ${gaps.length} ארוחות: בל בדרך כלל יוצאת כ-${Math.round(m)} דק׳ אחרי אוכל`;
    }
  }
  if (!rawInt) {
    const prof = await db.getProfile(env);
    if (prof.birth) {
      const months = (now - +prof.birth) / (30.44 * DAY);
      out.intervalMin = Math.min(240, Math.max(90, Math.round((months * 60) / 15) * 15));
      out.why.interval = 'לפי הגיל: בערך שעה לכל חודש';
    }
  }
  return out;
}

const bar = (n, max) => '▮'.repeat(max ? Math.max(n ? 1 : 0, Math.round((n / max) * 8)) : 0);

export async function insightsView(env, now) {
  const tz = env.TZ || 'Asia/Jerusalem';
  const events = await db.eventsBetween(env, now - 30 * DAY, now);
  const a = analyze(events, now, tz);
  const t = await effectiveThresholds(env, now);
  const lines = ['📈 <b>מה הנתונים אומרים</b>', '<i>30 הימים האחרונים</i>', ''];
  if (!events.length) {
    lines.push('עוד אין מספיק נתונים. אחרי כמה ימים של תיעוד יופיעו כאן תובנות.');
  } else {
    lines.push(`🌳 הצלחות בחוץ: <b>${a.outRate === null ? '-' : a.outRate + '%'}</b> (${a.out} בחוץ, ${a.home} בבית)`);
    lines.push(a.neverHome ? `🏆 עוד לא הייתה תאונה בבית בתקופה הזאת!` : a.streak === 0 ? '🏠 היום כבר הייתה תאונה. מחר מתחילים רצף חדש.' : `🏆 רצף בלי תאונה בבית: <b>${a.streak}</b> ${a.streak === 1 ? 'יום' : 'ימים'}`);
    const dw = a.week.out - a.prevWeek.out;
    lines.push('', `<b>השבוע מול הקודם</b>`, `בחוץ ${a.week.out} (קודם ${a.prevWeek.out}) · בבית ${a.week.home} (קודם ${a.prevWeek.home})`);
    if (a.week.home < a.prevWeek.home) lines.push('📉 פחות תאונות מהשבוע שעבר. כל הכבוד!');
    else if (dw > 0 && a.week.home === a.prevWeek.home) lines.push('📈 יותר יציאות מוצלחות מהשבוע שעבר.');
    if (a.home) {
      const max = Math.max(...Object.values(a.byPart));
      const L = { morning: 'בוקר 06-11', noon: 'צהריים 11-16', evening: 'ערב 16-21', night: 'לילה 21-06' };
      lines.push('', '<b>מתי קורות תאונות בבית</b>');
      for (const k of ['morning', 'noon', 'evening', 'night']) lines.push(`${L[k]}  ${bar(a.byPart[k], max)} ${a.byPart[k]}`);
      const worst = Object.entries(a.byPart).sort((x, y) => y[1] - x[1])[0];
      if (worst[1] >= 2) lines.push(`💡 כדאי להקפיד על יציאות לפני ה${{ morning: 'בוקר', noon: 'צהריים', evening: 'ערב', night: 'לילה' }[worst[0]]}.`);
    }
    if (a.gapN >= 6) lines.push('', `🍽 אחרי ארוחה בל יוצאת בדרך כלל אחרי <b>${Math.round(a.gapMedian)} דק׳</b> (לפי ${a.gapN} ארוחות)`);
  }
  lines.push('', '<b>התזכורות</b>');
  lines.push(`אחרי ארוחה: ${t.mealNudgeMin} דק׳${t.mealAuto ? ' (אוטומטי)' : ''}${t.why.meal ? `\n<i>${esc(t.why.meal)}</i>` : ''}`);
  lines.push(`בלי יציאה: כל ${Math.floor(t.intervalMin / 60)} שע׳${t.intervalMin % 60 ? ` ו-${t.intervalMin % 60} דק׳` : ''}${t.intervalAuto ? ' (אוטומטי)' : ''}${t.why.interval ? `\n<i>${esc(t.why.interval)}</i>` : ''}`);
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: [[{ text: '⬅️ חזרה', callback_data: 'b:hub' }]] } };
}

// מילים חגיגיות לרצף ימים בלי תאונה
export const STREAK_MILESTONES = [3, 7, 14, 30, 60, 100];
