// רץ כל 10 דקות: תזכורות אילוף, סגירת טיול שנשכח, ותקציר שבועי.
import * as db from './db.js';
import { DOG, DEFAULTS, MEMBER_BY_ID } from './config.js';
import { broadcast } from './notify.js';
import { tgSafe, esc, alertAdmin } from './telegram.js';
import { parts, startOfWeek, startOfDay, dur } from './time.js';
import { weeklyText } from './views.js';
import { healthCron } from './health.js';
import { onDutyMembers } from './duty.js';
import { effectiveThresholds, analyze, STREAK_MILESTONES } from './insights.js';

const MIN = 60000;

// כל שלב בקרון רץ לעצמו: תקלה באחד לא עוצרת את השאר
async function step(env, name, fn) {
  try {
    return await fn();
  } catch (e) {
    console.error(`cron step ${name} failed`, e && e.stack ? e.stack : e);
    await alertAdmin(env, `קרון: ${name}`, e);
    return undefined;
  }
}

export async function runCron(env, now = Date.now()) {
  const tz = env.TZ || 'Asia/Jerusalem';
  const p = parts(now, tz);
  const th = await effectiveThresholds(env, now);
  // שעות שינה: אם ההתחלה גדולה מהסיום, החלון חוצה חצות (למשל 22 עד 7)
  const quiet = th.sleepFrom > th.sleepTo ? p.h >= th.sleepFrom || p.h < th.sleepTo : p.h >= th.sleepFrom && p.h < th.sleepTo;
  const out = { closed: 0, mealNudge: 0, intervalNudge: 0, weekly: 0 };

  // 1. טיול שנשכח פתוח נסגר לבד
  const stale = await step(env, 'סגירת טיול', () => db.staleWalk(env, now - DEFAULTS.walkMaxMin * MIN));
  if (stale) {
    const lastEv = await db.lastWalkEventTs(env, stale.id);
    const endAt = Math.min(now, Math.max(lastEv, stale.started_at) + 15 * MIN);
    const r = await db.endWalk(env, stale.id, endAt, true);
    if (r) {
      out.closed = 1;
      const who = MEMBER_BY_ID[stale.member] ? MEMBER_BY_ID[stale.member].name : 'מישהו/י';
      await broadcast(
        env,
        `⏱ הטיול של ${esc(who)} נסגר אוטומטית, כי נשאר פתוח יותר משעתיים.\nאם היו פיפי או קקי, אפשר לתעד אותם עכשיו כאירוע חדש.`,
        { flag: 'notify_activity' },
      );
    }
  }

  // 2. תקציר שבועי: יום ראשון בבוקר, פעם אחת
  if (p.wd === 0 && p.h >= 7 && p.h < 12) {
    const key = `weekly:${startOfWeek(now, tz)}`;
    if (await db.claimReminder(env, key, now)) {
      const n = await step(env, 'תקציר שבועי', async () => broadcast(env, await weeklyText(env, now), { flag: 'notify' }));
      if (!n) await db.unclaimReminder(env, key);
      out.weekly = n || 0;
    }
  }

  const hc = (await step(env, 'בריאות', () => healthCron(env, now))) || { meds: 0, due: 0 };
  out.meds = hc.meds;
  out.due = hc.due;

  if (p.h === 3) {
    await db.pruneReminders(env, now - 14 * 86400000);
    await db.pruneUpdates(env, now - 2 * 86400000);
    await db.pruneWalkMsgs(env, ((await db.maxWalkId(env)) || 0) - 200);
  }
  if (quiet) return out;

  // חגיגה על רצף ימים בלי תאונה בבית (פעם אחת לכל אבן דרך)
  if (p.h >= 9) {
    await step(env, 'רצף ימים', async () => {
      const a = analyze(await db.eventsBetween(env, now - 120 * 86400000, now), now, tz);
      const m = [...STREAK_MILESTONES].reverse().find((x) => a.streak >= x);
      if (!m || (await db.reminderSent(env, `streak:${m}:${a.lastHome || 0}`))) return;
      const key = `streak:${m}:${a.lastHome || 0}`;
      if (!(await db.claimReminder(env, key, now))) return;
      const n = await broadcast(env, `🏆 <b>${m} ימים בלי תאונה בבית!</b>\nכל הכבוד לכולם, ולבל 🐶🎉`, { flag: 'notify_activity' });
      if (!n) await db.unclaimReminder(env, key);
      out.streak = n;
    });
  }
  const t = th;

  // תזכורות ארוחה קבועות: ראשונה (למשל עד 10:00) ושנייה (למשל עד 20:00). פעם אחת ביום לכל אחת.
  await step(env, 'תזכורת ארוחה', async () => {
    const day0 = startOfDay(now, tz);
    const dayKey = new Date(now).toLocaleDateString('en-CA', { timeZone: tz });
    const wake = day0 + th.sleepTo * 3600000;
    const meals = (await db.eventsBetween(env, wake, now)).filter((e) => e.kind === 'meal').length;
    const checks = [
      { by: th.meal1By, need: 1, key: `meal1:${dayKey}`, text: `🍽 עוד לא תועדה ארוחת בוקר של ${DOG}.\nאכלה? אפשר לתעד בלחיצה. לא אכלה? כדאי להאכיל אותה.` },
      {
        by: th.meal2By,
        need: 2,
        key: `meal2:${dayKey}`,
        text: meals === 0 ? `🍽 לא תועדה אף ארוחה היום ל${DOG}.\nאכלה? אפשר לתעד בלחיצה.` : `🍽 הארוחה השנייה של ${DOG} עדיין לא תועדה.\nאכלה? אפשר לתעד בלחיצה. לא אכלה? הגיע הזמן.`,
      },
    ];
    for (const c of checks) {
      // שולחים רק בשעה היעד או בשעה שאחריה, כדי לא להפתיע באמצע היום
      if (!c.by || (p.h !== c.by && p.h !== c.by + 1) || meals >= c.need) continue;
      if ((await db.reminderSent(env, c.key)) || !(await db.claimReminder(env, c.key, now))) continue;
      const n = await broadcast(env, c.text, { flag: 'notify', markup: { inline_keyboard: [[{ text: '🍽 תיעדו שבל אכלה', callback_data: 'a:meal' }]] } });
      if (!n) await db.unclaimReminder(env, c.key);
      out[c.key.split(':')[0]] = n;
    }
  });

  // בשעות אחריות רק מי שבאחריות מקבל תזכורות אילוף. אם הוא עוד לא מחובר לבוט, כולם מקבלים.
  const onDuty = onDutyMembers(await db.listDuty(env), now, tz);
  const users = await db.listUsers(env);
  const dutyReachable = onDuty.filter((m) => users.some((u) => u.member === m && u.chat_id));
  const nudgeTo = dutyReachable.length ? dutyReachable : null;
  const open = await db.activeWalk(env);
  if (open) return out; // כבר בטיול

  // 3. תזכורת אחרי ארוחה
  const meal = await db.lastMeal(env, now - 90 * MIN, now - t.mealNudgeMin * MIN);
  if (meal) {
    const key = `meal:${meal.id}`;
    if (!(await db.reminderSent(env, key)) && !(await db.walkStartedSince(env, meal.ts)) && (await db.claimReminder(env, key, now))) {
      out.mealNudge = await broadcast(
        env,
        `🍽 ${DOG} אכלה לפני ${dur(now - meal.ts)}.\nזה זמן טוב להוציא אותה לפיפי וקקי.`,
        { flag: 'notify', markup: startMarkup(), members: nudgeTo },
      );
      if (!out.mealNudge) await db.unclaimReminder(env, key);
    }
  }

  // 4. תזכורת אם עבר זמן רב בלי יציאה
  // השינה לא נספרת: אחרי הלילה סופרים מרגע ההשכמה
  const wakeTs = startOfDay(now, tz) + th.sleepTo * 3600000;
  const anchor = Math.max(await db.maxOutPee(env), await db.maxWalkStart(env), now >= wakeTs ? wakeTs : 0);
  if (anchor && now - anchor < 12 * 60 * MIN) {
    const n = Math.floor((now - anchor) / (t.intervalMin * MIN));
    if (n >= 1 && n <= 3) {
      const key = `interval:${anchor}:${n}`;
      if (await db.claimReminder(env, key, now)) {
        out.intervalNudge = await broadcast(
          env,
          `⏰ עברו ${dur(now - anchor)} מאז הפעם האחרונה ש${DOG} יצאה.\nכדאי לצאת איתה.`,
          { flag: 'notify', markup: startMarkup(), members: nudgeTo },
        );
        if (!out.intervalNudge) await db.unclaimReminder(env, key);
      }
    }
  }

  return out;
}

const startMarkup = () => ({ inline_keyboard: [[{ text: '🚶 יוצאים לטיול', callback_data: 'a:walk_start' }]] });

export { tgSafe };
