// קריאות ל-API של טלגרם.

export async function tg(env, method, body = {}) {
  const base = env.TELEGRAM_API || 'https://api.telegram.org';
  const res = await fetch(`${base}/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // תשובה לא תקינה
  }
  if (!data || !data.ok) {
    const err = new Error(`telegram ${method}: ${(data && data.description) || res.status}`);
    err.description = (data && data.description) || '';
    throw err;
  }
  return data.result;
}

// קריאה שלא זורקת שגיאה. משמשת להודעות משניות.
export async function tgSafe(env, method, body) {
  try {
    return await tg(env, method, body);
  } catch (e) {
    if (!/not modified/i.test(e.message)) console.warn(e.message);
    return null;
  }
}

export const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// שליחת קובץ (טקסט) כמסמך
export async function tgDocument(env, chatId, filename, content, mime = 'text/plain', caption = '') {
  try {
    const base = env.TELEGRAM_API || 'https://api.telegram.org';
    const form = new FormData();
    form.set('chat_id', String(chatId));
    if (caption) form.set('caption', caption);
    form.set('document', new Blob([content], { type: mime }), filename);
    const res = await fetch(`${base}/bot${env.BOT_TOKEN}/sendDocument`, { method: 'POST', body: form });
    return res.ok;
  } catch (e) {
    console.warn(e.message);
    return false;
  }
}
