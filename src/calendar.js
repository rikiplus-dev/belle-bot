// הוספה ליומן הטלפון: קישור ליומן גוגל, וקובץ .ics שנפתח ביומן של אייפון ואנדרואיד.
import { parts } from './time.js';

const pad = (n) => String(n).padStart(2, '0');
const ymd = (ts, tz) => {
  const p = parts(ts, tz);
  return `${p.y}${pad(p.m)}${pad(p.d)}`;
};
const nextYmd = (ts, tz) => ymd(ts + 36 * 3600000, tz); // חצי יום אחרי הערב, לא מושפע משעון קיץ
const icsEsc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// אירוע של יום שלם
export function googleCalendarUrl({ title, dueTs, notes }, tz) {
  const q = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: `${ymd(dueTs, tz)}/${nextYmd(dueTs, tz)}`,
    details: notes || '',
  });
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}

export function icsFile({ title, dueTs, notes, uid }, tz, nowTs = Date.now()) {
  const stamp = new Date(nowTs).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//bellebot//he//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}@bellebot`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${ymd(dueTs, tz)}`,
    `DTEND;VALUE=DATE:${nextYmd(dueTs, tz)}`,
    `SUMMARY:${icsEsc(title)}`,
    ...(notes ? [`DESCRIPTION:${icsEsc(notes)}`] : []),
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsEsc(title)}`,
    'TRIGGER:-P1D',
    'END:VALARM',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsEsc(title)}`,
    'TRIGGER;RELATED=START:PT9H',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.join('\r\n') + '\r\n';
}
