import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { startOfDay, startOfWeek, dur, hhmm, dayLabel } from '../src/time.js';
import { verifyInitData } from '../src/auth.js';

const TZ = 'Asia/Jerusalem';

test('תחילת יום בחורף (UTC+2)', () => {
  const ts = Date.UTC(2026, 10, 16, 8, 0, 0); // 10:00 בישראל
  assert.equal(startOfDay(ts, TZ), Date.UTC(2026, 10, 15, 22, 0, 0));
});

test('תחילת שבוע ביום ראשון', () => {
  const monday = Date.UTC(2026, 10, 16, 8, 0, 0);
  assert.equal(startOfWeek(monday, TZ), Date.UTC(2026, 10, 14, 22, 0, 0)); // ראשון 15.11 בחצות
  const sunday = Date.UTC(2026, 10, 15, 10, 0, 0);
  assert.equal(startOfWeek(sunday, TZ), Date.UTC(2026, 10, 14, 22, 0, 0));
});

test('מעבר לשעון קיץ: היום קצר', () => {
  const ts = Date.UTC(2026, 2, 27, 12, 0, 0);
  assert.equal(startOfDay(ts, TZ), Date.UTC(2026, 2, 26, 22, 0, 0));
});

test('מעבר לשעון חורף: היום ארוך', () => {
  const ts = Date.UTC(2026, 9, 25, 12, 0, 0);
  assert.equal(startOfDay(ts, TZ), Date.UTC(2026, 9, 24, 21, 0, 0));
});

test('שעה ותווית יום', () => {
  const ts = Date.UTC(2026, 10, 16, 8, 5, 0);
  assert.equal(hhmm(ts, TZ), '10:05');
  assert.equal(dayLabel(ts, ts, TZ), 'היום');
  assert.equal(dayLabel(ts - 86400000, ts, TZ), 'אתמול');
});

test('משך בעברית', () => {
  assert.equal(dur(20 * 1000), 'פחות מדקה');
  assert.equal(dur(25 * 60000), '25 דק׳');
  assert.equal(dur(60 * 60000), 'שעה');
  assert.equal(dur(135 * 60000), '2 שע׳ ו-15 דק׳');
  assert.equal(dur(26 * 3600000), 'יום');
});

function sign(token, fields) {
  const params = new URLSearchParams(fields);
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

test('אימות initData של טלגרם', async () => {
  const token = '123:ABC';
  const now = Date.now();
  const good = sign(token, {
    auth_date: String(Math.floor(now / 1000)),
    user: JSON.stringify({ id: 42, first_name: 'ריקי' }),
    query_id: 'q1',
  });
  const u = await verifyInitData(good, token, 86400, now);
  assert.equal(u.id, 42);
  assert.equal(await verifyInitData(good, 'other:token', 86400, now), null);
  assert.equal(await verifyInitData(good.replace('q1', 'q2'), token, 86400, now), null);
  const old = sign(token, {
    auth_date: String(Math.floor(now / 1000) - 100000),
    user: JSON.stringify({ id: 42 }),
  });
  assert.equal(await verifyInitData(old, token, 86400, now), null);
  assert.equal(await verifyInitData('', token), null);
});

import { parseWorkerUrl, findDatabaseId, withDatabaseId, missingEnv } from '../scripts/lib.mjs';
test('deploy helpers', async () => {
  const assert = (await import('node:assert/strict')).default;
  assert.equal(parseWorkerUrl('Deployed bellebot\n  https://bellebot.riki.workers.dev\nVersion'), 'https://bellebot.riki.workers.dev');
  assert.equal(findDatabaseId('[{"uuid":"abc","name":"bellebot"}]', 'bellebot'), 'abc');
  assert.equal(findDatabaseId('[]', 'bellebot'), null);
  assert.equal(withDatabaseId('x REPLACE_WITH_DATABASE_ID', 'id1'), 'x id1');
  assert.deepEqual(missingEnv({ BOT_TOKEN: 'a' }).length, 4);
});

import { parseDate, parseSpan, parseTimes, parseMedLine, parseHealthLine, addSpan } from '../src/parse.js';
test('health parsing', async () => {
  const tz = 'Asia/Jerusalem';
  const now = Date.UTC(2026, 10, 16, 8, 0);
  assert.ok(parseDate('12.11', now, tz) < now);
  assert.equal(parseDate('31.02', now, tz), null);
  assert.equal(parseDate('x', now, tz), null);
  assert.deepEqual(parseSpan('3 שבועות'), { days: 21 });
  assert.deepEqual(parseSpan('שנה'), { months: 12 });
  assert.deepEqual(parseSpan('חודשיים'), { months: 2 });
  assert.equal(parseSpan('בקרוב'), null);
  assert.deepEqual(parseTimes('8:00, 20.30'), ['08:00', '20:30']);
  assert.equal(parseTimes('25:00'), null);
  const m = parseMedLine('אנטיביוטיקה | חצי כדור | 08:00 20:00 | 7 ימים', now, tz);
  assert.deepEqual([m.name, m.dose, m.times.join()], ['אנטיביוטיקה', 'חצי כדור', '08:00,20:00']);
  assert.ok(m.end > now);
  assert.ok(parseMedLine('רק שם', now, tz).error);
  assert.equal(parseMedLine('ויטמין | טיפה | 09:00', now, tz).end, null);
  const h = parseHealthLine('כלבת | 12.11 | שנה | הערה', now, tz);
  assert.equal(h.title, 'כלבת');
  assert.equal(h.notes, 'הערה');
  assert.equal(h.due, addSpan(h.at, { months: 12 }, tz));
  const noDate = parseHealthLine('בדיקת דם', now, tz);
  assert.equal(noDate.due, null);
  assert.ok(parseHealthLine('x | 12.11.26 | 01.01.20', now, tz).error);
});

import { parseDays, parseRange, parseDutyLine, onDutyMembers } from '../src/duty.js';
import { walkStartedText, walkEndedText, outcomeText } from '../src/views.js';
test('duty hours', async () => {
  assert.deepEqual(parseDays('א-ה'), [0, 1, 2, 3, 4]);
  assert.deepEqual(parseDays('ה-א'), [0, 4, 5, 6]);
  assert.deepEqual(parseDays('א,ג'), [0, 2]);
  assert.deepEqual(parseDays('סופש'), [5, 6]);
  assert.equal(parseDays('כל יום').length, 7);
  assert.equal(parseDays('בלה'), null);
  assert.deepEqual(parseRange('14:00-18:30'), [840, 1110]);
  assert.equal(parseRange('14:00-14:00'), null);
  assert.equal(parseRange('25:00-18:00'), null);
  assert.equal(parseDutyLine('בלה | א | 10:00-11:00').error !== undefined, true);
  const r = parseDutyLine('שולי | א-ה | 14:00-18:00');
  assert.deepEqual([r.member, r.start, r.end], ['shuli', 840, 1080]);
  const tz = 'Asia/Jerusalem';
  // יום שני 16.11.2026, 15:00 שעון ישראל
  const mon15 = Date.UTC(2026, 10, 16, 13, 0);
  const rows = [
    { member: 'shuli', days: '0,1,2,3,4', start_min: 840, end_min: 1080 },
    { member: 'riki', days: '0,1,2,3,4,5,6', start_min: 1200, end_min: 420 },
  ];
  assert.deepEqual(onDutyMembers(rows, mon15, tz), ['shuli']);
  assert.deepEqual(onDutyMembers(rows, Date.UTC(2026, 10, 16, 18, 30), tz), ['riki']); // 20:30
  assert.deepEqual(onDutyMembers(rows, Date.UTC(2026, 10, 17, 3, 0), tz), ['riki']); // 05:00 למחרת
  assert.deepEqual(onDutyMembers(rows, Date.UTC(2026, 10, 16, 10, 0), tz), []); // 12:00
});
test('walk messages', async () => {
  assert.equal(outcomeText({ pee_out: 0, poop_out: 1 }), 'עשתה קקי, לא פיפי');
  assert.equal(outcomeText({ pee_out: 2, poop_out: 1 }), 'עשתה פיפי ×2 וקקי');
  assert.equal(outcomeText({ pee_out: 0, poop_out: 0 }), 'בלי פיפי וקקי הפעם');
  assert.equal(walkStartedText('shuli'), '🚶 שולי הוציאה את בל לטיול');
  assert.equal(walkStartedText('beri'), '🚶 בערי הוציא את בל לטיול');
  assert.match(walkEndedText({ walker: 'shuli', took: '20 דק׳', counts: { pee_out: 0, poop_out: 1 } }), /שולי הוציאה את בל לטיול · 20 דק׳\nבל עשתה קקי, לא פיפי/);
});

import { icsFile, googleCalendarUrl } from '../src/calendar.js';
test('calendar', async () => {
  const tz = 'Asia/Jerusalem';
  const due = Date.UTC(2026, 11, 20, 8, 0); // 20.12.2026
  const ics = icsFile({ title: 'כלבת, בל', dueTs: due, notes: 'שורה\nשנייה', uid: 'x1' }, tz, Date.UTC(2026, 10, 16, 8, 0));
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261220\r\n/);
  assert.match(ics, /DTEND;VALUE=DATE:20261221\r\n/);
  assert.match(ics, /SUMMARY:כלבת\\, בל\r\n/);
  assert.match(ics, /DESCRIPTION:שורה\\nשנייה\r\n/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
  const url = googleCalendarUrl({ title: 'כלבת', dueTs: due, notes: '' }, tz);
  assert.match(url, /^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE/);
  assert.match(url, /dates=20261220%2F20261221/);
});

import { lookup, FOODS, byLevel, stem } from '../src/foods.js';
test('חיפוש מזון', () => {
  const lv = (q) => lookup(q).level;
  assert.equal(lv('שוקולד'), 'no');
  assert.equal(lv('האם מותר לתת לבל שוקולד לבן?'), 'no');
  assert.equal(lv('הענבים'), 'no');
  assert.equal(lv('צימוקים'), 'no');
  assert.equal(lv('בצל'), 'no');
  assert.equal(lv('קסיליטול'), 'no');
  assert.equal(lv('בננות'), 'mid');
  assert.equal(lv('תפוחי אדמה'), 'mid');
  assert.equal(lv('תפוח'), 'ok');
  assert.equal(lv('גזר'), 'ok');
  assert.equal(lv('אבטיח בלי גרעינים'), 'ok');
  assert.equal(lv('בנאנה'), 'mid', 'טעות כתיב');
  assert.equal(lv('עוגת שוקולד עם אגוזים'), 'no', 'הגרוע מבין המרכיבים');
  assert.equal(lookup('קרמבו').level, null);
  assert.equal(lookup('').level, null);
  assert.ok(lookup('תפוח אדמה').matches.every((m) => m.name !== 'תפוח'), 'תפוח אדמה אינו תפוח');
  assert.equal(stem('עגבניות'), stem('עגבנייה'));
});
test('מאגר המזון שלם ותקין', () => {
  assert.ok(FOODS.length >= 100);
  for (const l of ['no', 'mid', 'ok']) assert.ok(byLevel(l).length >= 25, l);
  for (const f of FOODS) {
    assert.ok(f.name && f.note && f.aliases.length, f.name);
    // כל כינוי של מזון מוצא את המזון עצמו (או מזון חמור ממנו)
    for (const a of f.aliases) {
      const r = lookup(a);
      assert.ok(r.matches.length, `כינוי "${a}" של ${f.name} לא נמצא`);
      const rank = { no: 0, mid: 1, ok: 2 };
      assert.ok(rank[r.level] <= rank[f.level], `כינוי "${a}" של ${f.name} (${f.level}) יצא ${r.level}`);
    }
  }
});

import { parseWeight, ageText } from '../src/bell.js';
import { TIPS, tipFor } from '../src/tips.js';
test('משקל וגיל', () => {
  const now = Date.UTC(2026, 10, 16, 10);
  const tz = 'Asia/Jerusalem';
  assert.equal(parseWeight('2.4', now, tz).grams, 2400);
  assert.equal(parseWeight('2,4 ק״ג', now, tz).grams, 2400);
  assert.equal(parseWeight('2400', now, tz).grams, 2400);
  assert.equal(parseWeight('2400 גרם', now, tz).grams, 2400);
  const d = parseWeight('3.1 1.11', now, tz);
  assert.equal(d.grams, 3100);
  assert.ok(d.ts < now);
  assert.ok(parseWeight('אבא', now, tz).error);
  assert.ok(parseWeight('50', now, tz).error, 'לא הגיוני');
  assert.ok(parseWeight('2.4 30.12', now, tz).error, 'תאריך עתידי');
  assert.equal(ageText(now - 10 * 7 * 86400000, now), '10 שבועות');
  assert.equal(ageText(now - 14 * 86400000, now), 'שבועיים');
  assert.match(ageText(now - 200 * 86400000, now), /חודשים/);
  assert.equal(ageText(now + 1000, now), null);
  assert.ok(TIPS.length >= 15);
  assert.equal(tipFor(-1), tipFor(TIPS.length - 1));
});
