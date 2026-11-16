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
