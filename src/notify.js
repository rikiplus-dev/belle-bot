// שליחת הודעות לבני הבית.
import * as db from './db.js';
import { tgSafe } from './telegram.js';

// flag: 'notify' (תזכורות) או 'notify_activity' (הודעות על טיולים)
export async function broadcast(env, text, { flag = 'notify', exceptTgId = null, markup = null } = {}) {
  const users = await db.listUsers(env);
  const targets = users.filter((u) => u[flag] && u.chat_id && u.tg_id !== exceptTgId);
  await Promise.all(
    targets.map((u) =>
      tgSafe(env, 'sendMessage', {
        chat_id: u.chat_id,
        text,
        parse_mode: 'HTML',
        ...(markup ? { reply_markup: markup } : {}),
      }),
    ),
  );
  return targets.length;
}
