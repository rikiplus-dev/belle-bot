// הבוט: הודעות, פקודות ולחצנים.
import * as db from './db.js';
import * as act from './actions.js';
import * as v from './views.js';
import { tgSafe, esc } from './telegram.js';
import { broadcast } from './notify.js';
import { DOG, MEMBER_BY_ID, LATE_KINDS, HEALTH_KINDS, isAdmin } from './config.js';
import * as hl from './health.js';
import * as wz from './wizards.js';
import { CHEERS } from './config.js';
import { minutesAgoFromClock, startOfDay } from './time.js';
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
  if (update.message && update.message.sticker) return onSticker(env, update.message);
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
      case 'cheer':
        await db.clearPending(env, from.id);
        return send(env, chat.id, v.cheerPick(user));
      case 'late':
        await db.clearPending(env, from.id);
        return send(env, chat.id, v.lateStart(user.member));
      case 'stars':
        return send(env, chat.id, await v.starsView(env));
      case 'today':
        return send(env, chat.id, await v.todayView(env));
      case 'settings':
        return send(env, chat.id, isAdmin(user) ? await v.settingsView(env, user) : v.adminOnly);
      case 'health':
        if (!isAdmin(user)) return send(env, chat.id, v.adminOnly);
        await db.clearPending(env, from.id);
        return send(env, chat.id, await hl.healthHome(env, now));
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

  const pend = await db.getPending(env, from.id);

  // הודעה חופשית לעידוד
  if (pend && pend.state.startsWith('cheer:')) {
    if (now - pend.updated_at > 15 * 60000) {
      await db.clearPending(env, from.id);
    } else {
      const to = pend.state.slice(6);
      await db.clearPending(env, from.id);
      const n = await sendCheer(env, user, to, { text: text.slice(0, 300) });
      return send(env, chat.id, await v.panel(env, user, { ...opts, notice: n ? `💌 נשלח (${n})` : 'אף אחד מהנמענים לא מחובר לבוט עדיין' }));
    }
  }

  // שאלון אירוע רפואי: שלב שמחכה להקלדה
  if (pend && pend.state.startsWith('hw:') && isAdmin(user)) {
    const d = await hl.getDraft(env, from.id);
    if (!d || now - d.updated_at > 30 * 60000) {
      await db.clearPending(env, from.id);
    } else if (d.a) {
      const tz = env.TZ || 'Asia/Jerusalem';
      const r = hl.applyText(d, text, now, tz);
      if (r.error) return plain(env, chat.id, `${esc(r.error)}`);
      return send(env, chat.id, await advanceWizard(env, user, r.draft, now));
    }
  }

  // שאלון תרופה: שלב שמחכה להקלדה (שם או מינון משלכם)
  if (pend && pend.state.startsWith('mw:') && isAdmin(user)) {
    const d = await wz.getWiz(env, from.id, 'mw');
    if (!d || now - d.updated_at > 30 * 60000) {
      await db.clearPending(env, from.id);
    } else if (d.a) {
      const r = wz.medText(d, text);
      if (r.error) return plain(env, chat.id, esc(r.error));
      return send(env, chat.id, await advanceMed(env, user, r.draft, now));
    }
  }

  // שעה מדויקת לעדכון אחורה, למשל 14:30
  if (pend && pend.state.startsWith('late:')) {
    const tm = text.match(/^(\d{1,2})[:.](\d{2})$/);
    if (now - pend.updated_at > 10 * 60000) {
      await db.clearPending(env, from.id);
    } else if (!tm || +tm[1] > 23 || +tm[2] > 59) {
      return plain(env, chat.id, 'לא הבנתי. כתבו שעה כמו 14:30');
    } else {
      const [, who, kind] = pend.state.split(':');
      await db.clearPending(env, from.id);
      const off = minutesAgoFromClock(+tm[1], +tm[2], now, env.TZ || 'Asia/Jerusalem');
      if (kind === 'walk') return send(env, chat.id, v.lateDur(who, off));
      const r = await saveLate(env, ctx, user, from.id, who, kind, off, now);
      return send(env, chat.id, await v.panel(env, user, { ...opts, notice: r.ok ? r.notice : r.toast }));
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

/* ---------- עידוד וסטיקרים ---------- */

// נמענים: בן בית אחד או כולם (חוץ מהשולח). מחזיר כמה קיבלו.
async function sendCheer(env, user, to, { text = null, sticker = null }) {
  const from = MEMBER_BY_ID[user.member].name;
  const users = (await db.listUsers(env)).filter((u) => u.chat_id && u.member !== user.member && (to === 'all' || u.member === to));
  await Promise.all(
    users.map(async (u) => {
      if (sticker) {
        await tgSafe(env, 'sendMessage', { chat_id: u.chat_id, text: `💌 סטיקר מ<b>${esc(from)}</b>`, parse_mode: 'HTML' });
        await tgSafe(env, 'sendSticker', { chat_id: u.chat_id, sticker });
      } else {
        await tgSafe(env, 'sendMessage', { chat_id: u.chat_id, text: `💌 <b>${esc(from)}</b>: ${esc(text)}`, parse_mode: 'HTML' });
      }
    }),
  );
  return users.length;
}

async function onSticker(env, msg) {
  if (msg.chat.type !== 'private') return;
  const user = await db.getUser(env, msg.from.id);
  if (!user) return;
  const pend = await db.getPending(env, msg.from.id);
  if (!pend || !pend.state.startsWith('cheer:') || Date.now() - pend.updated_at > 15 * 60000) {
    return plain(env, msg.chat.id, 'כדי לשלוח סטיקר לבן בית, לוחצים על 💌 עידוד בלוח הראשי (/menu).');
  }
  await db.clearPending(env, msg.from.id);
  const n = await sendCheer(env, user, pend.state.slice(6), { sticker: msg.sticker.file_id });
  return send(env, msg.chat.id, await v.panel(env, user, { isPrivate: true, notice: n ? `💌 הסטיקר נשלח (${n})` : 'אף אחד מהנמענים לא מחובר לבוט עדיין' }));
}

async function onCheer(env, cq, user, opts, now) {
  const msg = cq.message;
  const answer = (text, alert = false) =>
    tgSafe(env, 'answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text, show_alert: alert } : {}) });
  const [, act2, to, idx] = cq.data.split(':');
  let view;
  let toast = '';
  if (act2 === 'home') {
    await db.clearPending(env, cq.from.id);
    view = v.cheerPick(user);
  } else if (act2 === 'to') {
    if (to !== 'all' && (!MEMBER_BY_ID[to] || to === user.member)) return answer('משהו השתבש', true);
    await db.setPending(env, cq.from.id, `cheer:${to}`, 0, now);
    view = v.cheerCompose(to);
  } else if (act2 === 'p') {
    const text = CHEERS[num(idx)];
    if (!text || (to !== 'all' && !MEMBER_BY_ID[to])) return answer('משהו השתבש', true);
    await db.clearPending(env, cq.from.id);
    const n = await sendCheer(env, user, to, { text });
    toast = n ? `💌 נשלח (${n})` : 'אף אחד מהנמענים לא מחובר לבוט עדיין';
    view = await v.panel(env, user, { ...opts, notice: toast });
  }
  await Promise.all([answer(toast), view ? edit(env, msg, view) : null]);
}

/* ---------- עדכון אחורה ---------- */

// שומר ומודיע לשאר בני הבית. מחזיר את תוצאת הפעולה.
async function saveLate(env, ctx, user, tgId, who, kind, off, now) {
  const r = await act.logLate(env, who, kind, off, now);
  if (r.ok) ctx.waitUntil(broadcast(env, `🕐 ${esc(MEMBER_BY_ID[user.member].name)} עדכן/ה אחורה\n${esc(r.notice)}`, { flag: 'notify_activity', exceptTgId: tgId }));
  return r;
}

const num = (s) => parseInt(s, 10);

async function onLate(env, cq, user, ctx, opts, now) {
  const msg = cq.message;
  const [type, ...a] = cq.data.split(':');
  const answer = (text, alert = false) =>
    tgSafe(env, 'answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text, show_alert: alert } : {}) });
  const who = a[0];
  if (!MEMBER_BY_ID[who]) return answer('משהו השתבש, נסו שוב', true);
  await db.clearPending(env, cq.from.id);

  let view;
  let toast = '';
  if (type === 'lw') view = v.lateStart(who);
  else if (type === 'lk') {
    if (a[1] !== 'walk' && !LATE_KINDS.includes(a[1])) return answer('לא מוכר', true);
    view = v.lateWhen(who, a[1]);
  } else if (type === 'lx') {
    await db.setPending(env, cq.from.id, `late:${who}:${a[1]}`, 0, now);
    view = v.lateTimePrompt(who, a[1]);
  } else if (type === 'lt') {
    const off = num(a[2]);
    if (a[1] === 'walk') view = v.lateDur(who, off);
    else {
      const r = await saveLate(env, ctx, user, cq.from.id, who, a[1], off, now);
      toast = r.toast;
      view = await v.panel(env, user, { ...opts, notice: r.ok ? r.notice : '' });
    }
  } else if (type === 'ld') view = v.lateWalkBuilder(who, num(a[1]), num(a[2]), 0, 0);
  else if (type === 'lb') view = v.lateWalkBuilder(who, num(a[1]), num(a[2]), num(a[3]), num(a[4]));
  else if (type === 'ls') {
    const r = await act.walkLate(env, who, num(a[1]), num(a[2]), num(a[3]), num(a[4]), now);
    toast = r.toast;
    if (r.ok) ctx.waitUntil(broadcast(env, `🕐 ${esc(MEMBER_BY_ID[user.member].name)} עדכן/ה אחורה\n${esc(r.notice)}`, { flag: 'notify_activity', exceptTgId: cq.from.id }));
    view = await v.panel(env, user, { ...opts, notice: r.ok ? r.notice : '' });
  }
  await Promise.all([answer(toast), view ? edit(env, msg, view) : null]);
}

/* ---------- בריאות ---------- */

// ממשיך את השאלון: שומר, או מציג את השלב הבא
async function advanceWizard(env, user, draft, now) {
  const tz = env.TZ || 'Asia/Jerusalem';
  const view = hl.wizardView(draft, tz);
  if (view) {
    await hl.saveDraft(env, user.tg_id, draft, now);
    return view;
  }
  await db.clearPending(env, user.tg_id);
  const item = await hl.saveDraftResult(env, draft, user.member, now);
  if (!item) return hl.healthHome(env, now, 'הרשומה לא נמצאה');
  return hl.savedView(env, item, draft.m === 'future');
}

async function onHealth(env, cq, user, now) {
  const msg = cq.message;
  const answer = (text, alert = false) =>
    tgSafe(env, 'answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text, show_alert: alert } : {}) });
  if (!isAdmin(user)) return answer('הבריאות מנוהלת על ידי אמתי וריקי', true);
  const parts = cq.data.split(':');
  const tz = env.TZ || 'Asia/Jerusalem';

  // לחיצה על "ניתנה" או "דילגנו" בתזכורת תרופה
  if (parts[0] === 'hg') {
    const [, medId, day, time, st] = parts;
    const r = await hl.giveDose(env, num(medId), day, time, st === 'g' ? 'given' : 'skipped', user.member, now);
    await answer(r.text);
    const who = MEMBER_BY_ID[user.member].name;
    if (r.med) {
      const stamp = r.ok ? `${r.text} · ${esc(who)}` : `ℹ️ ${esc(r.text)}`;
      await edit(env, msg, { text: `💊 <b>${esc(r.med.name)}</b> · ${esc(r.med.dose)}\n${stamp}`, reply_markup: { inline_keyboard: [] } });
    }
    return;
  }

  // שאלון אירוע רפואי
  if (parts[0] === 'hw') {
    const act2 = parts[1];
    if (act2 === 'cancel') {
      await db.clearPending(env, cq.from.id);
      return Promise.all([answer('בוטל'), edit(env, msg, await hl.healthHome(env, now))]);
    }
    if (act2 === 'new') {
      if (parts[2] !== 'past' && parts[2] !== 'future') return answer('לא מוכר', true);
      return Promise.all([answer(), edit(env, msg, await advanceWizard(env, user, hl.startDraft(parts[2]), now))]);
    }
    const d = await hl.getDraft(env, cq.from.id);
    if (!d || now - d.updated_at > 30 * 60000) {
      await db.clearPending(env, cq.from.id);
      return Promise.all([answer('השאלון פג תוקף, מתחילים מחדש', true), edit(env, msg, await hl.healthHome(env, now))]);
    }
    const r = hl.applyChoice(d, act2, parts[2], now, tz);
    if (r.error) return answer(r.error, true);
    return Promise.all([answer(), edit(env, msg, await advanceWizard(env, user, r.draft, now))]);
  }

  // "בוצע" על מועד: מתעדים שנעשה ושואלים מתי לחזור
  if (parts[0] === 'hd') {
    const row = await db.getHealth(env, num(parts[1]));
    if (!row) return answer('לא נמצא', true);
    const today = startOfDay(now, tz);
    let target = row.id;
    if (!row.done) await db.markHealthDone(env, row.id, today);
    else target = await db.addHealth(env, { kind: row.kind, title: row.title, at: today, notes: null, due: null, member: user.member, done: 1 }, now);
    const draft = { m: 'return', id: target, k: row.kind, t: row.title, d: today };
    return Promise.all([answer('✅ נרשם'), edit(env, msg, await advanceWizard(env, user, draft, now))]);
  }

  if (parts[0] === 'hs') {
    const row = await db.getHealth(env, num(parts[1]));
    if (!row || !row.next_due) return answer('לא נמצא', true);
    const base = Math.max(row.next_due, startOfDay(now, tz));
    const due = startOfDay(base + 7 * 86400000 + 12 * 3600000, tz);
    await db.setHealthDue(env, row.id, due);
    await answer(`⏳ נדחה ל-${hl.fmtDate(due, tz)}`);
    return edit(env, msg, { text: `⏳ <b>${esc(row.title)}</b> נדחה ל-${hl.fmtDate(due, tz)}`, reply_markup: { inline_keyboard: [[{ text: '📅 מועדים קרובים', callback_data: 'h:due' }]] } });
  }

  if (parts[0] === 'hx') {
    const row = await db.getHealth(env, num(parts[1]));
    if (!row) return answer('כבר נמחק');
    if (!row.done) await db.deleteHealth(env, row.id);
    else await db.setHealthDue(env, row.id, null);
    await answer(`התזכורת בוטלה: ${row.title}`);
    return edit(env, msg, await hl.dueView(env, now));
  }

  if (parts[0] === 'hc') {
    const row = await db.getHealth(env, num(parts[1]));
    const ok = await hl.sendCalendar(env, msg.chat.id, row);
    return answer(ok ? '📅 שלחתי קישור וקובץ ליומן' : 'אין מועד להוסיף ליומן', !ok);
  }

  await db.clearPending(env, cq.from.id);
  const act2 = parts[1];
  let view;
  let toast = '';
  if (act2 === 'home') view = await hl.healthHome(env, now);
  else if (act2 === 'meds') view = await hl.medsView(env, now);
  else if (act2 === 'log') view = await hl.logView(env);
  else if (act2 === 'due') view = await hl.dueView(env, now);
  else if (act2 === 'medadd') {
    view = await advanceMed(env, user, wz.medStart(), now);
  } else if (act2 === 'stop') {
    const ok = await db.stopMed(env, num(parts[2]));
    toast = ok ? '⏹ התרופה הופסקה' : 'כבר הופסקה';
    view = await hl.medsView(env, now);
  } else if (act2 === 'undo') {
    const row = await db.deleteLastHealth(env, user.member, now);
    toast = row ? `נמחק: ${row.title}` : 'אין מה למחוק';
    view = await hl.logView(env);
  }
  await Promise.all([answer(toast), view ? edit(env, msg, view) : null]);
}

/* ---------- שאלונים: שעות אחריות ותרופה ---------- */

async function advanceDuty(env, user, draft, now) {
  const view = wz.dutyView(draft);
  if (view) {
    await wz.saveWiz(env, user.tg_id, 'dw', draft, now);
    return view;
  }
  await db.clearPending(env, user.tg_id);
  await wz.dutySave(env, draft);
  return v.settingsView(env, user);
}

async function advanceMed(env, user, draft, now) {
  const view = wz.medView(draft);
  if (view) {
    await wz.saveWiz(env, user.tg_id, 'mw', draft, now);
    return view;
  }
  await db.clearPending(env, user.tg_id);
  const m = await wz.medSave(env, draft, user.member, now);
  return hl.healthHome(env, now, `💊 נוספה תרופה: ${m.name} · ${m.dose} · ${m.times.join(' ')}`);
}

async function onWizard(env, cq, user, now) {
  const msg = cq.message;
  const answer = (text, alert = false) =>
    tgSafe(env, 'answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text, show_alert: alert } : {}) });
  if (!isAdmin(user)) return answer('ההגדרות והבריאות מנוהלות על ידי אמתי וריקי', true);
  const [prefix, field, value] = cq.data.split(':');
  const isDuty = prefix === 'dw';
  if (field === 'cancel') {
    await db.clearPending(env, cq.from.id);
    return Promise.all([answer('בוטל'), edit(env, msg, isDuty ? await v.settingsView(env, user) : await hl.healthHome(env, now))]);
  }
  const d = await wz.getWiz(env, cq.from.id, prefix);
  if (!d || now - d.updated_at > 30 * 60000) {
    await db.clearPending(env, cq.from.id);
    return Promise.all([answer('השאלון פג תוקף, מתחילים מחדש', true), edit(env, msg, isDuty ? await v.settingsView(env, user) : await hl.healthHome(env, now))]);
  }
  const r = isDuty ? wz.dutyChoice(d, field, value) : wz.medChoice(d, field, value);
  if (r.error) return answer(r.error, true);
  return Promise.all([answer(), edit(env, msg, isDuty ? await advanceDuty(env, user, r.draft, now) : await advanceMed(env, user, r.draft, now))]);
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

  if (/^l[wkxtdbs]:/.test(data)) return onLate(env, cq, user, ctx, opts, now);
  if (/^[dm]w:/.test(data)) return onWizard(env, cq, user, now);
  if (/^h[wdsxcg]?:/.test(data)) return onHealth(env, cq, user, now);
  if (data.startsWith('c:')) return onCheer(env, cq, user, opts, now);
  if (!isAdmin(user) && (data === 'm:settings' || data.startsWith('s:'))) {
    return Promise.all([answer('ההגדרות מנוהלות על ידי אמתי וריקי'), edit(env, msg, v.adminOnly)]);
  }

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
    else if (arg === 'late') {
      await db.clearPending(env, from.id);
      view = v.lateStart(user.member);
    } else if (arg === 'stars') view = await v.starsView(env);
    else if (arg === 'today') view = await v.todayView(env);
    else if (arg === 'settings') {
      await db.clearPending(env, from.id);
      view = await v.settingsView(env, user);
    }
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
    } else if (arg === 'da') {
      view = await advanceDuty(env, user, wz.dutyStart(), now);
    } else if (arg.startsWith('dd:')) {
      toast = (await db.deleteDuty(env, num(arg.slice(3)))) ? 'שעות האחריות נמחקו' : 'כבר נמחק';
    }
    if (!view) view = await v.settingsView(env, await db.getUser(env, from.id));
  }

  await Promise.all([answer(toast), view ? edit(env, msg, view) : null]);
}

export { DOG };
