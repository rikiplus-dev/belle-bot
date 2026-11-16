// רץ ב-GitHub Actions בכל דחיפה ל-main:
// 1. מוודא שיש מסד D1 (ויוצר אם אין)  2. מריץ מיגרציות  3. מפרסם  4. מגדיר סודות  5. מחבר את הבוט לטלגרם
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { PLACEHOLDER, findDatabaseId, withDatabaseId, parseWorkerUrl, missingEnv } from './lib.mjs';
import { setupTelegram } from './telegram-setup.mjs';

const DB_NAME = 'bellebot';
const missing = missingEnv(process.env);
if (missing.length) {
  console.error(`חסרים סודות ב-GitHub (Settings > Secrets and variables > Actions): ${missing.join(', ')}`);
  process.exit(1);
}

const wrangler = (args, { quiet = false } = {}) => {
  try {
    const out = execFileSync('npx', ['wrangler', ...args], {
      encoding: 'utf8',
      env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 20 * 1024 * 1024,
    });
    if (!quiet) process.stdout.write(out);
    return out;
  } catch (e) {
    process.stdout.write(String(e.stdout || ''));
    process.stderr.write(String(e.stderr || ''));
    throw new Error(`wrangler ${args.slice(0, 2).join(' ')} נכשל`);
  }
};

try {
  // 1. מסד נתונים
  console.log('▶ בודק מסד נתונים');
  let id = findDatabaseId(wrangler(['d1', 'list', '--json'], { quiet: true }), DB_NAME);
  if (!id) {
    console.log('  יוצר מסד חדש בשם', DB_NAME);
    wrangler(['d1', 'create', DB_NAME]);
    id = findDatabaseId(wrangler(['d1', 'list', '--json'], { quiet: true }), DB_NAME);
  }
  if (!id) throw new Error('לא הצלחנו למצוא או ליצור את מסד הנתונים. בדקו שלטוקן יש הרשאת D1 Edit.');
  const cfg = readFileSync('wrangler.jsonc', 'utf8');
  if (cfg.includes(PLACEHOLDER)) writeFileSync('wrangler.jsonc', withDatabaseId(cfg, id));

  // 2. מיגרציות
  console.log('▶ מעדכן טבלאות');
  wrangler(['d1', 'migrations', 'apply', 'DB', '--remote']);

  // 3. פרסום
  console.log('▶ מפרסם');
  const deployOut = wrangler(['deploy']);
  const url = parseWorkerUrl(deployOut) || (process.env.WORKER_URL || '').replace(/\/$/, '');
  if (!url) throw new Error('לא מצאנו את כתובת ה-Worker. אפשר להגדיר משתנה WORKER_URL ב-GitHub.');

  // 4. סודות
  console.log('▶ מגדיר סודות');
  const file = '.secrets.tmp.json';
  writeFileSync(
    file,
    JSON.stringify({
      BOT_TOKEN: process.env.BOT_TOKEN,
      WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
      FAMILY_CODE: process.env.FAMILY_CODE,
    }),
  );
  try {
    wrangler(['secret', 'bulk', file], { quiet: true });
  } finally {
    rmSync(file, { force: true });
  }

  // 5. טלגרם
  console.log('▶ מחבר את הבוט לטלגרם');
  const me = await setupTelegram({ token: process.env.BOT_TOKEN, secret: process.env.WEBHOOK_SECRET, url });
  console.log(`\n✅ הכול עובד. הבוט @${me.username} מחובר אל ${url}`);
} catch (e) {
  console.error('\n❌', e.message);
  process.exit(1);
}
