// פענוח טקסט חופשי שבני הבית מקלידים: תאריכים, משכי זמן, שעות, שורות תרופה ואירוע רפואי.
import { startOfDay, parts, minutesAgoFromClock } from './time.js';

const DAY = 86400000;
const norm = (s) => String(s || '').replace(/[״"]/g, '"').replace(/\s+/g, ' ').trim();

// "12.11", "12/11/26", "12.11.2026" -> תחילת אותו יום. ללא שנה: השנה הנוכחית (או הקודמת אם זה עתידי רחוק)
export function parseDate(text, now, tz) {
  const m = norm(text).match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2}|\d{4}))?$/);
  if (!m) return null;
  const d = +m[1];
  const mo = +m[2];
  let y = m[3] ? +m[3] : parts(now, tz).y;
  if (m[3] && m[3].length === 2) y += 2000;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const probe = new Date(Date.UTC(y, mo - 1, d, 12));
  if (probe.getUTCMonth() !== mo - 1) return null;
  return startOfDay(probe.getTime(), tz);
}

// "3 שבועות", "שנה", "חודשיים", "10 ימים" -> { days } או { months }
export function parseSpan(text) {
  const t = norm(text).replace(/^בעוד\s+/, '').replace(/^עוד\s+/, '');
  if (/^(שבועיים)$/.test(t)) return { days: 14 };
  if (/^(חודשיים)$/.test(t)) return { months: 2 };
  if (/^(שנתיים)$/.test(t)) return { months: 24 };
  if (/^יומיים$/.test(t)) return { days: 2 };
  const m = t.match(/^(\d{1,3})?\s*(יום|ימים|שבוע|שבועות|חודש|חודשים|שנה|שנים)$/);
  if (!m) return null;
  const n = m[1] ? +m[1] : 1;
  if (n < 1) return null;
  const u = m[2];
  if (u === 'יום' || u === 'ימים') return { days: n };
  if (u === 'שבוע' || u === 'שבועות') return { days: n * 7 };
  if (u === 'חודש' || u === 'חודשים') return { months: n };
  return { months: n * 12 };
}

export function addSpan(ts, span, tz) {
  if (span.days) return startOfDay(ts + span.days * DAY + 12 * 3600000, tz);
  const p = parts(ts, tz);
  const probe = new Date(Date.UTC(p.y, p.m - 1 + span.months, p.d, 12));
  return startOfDay(probe.getTime(), tz);
}

// "8:00 20:00", "08:00, 20.30" -> ['08:00','20:00']
export function parseTimes(text) {
  const found = [...norm(text).matchAll(/(\d{1,2})[:.](\d{2})/g)];
  const out = [];
  for (const f of found) {
    const h = +f[1];
    const mi = +f[2];
    if (h > 23 || mi > 59) return null;
    out.push(`${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`);
  }
  const uniq = [...new Set(out)].sort();
  return uniq.length && uniq.length <= 6 ? uniq : null;
}

// "שם | מינון | שעות | כמה זמן (לא חובה)"
export function parseMedLine(text, now, tz) {
  const f = norm(text).split(/\s*[|;]\s*/);
  if (f.length < 3) return { error: 'צריך לפחות שלושה חלקים: שם | מינון | שעות' };
  const [name, dose] = f;
  if (!name || !dose) return { error: 'חסר שם או מינון' };
  if (name.length > 60 || dose.length > 80) return { error: 'הטקסט ארוך מדי' };
  const times = parseTimes(f[2]);
  if (!times) return { error: 'לא הבנתי את השעות. כתבו למשל 08:00 20:00' };
  let end = null;
  if (f[3]) {
    const s = parseSpan(f[3]);
    if (!s) return { error: 'לא הבנתי כמה זמן. כתבו למשל 7 ימים או 3 שבועות, או השאירו ריק לתרופה קבועה' };
    end = addSpan(startOfDay(now, tz), s, tz);
  }
  return { name, dose, times, end };
}

// "כלבת | 12.11 | שנה | הערה". כל חלק אחרי הראשון אופציונלי.
export function parseHealthLine(text, now, tz) {
  const f = norm(text).split(/\s*[|;]\s*/).filter(Boolean);
  if (!f.length) return { error: 'כתבו לפחות תיאור קצר' };
  const title = f[0];
  if (title.length > 80) return { error: 'התיאור ארוך מדי' };
  let at = null;
  let due = null;
  let span = null;
  const notes = [];
  for (const part of f.slice(1)) {
    const d = parseDate(part, now, tz);
    if (d !== null) {
      if (at === null) at = d;
      else if (due === null) due = d;
      continue;
    }
    const s = parseSpan(part);
    if (s && !span) {
      span = s;
      continue;
    }
    notes.push(part);
  }
  if (at === null) at = startOfDay(now, tz);
  if (due === null && span) due = addSpan(at, span, tz);
  if (due !== null && due <= at) return { error: 'מועד החזרה צריך להיות אחרי תאריך האירוע' };
  return { title, at, due, notes: notes.join(' · ') || null };
}

/* ---------- טקסט חופשי: "פיפי בבית לפני חצי שעה", "בל אכלה", "יצאנו לטיול" ---------- */

// כמה דקות אחורה מוזכרות בטקסט? null אם לא הוזכר זמן.
export function parseWhen(text, now, tz) {
  const t = norm(text);
  if (/לפני\s+(חצי שעה)/.test(t)) return 30;
  if (/לפני\s+רבע שעה/.test(t)) return 15;
  if (/לפני\s+שעתיים/.test(t)) return 120;
  if (/לפני\s+שעה(?!\s*\d)/.test(t)) return 60;
  let m = t.match(/לפני\s+(\d{1,3})\s*(דקות|דקה|דק|ד)/);
  if (m) return +m[1];
  m = t.match(/לפני\s+(\d{1,2})\s*(שעות|שעה|שע)/);
  if (m) return +m[1] * 60;
  m = t.match(/(?:ב|בשעה\s+|ב-)(\d{1,2})[:.](\d{2})\b/) || t.match(/\bב\s*(\d{1,2})[:.](\d{2})\b/);
  if (m && +m[1] < 24 && +m[2] < 60) return minutesAgoFromClock(+m[1], +m[2], now, tz);
  return null;
}

// מזהה כוונה פשוטה בהודעה חופשית. מחזיר null אם לא הבין.
export function parseFreeText(text, now, tz) {
  const t = norm(text);
  if (!t || t.length > 120) return null;
  const minAgo = parseWhen(t, now, tz);
  if (/מותר|אפשר לתת|אפשר לאכול|יכולה לאכול|יכולה לקבל/.test(t) && !/פיפי|קקי/.test(t)) return { intent: 'food' };
  if (/^(חזרנו|חזרתי|חזרה|סיימנו|סיימתי)(\s|$)/.test(t) && !/פיפי|קקי/.test(t)) return { intent: 'walk_end' };
  if (/^(יצאנו|יוצאים|יצאתי|יוצאת|יוצא|התחלנו)(\s|$)/.test(t) && /טיול|החוצה|עם בל|הולכים|הליכה/.test(t)) return { intent: 'walk_start' };
  if (/^הכנתי\s+(אוכל|ארוחה)/.test(t)) return { intent: 'event', kinds: ['cook'], where: null, minAgo };
  if (/אכלה|האכלתי|נתתי (לה )?(לאכול|אוכל)|ארוחה/.test(t) && !/פיפי|קקי/.test(t)) return { intent: 'event', kinds: ['meal'], where: null, minAgo };
  const pee = /פיפי|השתינה/.test(t);
  const poop = /קקי|עשתה צרכים|צרכים/.test(t);
  if (pee || poop) {
    const where = /בבית|בסלון|במטבח|בחדר|על השטיח|תאונה/.test(t) ? 'home' : /בחוץ|בגינה|בטיול|ברחוב|בחצר/.test(t) ? 'out' : null;
    return { intent: 'event', kinds: [pee ? 'pee' : null, poop ? 'poop' : null].filter(Boolean), where, minAgo };
  }
  return null;
}
