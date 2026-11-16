-- בני בית שמחוברים לבוט (חשבון טלגרם -> בן בית)
CREATE TABLE users (
  tg_id           INTEGER PRIMARY KEY,
  member          TEXT    NOT NULL,
  chat_id         INTEGER,
  notify          INTEGER NOT NULL DEFAULT 1,   -- תזכורות אילוף ותקציר שבועי
  notify_activity INTEGER NOT NULL DEFAULT 1,   -- הודעות "טיול התחיל/הסתיים"
  created_at      INTEGER NOT NULL
);

-- טיול הוא מפגש: פותחים, מתעדים בתוכו פיפי וקקי בחוץ, וסוגרים
CREATE TABLE walks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  member      TEXT    NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  auto_closed INTEGER NOT NULL DEFAULT 0
);
-- לכל היותר טיול פתוח אחד בכל רגע
CREATE UNIQUE INDEX one_open_walk ON walks((1)) WHERE ended_at IS NULL;
CREATE INDEX idx_walks_started ON walks(started_at DESC);

-- פעולות: pee_out, poop_out, pee_home, poop_home, meal, cook
CREATE TABLE events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  kind    TEXT    NOT NULL,
  member  TEXT    NOT NULL,
  walk_id INTEGER,
  source  TEXT    NOT NULL DEFAULT 'bot'
);
CREATE INDEX idx_events_ts ON events(ts DESC);
CREATE INDEX idx_events_walk ON events(walk_id);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- תזכורות שכבר נשלחו, כדי לא לשלוח פעמיים
CREATE TABLE reminders (
  key     TEXT PRIMARY KEY,
  sent_at INTEGER NOT NULL
);

-- הצטרפות: מחכים לקוד משפחה או לבחירת בן בית
CREATE TABLE pending (
  tg_id      INTEGER PRIMARY KEY,
  state      TEXT    NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
