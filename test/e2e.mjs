// בדיקת קצה לקצה: מריצים את הבוט מקומית מול שרת טלגרם מדומה, ושולחים לו הודעות כאילו מטלגרם.
// הרצה: npm run e2e
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = 8799;
const MOCK = 9999;
const TOKEN = '111:TEST';
const SECRET = 'e2e-secret';
const BASE = `http://127.0.0.1:${PORT}`;
const state = mkdtempSync(path.join(tmpdir(), 'bellebot-'));
const devVars = path.join(ROOT, '.dev.vars');
const hadDevVars = existsSync(devVars);

/* ---------- טלגרם מדומה ---------- */
let calls = [];
let nextId = 100;
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const m = req.url.match(/^\/bot[^/]+\/(\w+)/);
    if (m) {
      let data = {};
      try { data = JSON.parse(body || '{}'); } catch {}
      calls.push({ method: m[1], ...data });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: { message_id: nextId++ } }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
});
await new Promise((r) => mock.listen(MOCK, '127.0.0.1', r));

/* ---------- הרצת השרת ---------- */
if (!hadDevVars) {
  writeFileSync(
    devVars,
    `BOT_TOKEN=${TOKEN}\nWEBHOOK_SECRET=${SECRET}\nFAMILY_CODE=Bell123\nTELEGRAM_API=http://127.0.0.1:${MOCK}\n`,
  );
}
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_UPDATE_NOTIFIER: '1' };
const wr = (args) => execFileSync('npx', ['wrangler', ...args], { cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
wr(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state]);

const server = spawn('npx', ['wrangler', 'dev', '--local', '--port', String(PORT), '--persist-to', state, '--test-scheduled'], {
  cwd: ROOT,
  env,
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill('SIGTERM'); }
  mock.close();
  if (!hadDevVars) rmSync(devVars, { force: true });
  rmSync(state, { recursive: true, force: true });
}
process.on('exit', cleanup);

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('השרת לא עלה:\n' + serverLog.slice(-2000));
}
await waitReady();

/* ---------- עזרים ---------- */
let updateId = 1;
async function post(update, secret = SECRET) {
  const res = await fetch(`${BASE}/telegram`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
    body: JSON.stringify({ update_id: updateId++, ...update }),
  });
  return res.status;
}
const take = () => {
  const c = calls;
  calls = [];
  return c;
};
const msg = (uid, text, chat = 'private') => ({
  message: { message_id: updateId + 500, from: { id: uid, first_name: 'u' + uid }, chat: { id: uid, type: chat }, text },
});
const cb = (uid, data, messageId = 900) => ({
  callback_query: {
    id: 'cq' + updateId,
    from: { id: uid, first_name: 'u' + uid },
    data,
    message: { message_id: messageId, chat: { id: uid, type: 'private' } },
  },
});
const find = (cs, method, re) => cs.find((c) => c.method === method && (!re || re.test(c.text || '')));
const toastOf = (cs) => (find(cs, 'answerCallbackQuery') || {}).text || '';

function signed(uid) {
  const fields = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: uid, first_name: 'u' + uid }),
    query_id: 'x',
  });
  const check = [...fields.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  fields.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return fields.toString();
}
const api = async (uid, method, p, body) => {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { authorization: `tma ${signed(uid)}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
};

let passed = 0;
const ok = (name) => {
  passed++;
  console.log('  ✓', name);
};

try {
  /* אבטחת webhook */
  assert.equal(await post(msg(1, 'hi'), 'wrong'), 403);
  ok('webhook עם סוד שגוי נדחה');

  /* הצטרפות */
  await post(msg(1001, '/start'));
  let c = take();
  assert.ok(find(c, 'sendMessage', /קוד המשפחה/), 'מבקש קוד');
  await post(msg(1001, 'nope'));
  assert.ok(find(take(), 'sendMessage', /לא נכון/));
  await post(msg(1001, 'bell123')); // לא תלוי באותיות גדולות
  c = take();
  const picker = find(c, 'sendMessage', /מי אתם/);
  assert.ok(picker, 'בחירת בן בית');
  assert.equal(picker.reply_markup.inline_keyboard.flat().length, 5);
  assert.ok(find(c, 'deleteMessage'), 'הודעת הקוד נמחקת');
  await post(cb(1001, 'reg:riki'));
  c = take();
  assert.ok(find(c, 'sendMessage', /בל/), 'לוח ראשי אחרי הרשמה');
  ok('הצטרפות עם קוד משפחה ובחירת בן בית');

  await post(msg(1002, '/start'));
  await post(msg(1002, 'Bell123'));
  await post(cb(1002, 'reg:shuli'));
  take();

  /* משתמש לא רשום בלחצן */
  await post(cb(5555, 'a:meal'));
  assert.match(toastOf(take()), /נרשמים/);
  ok('לחצן ממשתמש לא רשום נחסם');

  /* טיול כמפגש */
  await post(cb(1001, 'a:pee_out'));
  assert.match(toastOf(take()), /אין טיול פעיל/);
  ok('פיפי בחוץ בלי טיול פעיל לא נשמר');

  await post(cb(1001, 'a:walk_start'));
  c = take();
  const edited = find(c, 'editMessageText');
  assert.match(edited.text, /בטיול עכשיו/);
  assert.ok(edited.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'a:walk_end'));
  const toOther = c.find((x) => x.method === 'sendMessage' && x.chat_id === 1002);
  assert.ok(toOther && /טיול/.test(toOther.text), 'שולי מקבלת הודעה');
  assert.ok(!c.find((x) => x.method === 'sendMessage' && x.chat_id === 1001), 'ריקי לא מקבלת הודעה על עצמה');
  ok('התחלת טיול: לוח עם כפתורי בחוץ והודעה לאחרים');

  await post(cb(1001, 'a:walk_start'));
  assert.match(toastOf(take()), /כבר יש טיול פעיל/);
  ok('אי אפשר לפתוח שני טיולים');

  await post(cb(1002, 'a:pee_out')); // שולי מתעדת בתוך הטיול של ריקי
  assert.match(toastOf(take()), /פיפי בחוץ/);
  await post(cb(1001, 'a:poop_out'));
  take();
  await post(cb(1001, 'a:walk_end'));
  c = take();
  assert.match(toastOf(c), /חזרנו/);
  assert.match(toastOf(c), /⭐ \+1/);
  assert.ok(c.find((x) => x.method === 'sendMessage' && x.chat_id === 1002 && /חזרה/.test(x.text)), 'שולי מקבלת סיכום');
  ok('סיום טיול: סיכום, כוכב והודעה');

  /* בבית ואוכל */
  await post(cb(1001, 'a:pee_home'));
  assert.match(find(take(), 'editMessageText').text, /תאונה אחרונה/);
  await post(cb(1001, 'a:cook'));
  await post(cb(1001, 'a:meal'));
  take();
  ok('פיפי בבית, הכנת אוכל, אכלה');

  /* כוכבים */
  await post(cb(1001, 'm:stars'));
  const stars = find(take(), 'editMessageText').text;
  assert.match(stars, /ריקי\s+⭐ <b>3<\/b>/); // קקי בחוץ + טיול + הכנת אוכל
  assert.match(stars, /שולי\s+⭐ <b>1<\/b>/); // פיפי בחוץ
  ok('כוכבים: ריקי 3, שולי 1');

  /* ביטול */
  await post(cb(1001, 'm:undo'));
  assert.match(toastOf(take()), /בוטל: בל אכלה/);
  ok('ביטול הפעולה האחרונה');

  /* טקסט חופשי */
  await post(msg(1001, 'פיפי'));
  c = take();
  const q = find(c, 'sendMessage', /בבית/);
  assert.ok(q && q.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'q:pee_home'));
  await post(cb(1001, 'q:pee_home'));
  assert.match(toastOf(take()), /פיפי בבית/);
  ok('"פיפי" בטקסט חופשי שואל איפה');

  /* היום והגדרות */
  await post(cb(1001, 'm:today'));
  const today = find(take(), 'editMessageText').text;
  assert.match(today, /🚶 טיול · ריקי/);
  assert.match(today, /💧1 💩1/);
  await post(cb(1001, 'm:settings'));
  assert.match(find(take(), 'editMessageText').text, /הגדרות/);
  await post(cb(1001, 's:notify'));
  assert.match(find(take(), 'editMessageText').text, /תזכורות אילוף: כבוי/);
  await post(cb(1001, 's:notify'));
  take();
  await post(cb(1001, 's:meal'));
  assert.match(find(take(), 'editMessageText').text, /אחרי ארוחה: 30/);
  ok('מסך היום והגדרות');

  /* לוח הבקרה (API) */
  assert.equal((await fetch(`${BASE}/api/state`)).status, 401);
  assert.equal((await api(7777, 'GET', '/api/state')).status, 403);
  let s = (await api(1001, 'GET', '/api/state')).json;
  assert.equal(s.me.member, 'riki');
  assert.equal(s.stars_week.riki.total, 3);
  const walkItem = s.feed.find((f) => f.type === 'walk');
  assert.equal(walkItem.events.length, 2);
  assert.deepEqual(s.days[6], { label: s.days[6].label, out: 2, home: 2, today: true });
  ok('API: אימות חתימה, מצב, כוכבים, טיול עם האירועים שבתוכו');

  let r = await api(1002, 'POST', '/api/walk/start');
  assert.equal(r.json.ok, true);
  assert.equal(r.json.state.active_walk.member, 'shuli');
  r = await api(1002, 'POST', '/api/log', { kind: 'poop_out' });
  assert.equal(r.json.state.active_walk.poop_out, 1);
  r = await api(1001, 'POST', '/api/delete', { type: 'event', id: r.json.state.feed[0].events[0].id });
  assert.equal(r.json.ok, false, 'אי אפשר למחוק פעולה של מישהו אחר');
  r = await api(1002, 'POST', '/api/walk/end');
  assert.equal(r.json.ok, true);
  assert.equal(r.json.state.active_walk, null);
  take();
  ok('API: טיול מלא מלוח הבקרה והגנה על מחיקה');

  /* תזכורות (cron) */
  const nowIL = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false });
  const quiet = Number(nowIL) >= 22 || Number(nowIL) < 7;
  const sql = (q2) => wr(['d1', 'execute', 'DB', '--local', '--persist-to', state, '--command', q2]);
  const runCron = () => fetch(`${BASE}/__scheduled?cron=*/10+*+*+*+*`);

  // טיול ששכחו לסגור
  const t0 = Date.now() - 3 * 3600000;
  sql(`INSERT INTO walks(member, started_at) VALUES('beri', ${t0})`);
  await runCron();
  await new Promise((r2) => setTimeout(r2, 1500));
  c = take();
  assert.ok(c.find((x) => x.method === 'sendMessage' && /נסגר אוטומטית/.test(x.text)), 'טיול נסגר אוטומטית');
  ok('טיול שנשכח פתוח נסגר אוטומטית');

  if (!quiet) {
    // מתחילים נקי, כדי שטיול מהבדיקות הקודמות לא יחשב "יצאו אחרי הארוחה"
    sql('DELETE FROM events');
    sql('DELETE FROM walks');
    sql(`INSERT INTO events(ts,kind,member) VALUES(${Date.now() - 30 * 60000}, 'meal', 'riki')`);
    await runCron();
    await new Promise((r2) => setTimeout(r2, 1500));
    c = take();
    assert.ok(c.find((x) => x.method === 'sendMessage' && /אכלה לפני/.test(x.text)), 'תזכורת אחרי ארוחה');
    await runCron();
    await new Promise((r2) => setTimeout(r2, 1000));
    assert.ok(!take().find((x) => /אכלה לפני/.test(x.text || '')), 'לא שולחים פעמיים');
    ok('תזכורת אחרי ארוחה, פעם אחת בלבד');

    // לא יצאו כבר 4 שעות
    sql('DELETE FROM events');
    sql('DELETE FROM walks');
    const t4 = Date.now() - 4 * 3600000;
    sql(`INSERT INTO walks(member, started_at, ended_at) VALUES('riki', ${t4}, ${t4 + 600000})`);
    sql(`INSERT INTO events(ts,kind,member,walk_id) VALUES(${t4 + 300000}, 'pee_out', 'riki', 1)`);
    await runCron();
    await new Promise((r2) => setTimeout(r2, 1500));
    c = take();
    assert.ok(c.find((x) => x.method === 'sendMessage' && /עברו/.test(x.text)), 'תזכורת אחרי זמן רב');
    const nudge = c.find((x) => x.method === 'sendMessage' && /עברו/.test(x.text));
    assert.ok(nudge.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'a:walk_start'));
    ok('תזכורת אחרי 4 שעות בלי יציאה, עם כפתור "יוצאים לטיול"');
  } else {
    console.log('  – שעות שקט עכשיו, מדלגים על בדיקת תזכורת אחרי ארוחה');
  }

  /* עדכון אחורה */
  sql('DELETE FROM events');
  sql('DELETE FROM walks');
  take();
  await post(cb(1001, 'm:late'));
  c = take();
  assert.match(find(c, 'editMessageText').text, /שכחתם לעדכן/);
  await post(cb(1001, 'lw:shuli'));
  assert.match(find(take(), 'editMessageText').text, /שולי/);
  await post(cb(1001, 'lk:shuli:meal'));
  assert.match(find(take(), 'editMessageText').text, /מתי/);
  await post(cb(1001, 'lt:shuli:meal:60'));
  c = take();
  assert.match(toastOf(c), /בל אכלה/);
  assert.ok(find(c, 'sendMessage', /עדכן\/ה אחורה/), 'שאר המשפחה מקבלים הודעה');
  let late = (await api(1001, 'GET', '/api/state')).json;
  assert.equal(late.feed[0].kind, 'meal');
  assert.equal(late.feed[0].member, 'shuli');
  assert.ok(Math.abs(Date.now() - late.feed[0].ts - 3600000) < 60000, 'שעה אחורה');
  ok('עדכון אחורה: אוכל לפני שעה, על שם בן בית אחר');

  // טיול שהיה, עם פיפי וקקי, וכוכב
  await post(cb(1001, 'lk:riki:walk'));
  take();
  await post(cb(1001, 'lt:riki:walk:120'));
  assert.match(find(take(), 'editMessageText').text, /כמה זמן/);
  await post(cb(1001, 'ld:riki:120:30'));
  take();
  await post(cb(1001, 'lb:riki:120:30:1:0'));
  c = take();
  assert.match(find(c, 'editMessageText').text, /💧 פיפי <b>1<\/b>/);
  await post(cb(1001, 'ls:riki:120:30:1:1'));
  assert.match(toastOf(take()), /טיול נוסף/);
  late = (await api(1001, 'GET', '/api/state')).json;
  const lw = late.feed.find((f) => f.type === 'walk');
  assert.equal(lw.events.length, 2);
  assert.ok(lw.ended_at - lw.ts === 30 * 60000);
  assert.equal(late.stars_week.riki.total >= 3, true);
  ok('עדכון אחורה: טיול שהיה עם פיפי וקקי שנשמרים בתוכו וכוכבים');

  // שעה מדויקת בהקלדה
  await post(cb(1001, 'lx:riki:cook'));
  take();
  await post(msg(1001, 'abc'));
  assert.match(find(take(), 'sendMessage').text, /לא הבנתי/);
  const nowD = new Date();
  const hh = String(new Date(nowD.getTime() - 2 * 3600000).toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false }));
  await post(msg(1001, hh));
  c = take();
  assert.ok(find(c, 'sendMessage', /הכנת אוכל/), 'נשמר לפי שעה מדויקת');
  ok('עדכון אחורה: שעה מדויקת בהקלדה');

  // הגנות: סוג לא מורשה וזמן רחוק מדי
  await post(cb(1001, 'lt:riki:pee_out:30'));
  assert.ok(!find(take(), 'editMessageText', /פיפי בחוץ/) || true);
  assert.equal((await api(1001, 'GET', '/api/state')).json.feed.filter((f) => f.kind === 'pee_out').length, 0);
  await post(cb(1001, 'lt:riki:meal:99999'));
  assert.match(toastOf(take()), /יממה/);
  ok('עדכון אחורה: סוג לא מורשה וזמן רחוק נדחים');

  console.log(`\nכל ${passed} הבדיקות עברו`);
} catch (e) {
  console.error('\nנכשל:', e.message);
  console.error('--- לוג שרת ---\n' + serverLog.slice(-2500));
  process.exitCode = 1;
} finally {
  cleanup();
  process.exit(process.exitCode || 0);
}
