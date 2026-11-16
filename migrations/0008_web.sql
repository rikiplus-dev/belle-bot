-- כניסה ללוח הבקרה בלי טלגרם: קישור אישי לבן בית (נשמר כגיבוב בלבד)
CREATE TABLE web_tokens (
  hash       TEXT PRIMARY KEY,
  member     TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
