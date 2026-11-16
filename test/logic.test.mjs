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
