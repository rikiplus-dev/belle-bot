// מחבר את הבוט לטלגרם: webhook, פקודות, תיאור וכפתור לוח הבקרה.
// רץ אוטומטית אחרי כל פריסה. אפשר גם ידנית:
//   BOT_TOKEN=... WEBHOOK_SECRET=... WORKER_URL=https://bellebot.xxx.workers.dev node scripts/telegram-setup.mjs

export async function setupTelegram({ token, secret, url }) {
  const call = async (method, body = {}) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error(`${method}: ${data.description || res.status}`);
    return data.result;
  };

  const me = await call('getMe');
  await call('setWebhook', {
    url: `${url}/telegram`,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  await call('setMyCommands', {
    commands: [
      { command: 'menu', description: 'הלוח הראשי' },
      { command: 'walk', description: 'יוצאים לטיול' },
      { command: 'stars', description: 'כוכבים השבוע' },
      { command: 'today', description: 'מה היה היום' },
      { command: 'undo', description: 'ביטול הפעולה האחרונה' },
      { command: 'settings', description: 'הגדרות' },
      { command: 'help', description: 'עזרה' },
    ],
  });
  await call('setMyShortDescription', { short_description: 'העוזר המשפחתי לאילוף של בל 🐶' });
  await call('setMyDescription', {
    description:
      'בלבוט: מתעדים פיפי וקקי בחוץ ובבית, טיולים, אוכל וכוכבים לבני הבית. כל מה שצריך כדי לאלף את בל.',
  });
  await call('setChatMenuButton', {
    menu_button: { type: 'web_app', text: '📊 לוח בקרה', web_app: { url } },
  });
  return me;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { BOT_TOKEN, WEBHOOK_SECRET, WORKER_URL } = process.env;
  if (!BOT_TOKEN || !WEBHOOK_SECRET || !WORKER_URL) {
    console.error('חסרים BOT_TOKEN, WEBHOOK_SECRET או WORKER_URL');
    process.exit(1);
  }
  const me = await setupTelegram({ token: BOT_TOKEN, secret: WEBHOOK_SECRET, url: WORKER_URL.replace(/\/$/, '') });
  console.log(`הבוט @${me.username} מחובר אל ${WORKER_URL}`);
}
