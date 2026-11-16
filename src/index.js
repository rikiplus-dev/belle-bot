import { handleUpdate } from './bot.js';
import { handleApi } from './api.js';
import { runCron } from './cron.js';
import { claimUpdate } from './db.js';
import { alertAdmin } from './telegram.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/telegram') {
      if (request.method !== 'POST') return new Response('bellebot', { status: 200 });
      if (!env.WEBHOOK_SECRET || request.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      try {
        const update = await request.json();
        // משלוח חוזר של אותו עדכון מטלגרם לא מטופל פעמיים
        if (update.update_id != null && !(await claimUpdate(env, update.update_id, Date.now()))) return new Response('ok');
        await handleUpdate(env, update, ctx, url.origin);
      } catch (e) {
        // תמיד עונים 200, אחרת טלגרם שולח שוב ושוב את אותה הודעה
        console.error('update failed', e && e.stack ? e.stack : e);
        ctx.waitUntil(alertAdmin(env, 'עדכון מטלגרם', e));
      }
      return new Response('ok');
    }

    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, ctx);
      } catch (e) {
        console.error('api failed', e && e.stack ? e.stack : e);
        return new Response(JSON.stringify({ error: 'server_error' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runCron(env).catch((e) => {
        console.error('cron failed', e && e.stack ? e.stack : e);
        return alertAdmin(env, 'קרון', e);
      }),
    );
  },
};
