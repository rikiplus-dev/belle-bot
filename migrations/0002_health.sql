-- יומן רפואי: חיסונים, בדיקות, ביקורים, ניתוחים. next_due = מתי לחזור
CREATE TABLE health_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  at         INTEGER NOT NULL,
  notes      TEXT,
  next_due   INTEGER,
  member     TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX health_at ON health_log(at DESC);
CREATE INDEX health_due ON health_log(next_due);

-- תרופות: times = "08:00,20:00". end_at ריק = ללא הגבלה
CREATE TABLE meds (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  dose       TEXT    NOT NULL,
  times      TEXT    NOT NULL,
  start_at   INTEGER NOT NULL,
  end_at     INTEGER,
  active     INTEGER NOT NULL DEFAULT 1,
  member     TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

-- מה נתנו בפועל. slot = "20261116 0800"
CREATE TABLE med_doses (
  med_id INTEGER NOT NULL,
  slot   TEXT    NOT NULL,
  status TEXT    NOT NULL,
  at     INTEGER NOT NULL,
  member TEXT    NOT NULL,
  PRIMARY KEY (med_id, slot)
);
