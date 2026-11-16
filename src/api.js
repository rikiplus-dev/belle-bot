// ה-API של לוח הבקרה (נפתח מתוך טלגרם). כל בקשה חתומה על ידי טלגרם.
import * as db from './db.js';
import * as act from './actions.js';
import { verifyInitData } from './auth.js';
import { DOG, MEMBERS, MEMBER_BY_ID, KINDS } from './config.js';
import { startOfDay, startOfWeek, shortDay } from './time.js';
import { broadcast } from './notify.js';
import { walkStartedText, walkEndedText, cheerMarkup } from './views.js';
import { isAdmin } from './config.js';
import { healthState } from './health.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export async function buildState(env, user, now = Date.now()) {
  const tz = env.TZ || 'Asia/Jerusalem';
  const today0 = startOfDay(now, tz);
  const from = startOfDay(today0 - 6 * 86400000 + 12 * 3600000, tz); // 7 ימים כולל היום
  const [events, walks, active, today, home, weekStars, allStars] = await Promise.all([
    db.eventsSince(env, from, 1000),
    db.walksSince(env, from, 300),
    db.activeWalk(env),
    db.todaySummary(env, now, tz),
    db.lastHome(env),
    db.stars(env, startOfWeek(now, tz)),
    db.stars(env, 0),
  ]);

  // גרף 7 ימים
  const starts = [];
  for (let i = 0; i < 7; i++) starts.push(startOfDay(from + i * 86400000 + 12 * 3600000, tz));
  starts.push(today0 + 86400000 + 6 * 3600000); // חסם עליון בטוח
  const days = starts.slice(0, 7).map((s, i) => {
    const e = starts[i + 1];
    let out = 0;
    let homeN = 0;
    for (const ev of events) {
      if (ev.ts < s || ev.ts >= e) continue;
      if (ev.kind === 'pee_out' || ev.kind === 'poop_out') out++;
      else if (ev.kind === 'pee_home' || ev.kind === 'poop_home') homeN++;
    }
    return { label: shortDay(s + 12 * 3600000, tz), out, home: homeN, today: i === 6 };
  });

  // יומן: טיולים עם האירועים שבתוכם, ואירועים בודדים
  const byWalk = new Map();
  for (const ev of events) {
    if (ev.walk_id) {
      if (!byWalk.has(ev.walk_id)) byWalk.set(ev.walk_id, []);
      byWalk.get(ev.walk_id).push({ id: ev.id, ts: ev.ts, kind: ev.kind, member: ev.member });
    }
  }
  const feed = [];
  for (const w of walks) {
    feed.push({
      type: 'walk',
      id: w.id,
      ts: w.started_at,
      ended_at: w.ended_at,
      member: w.member,
      auto: !!w.auto_closed,
      events: (byWalk.get(w.id) || []).sort((a, b) => a.ts - b.ts),
    });
  }
  for (const ev of events) {
    if (!ev.walk_id) feed.push({ type: 'event', id: ev.id, ts: ev.ts, kind: ev.kind, member: ev.member });
  }
  feed.sort((a, b) => b.ts - a.ts);

  let activeWalk = null;
  if (active) {
    const c = await db.walkCounts(env, active.id);
    activeWalk = { id: active.id, member: active.member, started_at: active.started_at, pee_out: c.pee_out, poop_out: c.poop_out };
  }

  return {
    now,
    tz,
    dog: DOG,
    me: { member: user.member, name: MEMBER_BY_ID[user.member]?.name || '' },
    members: MEMBERS,
    kinds: Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, { label: v.label, out: !!v.out, accident: !!v.accident, star: v.star }])),
    active_walk: activeWalk,
    today,
    last_home: home ? home.ts : null,
    days,
    stars_week: weekStars,
    stars_total: allStars,
    feed: feed.slice(0, 120),
    health: isAdmin(user) ? await healthState(env, now) : null,
  };
}

export async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname === '/api/health') return json({ ok: true });

  const auth = request.headers.get('authorization') || '';
  const initData = auth.startsWith('tma ') ? auth.slice(4) : '';
  const tgUser = await verifyInitData(initData, env.BOT_TOKEN);
  if (!tgUser) return json({ error: 'unauthorized' }, 401);
  const user = await db.getUser(env, tgUser.id);
  if (!user) return json({ error: 'not_registered' }, 403);

  const now = Date.now();
  const path = url.pathname;
  let result = null;

  if (request.method === 'GET' && path === '/api/state') {
    return json(await buildState(env, user, now));
  }
  if (request.method !== 'POST') return json({ error: 'not_found' }, 404);

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  if (path === '/api/walk/start') {
    result = await act.walkStart(env, user.member, now);
    if (result.ok) ctx.waitUntil(broadcast(env, walkStartedText(user.member), { flag: 'notify_activity', exceptTgId: user.tg_id, markup: cheerMarkup(user.member) }));
  } else if (path === '/api/walk/end') {
    result = await act.walkEnd(env, user.member, now);
    if (result.ok) ctx.waitUntil(broadcast(env, walkEndedText(result), { flag: 'notify_activity', exceptTgId: user.tg_id, markup: cheerMarkup(user.member) }));
  } else if (path === '/api/log') {
    result = await act.log(env, user.member, String(body.kind || ''), now, 'app');
  } else if (path === '/api/undo') {
    result = await act.undo(env, user.member, now);
  } else if (path === '/api/delete') {
    const id = Number(body.id);
    const ok = body.type === 'walk' ? await db.deleteWalk(env, id, user.member) : await db.deleteEvent(env, id, user.member);
    result = { ok, toast: ok ? 'נמחק' : 'אפשר למחוק רק פעולות שלך' };
  } else {
    return json({ error: 'not_found' }, 404);
  }

  return json({ ok: !!result.ok, toast: result.toast || '', state: await buildState(env, user, Date.now()) });
}
