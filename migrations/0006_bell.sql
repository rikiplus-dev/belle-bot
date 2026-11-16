-- משקל לאורך זמן (בגרמים)
CREATE TABLE weights (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,
  grams  INTEGER NOT NULL,
  member TEXT    NOT NULL
);
CREATE INDEX idx_weights_ts ON weights(ts DESC);

-- התקדמות באילוף: kind = social (חיברות, level 1 = נעשה) או cmd (פקודות, level 1..3)
CREATE TABLE progress (
  kind   TEXT    NOT NULL,
  item   TEXT    NOT NULL,
  level  INTEGER NOT NULL DEFAULT 0,
  at     INTEGER,
  member TEXT,
  PRIMARY KEY (kind, item)
);
