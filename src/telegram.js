// קריאות ל-API של טלגרם.

export async function tg(env, method, body = {}, retried = false) {
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
    // יותר מדי הודעות: מחכים כמה שהתבקשנו (עד 3 שניות) ומנסים פעם אחת
    const wait = data && data.parameters && data.parameters.retry_after;
    if (res.status === 429 && !retried && wait && wait <= 3) {
      await new Promise((r) => setTimeout(r, wait * 1000 + 100));
      return tg(env, method, body, true);
    }
    const err = new Error(`telegram ${method}: ${(data && data.description) || res.status}`);
    err.description = (data && data.description) || '';
    err.status = res.status;
    // המשתמש חסם את הבוט או מחק את הצ'אט: לא ממשיכים לשלוח אליו
    if ((res.status === 403 || /chat not found/i.test(err.description)) && body.chat_id && env.DB) {
      try {
        await env.DB.prepare('UPDATE users SET chat_id=NULL WHERE chat_id=?').bind(body.chat_id).run();
      } catch {
        // לא קריטי
      }
    }
    throw err;
  }
  return data.result;
}

// התראה למנהלים על תקלה. הודעה זהה נשלחת לכל היותר פעם בשעה, כדי לא להציף.
export async function alertAdmin(env, where, error) {
  try {
    const msg = String((error && error.message) || error || '').slice(0, 300);
    const hour = Math.floor(Date.now() / 3600000);
    const key = `alert:${where}:${msg.slice(0, 60)}:${hour}`;
    const r = await env.DB.prepare('INSERT OR IGNORE INTO reminders(key,sent_at) VALUES(?,?)').bind(key, Date.now()).run();
    if (r.meta.changes !== 1) return;
    const { results } = await env.DB.prepare("SELECT chat_id FROM users WHERE chat_id IS NOT NULL AND member IN ('amti','riki')").all();
    await Promise.all(
      results.map((u) =>
        tgSafe(env, 'sendMessage', { chat_id: u.chat_id, text: `⚠️ <b>תקלה בבלבוט</b> (${esc(where)})\n<code>${esc(msg)}</code>`, parse_mode: 'HTML' }),
      ),
    );
  } catch (e) {
    console.warn('alertAdmin failed', e && e.message);
  }
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
