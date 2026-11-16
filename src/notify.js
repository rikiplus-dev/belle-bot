// שליחת הודעות לבני הבית.
import * as db from './db.js';
import { tgSafe } from './telegram.js';
import { walkStartedText, walkEndedText, cheerMarkup } from './views.js';

// flag: 'notify' (תזכורות) או 'notify_activity' (הודעות על טיולים)
// members: אם ניתן, שולחים רק לבני הבית האלה
// הודעות פעילות נשלחות בשקט (בלי צליל). תזכורות עם צליל.
export async function broadcast(env, text, { flag = 'notify', exceptTgId = null, markup = null, members = null, onSent = null } = {}) {
  const users = await db.listUsers(env);
  const targets = users.filter((u) => u[flag] && u.chat_id && u.tg_id !== exceptTgId && (!members || members.includes(u.member)));
  const silent = flag === 'notify_activity';
  const sent = await Promise.all(
    targets.map(async (u) => {
      const r = await tgSafe(env, 'sendMessage', {
        chat_id: u.chat_id,
        text,
        parse_mode: 'HTML',
        ...(silent ? { disable_notification: true } : {}),
        ...(markup ? { reply_markup: markup } : {}),
      });
      if (r && onSent) await onSent(u, r);
      return r;
    }),
  );
  return sent.filter(Boolean).length;
}

// "פלוני הוציא את בל": הודעה אחת שנשלחת בשקט
export function announceWalkStart(env, user, walkId) {
  return broadcast(env, walkStartedText(user.member), {
    flag: 'notify_activity',
    exceptTgId: user.tg_id,
    markup: cheerMarkup(user.member),
    onSent: (u, r) => db.saveWalkMsg(env, walkId, u.chat_id, r.message_id),
  });
}

// בסיום, מעדכנים את אותה הודעה במקום לשלוח חדשה (התראה אחת לטיול)
export async function announceWalkEnd(env, user, r) {
  const text = walkEndedText(r);
  const markup = cheerMarkup(user.member);
  const walkId = r.walk && r.walk.id;
  const msgs = walkId ? await db.walkMsgs(env, walkId) : [];
  const users = (await db.listUsers(env)).filter((u) => u.notify_activity && u.chat_id && u.tg_id !== user.tg_id);
  let n = 0;
  await Promise.all(
    users.map(async (u) => {
      const m = msgs.find((x) => x.chat_id === u.chat_id);
      let ok = null;
      if (m) ok = await tgSafe(env, 'editMessageText', { chat_id: u.chat_id, message_id: m.message_id, text, parse_mode: 'HTML', reply_markup: markup });
      if (!ok) ok = await tgSafe(env, 'sendMessage', { chat_id: u.chat_id, text, parse_mode: 'HTML', disable_notification: true, reply_markup: markup });
      if (ok) n++;
    }),
  );
  return n;
}
