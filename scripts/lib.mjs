// פונקציות עזר לסקריפטים של הפריסה. אין בהן רשת, כדי שאפשר לבדוק אותן.

export const PLACEHOLDER = 'REPLACE_WITH_DATABASE_ID';

export function parseWorkerUrl(output) {
  const m = String(output).match(/https:\/\/[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.workers\.dev/i);
  return m ? m[0] : null;
}

export function withDatabaseId(configText, id) {
  if (!configText.includes(PLACEHOLDER)) return configText;
  return configText.replaceAll(PLACEHOLDER, id);
}

// wrangler d1 list --json מחזיר מערך עם uuid ו-name
export function findDatabaseId(listOutput, name) {
  let rows;
  try {
    rows = JSON.parse(listOutput);
  } catch {
    const start = listOutput.indexOf('[');
    rows = start >= 0 ? JSON.parse(listOutput.slice(start)) : [];
  }
  const row = (Array.isArray(rows) ? rows : []).find((r) => r.name === name);
  return row ? row.uuid || row.id || null : null;
}

export const REQUIRED_ENV = [
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'BOT_TOKEN',
  'WEBHOOK_SECRET',
  'FAMILY_CODE',
];

export function missingEnv(env) {
  return REQUIRED_ENV.filter((k) => !env[k] || !String(env[k]).trim());
}
