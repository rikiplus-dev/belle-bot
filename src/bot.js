// הבוט: הודעות, פקודות ולחצנים.
import * as db from './db.js';
import * as act from './actions.js';
import * as v from './views.js';
import { tgSafe, esc } from './telegram.js';
import { broadcast } from './notify.js';
import { DOG, MEMBER_BY_ID } from './config.js';
import { INTERVAL_OPTIONS, MEAL_NUDGE_OPTIONS } from './config.js';

const MAX_ATTEMPTS = 5;
const LOCK_MS = 3600000;

const parseCommand = (text) => {
  const m = text.match(/^\/([A-Za-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  return m ? { name: m[1].toLowerCase(), args: (m[2] || '').trim() } : null;
};

const send = (env, chatId, view) =>
  tgSafe(env, 'sendMessage', { chat_id: chatId, text: view.text, parse_mode: 'HTML', reply_markup: view.reply_markup });

const edit = (env, msg, view) =>
  tgSafe(env, 'editMessageText', {
    chat_id: msg.chat.id,
    message_id: msg.message_id,
    text: view.text,
    parse_mode: 'HTML',
    reply_markup: view.reply_markup,
  });

const plain = (env, chatId, text) => tgSafe(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });

export async function handleUpdate(env, update, ctx, origin) {
  if (update.callback_query) return onCallback(env, update.callback_query, ctx, origin);
  if (update.message && typeof update.message.text === 'string') return onText(env, update.message, ctx, origin);
}

/* ---------- הודעות טקסט ופקודות ---------- */

async function onText(env, msg, ctx, origin) {
  const from = msg.from;
  if (!from || from.is_bot) return;
  const chat = msg.chat;
  const isPrivate = chat.type === 'private';
  const text = msg.text.trim();
  const cmd = parseCommand(text);
  const now = Date.now();

  const user = await db.getUser(env, from.id);
  if (!user) {
    if (!isPrivate) {
      if (cmd) await plain(env, chat.id, `כדי להצטרף פותחים איתי צ׳אט פרטי ושולחים /start 🐶`);
      return;
    }
    return register(env, msg, text, cmd, now);
  }
  if (isPrivate) await db.touchChat(env, from.id, chat.id);
  const opts = { isPrivate, origin };

  if (cmd) {
    switch (cmd.name) {
      case 'start':
      case 'menu':
        return send(env, chat.id, await v.panel(env, user, opts));
      case 'walk': {
        const r = await act.walkStart(env, user.member, now);
        if (r.ok) ctx.waitUntil(broadcast(env, v.walkStartedText(user.member), { flag: 'notify_activity', exceptTgId: from.id }));
        return send(env, chat.id, await v.panel(env, user, { ...opts, notice: r.notice || r.toast }));
      }
      case 'stars':
        return send(env, chat.id, await v.starsView(env));
      case 'today':
        return send(env, chat.id, await v.todayView(env));
      case 'settings':
        return send(env, chat.id, await v.settingsView(env, user));
      case 'undo': {
        const r = await act.undo(env, user.member, now);
        return send(env, chat.id, await v.panel(env, user, { ...opts, notice: r.notice || r.toast }));
      }
      case 'help':
        return plain(env, chat.id, v.helpText);
      default:
        return plain(env, chat.id, 'לא הכרתי את הפקודה. /menu פותח את הלוח, /help מסביר.');
    }
  }

  // "פיפי" או "קקי" בטקסט חופשי
  const word = text.replace(/[^֐-׿a-z ]/gi, '').trim();
  const kindWord = /^פיפי/.test(word) ? 'pee' : /^קקי/.test(word) ? 'poop' : null;
  if (kindWord) {
    const walk = await db.activeWalk(env);
    if (walk) {
      const r = await act.log(env, user.member, `${kindWord}_out`, now);
      return send(env, chat.id, await v.panel(env, user, { ...opts, notice: r.notice || r.toast }));
    }
    return send(env, chat.id, {
      text: `אין טיול פעיל כרגע. זה קרה בבית?`,
      reply_markup: {
        inline_keyboard: [
          [{ text: `🏠 כן, ${kindWord === 'pee' ? 'פיפי' : 'קקי'} בבית`, callback_data: `q:${kindWord}_home` }],
          [{ text: '🚶 לא, יוצאים לטיול', callback_data: 'a:walk_start' }],
        ],
      },
    });
  }

  if (isPrivate) return plain(env, chat.id, 'שלחו /menu כדי לפתוח את הלוח של בל 🐶');
}

/* ---------- הצטרפות ---------- */

async function register(env, msg, text, cmd, now) {
  const id = msg.from.id;
  const chatId = msg.chat.id;
  if (!env.FAMILY_CODE) return plain(env, chatId, 'הבוט עוד לא הוגדר במלואו (חסר קוד משפחה).');

  let p = await db.getPending(env, id);
  if (p && p.state === 'await_member') return send(env, chatId, v.memberPicker());
  if (!p || (cmd && cmd.name === 'start')) {
    await db.setPending(env, id, 'await_code', p ? p.attempts : 0, now);
    return plain(env, chatId, v.askCodeText);
  }

  if (p.attempts >= MAX_ATTEMPTS) {
    if (now - p.updated_at < LOCK_MS) return plain(env, chatId, 'ניסיתם הרבה פעמים. נסו שוב בעוד שעה.');
    p = { ...p, attempts: 0 };
  }
  const ok = text.trim().toLowerCase() === String(env.FAMILY_CODE).trim().toLowerCase();
  if (!ok) {
    await db.setPending(env, id, 'await_code', p.attempts + 1, now);
    return plain(env, chatId, 'הקוד לא נכון. נסו שוב.');
  }
  await db.setPending(env, id, 'await_member', 0, now);
  await tgSafe(env, 'deleteMessage', { chat_id: chatId, message_id: msg.message_id });
  return send(env, chatId, v.memberPicker());
}

async function onRegister(env, cq, ctx, origin) {
  const from = cq.from;
  const msg = cq.message;
  const now = Date.now();
  const answer = (text, alert = false) => tgSafe(env, 'answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: alert });
  const p = await db.getPending(env, from.id);
  const member = cq.data.slice(4);
  if (!p || p.state !== 'await_member' || !MEMBER_BY_ID[member]) {
    return answer('שלחו /start כדי להתחיל מחדש', true);
  }
  await db.upsertUser(env, from.id, member, msg.chat.id, now);
  await db.clearPending(env, from.id);
  const user = await db.getUser(env, from.id);
  await edit(env, msg, { text: `🎉 נרשמתם בתור <b>${esc(MEMBER_BY_ID[member].name)}</b>. ברוכים הבאים לבלבוט!`, reply_markup: { inline_keyboard: [] } });
  await answer('נרשמתם בהצלחה');
  return send(env, msg.chat.id, await v.panel(env, user, { isPrivate: true, origin, notice: 'אפשר להתחיל. /help מסביר הכול' }));
}

/* ---------- לחצנים ---------- */

async function onCallback(env, cq, ctx, origin) {
  const from = cq.from;
  const msg = cq.message;
  const data = cq.data || '';
  const answer = (text, alert = false) =>
    tgSafe(env, 'answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text, show_alert: alert } : {}) });
  if (!msg) return answer();
  if (data.startsWith('reg:')) return onRegister(env, cq, ctx, origin);

  const user = await db.getUser(env, from.id);
  if (!user) return answer('קודם נרשמים: פותחים איתי צ׳אט פרטי ושולחים /start 🐶', true);
  const isPrivate = msg.chat.type === 'private';
  if (isPrivate) await db.touchChat(env, from.id, msg.chat.id);
  const now = Date.now();
  const opts = { isPrivate, origin };
  const [type, arg] = [data.slice(0, data.indexOf(':')), data.slice(data.indexOf(':') + 1)];

  let view = null;
  let toast = '';
  let notice = '';

  if (type === 'a' || type === 'q') {
    let r;
    if (arg === 'walk_start') {
      r = await act.walkStart(env, user.member, now);
      if (r.ok) ctx.waitUntil(broadcast(env, v.walkStartedText(user.member), { flag: 'notify_activity', exceptTgId: from.id }));
    } else if (arg === 'walk_end') {
      r = await act.walkEnd(env, user.member, now);
      if (r.ok) ctx.waitUntil(broadcast(env, v.walkEndedText(r), { flag: 'notify_activity', exceptTgId: from.id }));
    } else {
      r = await act.log(env, user.member, arg, now);
    }
    toast = r.toast;
    notice = r.ok ? r.notice : '';
    view = await v.panel(env, user, { ...opts, notice });
  } else if (type === 'm') {
    if (arg === 'menu') view = await v.panel(env, user, opts);
    else if (arg === 'stars') view = await v.starsView(env);
    else if (arg === 'today') view = await v.todayView(env);
    else if (arg === 'settings') view = await v.settingsView(env, user);
    else if (arg === 'undo') {
      const r = await act.undo(env, user.member, now);
      toast = r.toast;
      view = await v.panel(env, user, { ...opts, notice: r.ok ? r.notice : '' });
    }
  } else if (type === 's') {
    if (arg === 'notify') await db.setUserFlag(env, from.id, 'notify', !user.notify);
    else if (arg === 'activity') await db.setUserFlag(env, from.id, 'notify_activity', !user.notify_activity);
    else if (arg === 'meal') {
      const t = await db.thresholds(env);
      await db.setSetting(env, 'meal_nudge_min', v.nextOption(MEAL_NUDGE_OPTIONS, t.mealNudgeMin));
    } else if (arg === 'interval') {
      const t = await db.thresholds(env);
      await db.setSetting(env, 'interval_min', v.nextOption(INTERVAL_OPTIONS, t.intervalMin));
    }
    view = await v.settingsView(env, await db.getUser(env, from.id));
  }

  await Promise.all([answer(toast), view ? edit(env, msg, view) : null]);
}

export { DOG };
