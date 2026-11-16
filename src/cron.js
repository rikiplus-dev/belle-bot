// רץ כל 10 דקות: תזכורות אילוף, סגירת טיול שנשכח, ותקציר שבועי.
import * as db from './db.js';
import { DOG, DEFAULTS, MEMBER_BY_ID } from './config.js';
import { broadcast } from './notify.js';
import { tgSafe, esc } from './telegram.js';
import { parts, startOfWeek, dur } from './time.js';
import { weeklyText } from './views.js';
import { healthCron } from './health.js';

const MIN = 60000;

export async function runCron(env, now = Date.now()) {
  const tz = env.TZ || 'Asia/Jerusalem';
  const p = parts(now, tz);
  const quiet = p.h >= DEFAULTS.quietFrom || p.h < DEFAULTS.quietTo;
  const out = { closed: 0, mealNudge: 0, intervalNudge: 0, weekly: 0 };

  // 1. טיול שנשכח פתוח נסגר לבד
  const stale = await db.staleWalk(env, now - DEFAULTS.walkMaxMin * MIN);
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
    if (!(await db.reminderSent(env, key))) {
      await db.markReminder(env, key, now);
      out.weekly = await broadcast(env, await weeklyText(env, now), { flag: 'notify' });
    }
  }

  const hc = await healthCron(env, now);
  out.meds = hc.meds;
  out.due = hc.due;

  if (p.h === 3) await db.pruneReminders(env, now - 14 * 86400000);
  if (quiet) return out;
  const t = await db.thresholds(env);
  const open = await db.activeWalk(env);
  if (open) return out; // כבר בטיול

  // 3. תזכורת אחרי ארוחה
  const meal = await db.lastMeal(env, now - 90 * MIN, now - t.mealNudgeMin * MIN);
  if (meal) {
    const key = `meal:${meal.id}`;
    if (!(await db.reminderSent(env, key)) && !(await db.walkStartedSince(env, meal.ts))) {
      await db.markReminder(env, key, now);
      out.mealNudge = await broadcast(
        env,
        `🍽 ${DOG} אכלה לפני ${dur(now - meal.ts)}.\nזה זמן טוב להוציא אותה לפיפי וקקי.`,
        { flag: 'notify', markup: startMarkup() },
      );
    }
  }

  // 4. תזכורת אם עבר זמן רב בלי יציאה
  const anchor = Math.max(await db.maxOutPee(env), await db.maxWalkStart(env));
  if (anchor && now - anchor < 12 * 60 * MIN) {
    const n = Math.floor((now - anchor) / (t.intervalMin * MIN));
    if (n >= 1 && n <= 3) {
      const key = `interval:${anchor}:${n}`;
      if (!(await db.reminderSent(env, key))) {
        await db.markReminder(env, key, now);
        out.intervalNudge = await broadcast(
          env,
          `⏰ עברו ${dur(now - anchor)} מאז הפעם האחרונה ש${DOG} יצאה.\nכדאי לצאת איתה.`,
          { flag: 'notify', markup: startMarkup() },
        );
      }
    }
  }

  return out;
}

const startMarkup = () => ({ inline_keyboard: [[{ text: '🚶 יוצאים לטיול', callback_data: 'a:walk_start' }]] });

export { tgSafe };
