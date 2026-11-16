// עזרי זמן. כל החישובים לפי אזור הזמן של הבית (ברירת מחדל Asia/Jerusalem).

const cache = new Map();
function fmt(tz) {
  let f = cache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    cache.set(tz, f);
  }
  return f;
}

const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function parts(ts, tz) {
  const o = {};
  for (const p of fmt(tz).formatToParts(new Date(ts))) o[p.type] = p.value;
  return {
    y: +o.year,
    m: +o.month,
    d: +o.day,
    h: +o.hour % 24,
    mi: +o.minute,
    s: +o.second,
    wd: WD[o.weekday],
  };
}

export function startOfDay(ts, tz) {
  const p = parts(ts, tz);
  let t = ts - (((p.h * 60 + p.mi) * 60 + p.s) * 1000) - (ts % 1000);
  const q = parts(t, tz);
  const off = ((q.h * 60 + q.mi) * 60 + q.s) * 1000;
  if (q.d !== p.d) t += 86400000 - off; // יום קצר (מעבר לשעון קיץ)
  else if (off > 0) t -= off; // יום ארוך (מעבר לשעון חורף)
  return t;
}

// השבוע מתחיל ביום ראשון
export function startOfWeek(ts, tz) {
  const sd = startOfDay(ts, tz);
  const wd = parts(ts, tz).wd;
  return startOfDay(sd - wd * 86400000 + 12 * 3600000, tz);
}

export function dayKey(ts, tz) {
  const p = parts(ts, tz);
  return `${p.y}-${p.m}-${p.d}`;
}

export function hhmm(ts, tz) {
  const p = parts(ts, tz);
  return `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
}

const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

export function dayLabel(ts, now, tz) {
  const k = dayKey(ts, tz);
  if (k === dayKey(now, tz)) return 'היום';
  if (k === dayKey(now - 86400000, tz)) return 'אתמול';
  const p = parts(ts, tz);
  return `יום ${DAY_NAMES[p.wd]} ${p.d}.${p.m}`;
}

export function dateLine(ts, tz) {
  const p = parts(ts, tz);
  return `יום ${DAY_NAMES[p.wd]}, ${p.d}.${p.m}`;
}

const DAY_LETTERS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];

export function shortDay(ts, tz) {
  return DAY_LETTERS[parts(ts, tz).wd];
}

export function dur(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'פחות מדקה';
  if (m < 60) return `${m} דק׳`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h < 24) {
    if (h === 1 && r < 5) return 'שעה';
    return r >= 5 ? `${h} שע׳ ו-${r} דק׳` : `${h} שע׳`;
  }
  const d = Math.floor(h / 24);
  return d === 1 ? 'יום' : `${d} ימים`;
}

export function ago(ts, now) {
  const m = Math.floor((now - ts) / 60000);
  if (m < 1) return 'הרגע';
  return `לפני ${dur(now - ts)}`;
}

// "14:30" -> לפני כמה דקות. אם השעה עוד לא הגיעה היום, מתכוונים לאתמול.
export function minutesAgoFromClock(h, m, now, tz) {
  let ts = startOfDay(now, tz) + (h * 60 + m) * 60000;
  if (ts > now) ts -= 86400000;
  return Math.round((now - ts) / 60000);
}
