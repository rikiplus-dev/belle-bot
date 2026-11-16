// שעות אחריות: מי "תורן" עכשיו. אין כאן גישה למסד, כדי שאפשר יהיה לבדוק.
import { MEMBERS } from './config.js';
import { parts } from './time.js';

const LETTERS = 'אבגדהוש'; // ראשון עד שבת
const pad = (n) => String(n).padStart(2, '0');
export const clock = (min) => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;

// "א-ה", "א,ג,ה", "כל יום", "סופש", "חול" -> [0..6] או null
export function parseDays(text) {
  const t = String(text || '').replace(/[׳']/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (/^(כל יום|כל הימים|יום יום|כולם)$/.test(t)) return [0, 1, 2, 3, 4, 5, 6];
  if (/^(סופ"?ש|סופש|סוף שבוע)$/.test(t)) return [5, 6];
  if (/^(חול|ימי חול|ימות השבוע)$/.test(t)) return [0, 1, 2, 3, 4];
  const set = new Set();
  const range = t.match(/^([אבגדהוש])\s*[-–]\s*([אבגדהוש])$/);
  if (range) {
    let a = LETTERS.indexOf(range[1]);
    const b = LETTERS.indexOf(range[2]);
    for (let i = 0; i < 7; i++) {
      set.add(a);
      if (a === b) break;
      a = (a + 1) % 7;
    }
    return [...set].sort();
  }
  const letters = t.split(/[\s,]+/).filter(Boolean);
  if (!letters.length || !letters.every((l) => l.length === 1 && LETTERS.includes(l))) return null;
  for (const l of letters) set.add(LETTERS.indexOf(l));
  return [...set].sort();
}

// "14:00-18:00" -> [840, 1080]
export function parseRange(text) {
  const m = String(text || '').match(/^(\d{1,2})[:.](\d{2})\s*[-–]\s*(\d{1,2})[:.](\d{2})$/);
  if (!m) return null;
  const [a, b, c, d] = m.slice(1).map(Number);
  if (a > 23 || c > 23 || b > 59 || d > 59) return null;
  const s = a * 60 + b;
  const e = c * 60 + d;
  if (s === e) return null;
  return [s, e];
}

// "שולי | א-ה | 14:00-18:00"
export function parseDutyLine(text) {
  const f = String(text || '').trim().split(/\s*[|;]\s*/);
  if (f.length !== 3) return { error: 'צריך שלושה חלקים: שם | ימים | שעות' };
  const m = MEMBERS.find((x) => x.name === f[0].trim());
  if (!m) return { error: `לא מכירים את "${f[0]}". השמות: ${MEMBERS.map((x) => x.name).join(', ')}` };
  const days = parseDays(f[1]);
  if (!days) return { error: 'לא הבנתי את הימים. כתבו למשל: א-ה, כל יום, סופש, או א,ג,ה' };
  const range = parseRange(f[2]);
  if (!range) return { error: 'לא הבנתי את השעות. כתבו למשל 14:00-18:00' };
  return { member: m.id, days, start: range[0], end: range[1] };
}

// מי באחריות עכשיו. rows: שורות מהטבלה
export function onDutyMembers(rows, now, tz) {
  const p = parts(now, tz);
  const min = p.h * 60 + p.mi;
  const prev = (p.wd + 6) % 7;
  const out = new Set();
  for (const r of rows) {
    const days = r.days.split(',').map(Number);
    const wraps = r.end_min <= r.start_min;
    if (!wraps) {
      if (days.includes(p.wd) && min >= r.start_min && min < r.end_min) out.add(r.member);
    } else {
      if (days.includes(p.wd) && min >= r.start_min) out.add(r.member);
      if (days.includes(prev) && min < r.end_min) out.add(r.member);
    }
  }
  return [...out];
}

export function daysText(daysCsv) {
  const d = daysCsv.split(',').map(Number);
  if (d.length === 7) return 'כל יום';
  if (d.join() === '0,1,2,3,4') return 'א׳-ה׳';
  if (d.join() === '5,6') return 'סופ״ש';
  return d.map((i) => LETTERS[i] + '׳').join(' ');
}
