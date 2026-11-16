-- שעות אחריות: בזמן הזה רק בן הבית המוגדר מקבל תזכורות אילוף.
-- days = "0,1,2,3,4" (0 = ראשון). start_min/end_min = דקות מתחילת היום. אם end <= start, זה נמשך עד הבוקר שאחרי.
CREATE TABLE duty (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  member    TEXT    NOT NULL,
  days      TEXT    NOT NULL,
  start_min INTEGER NOT NULL,
  end_min   INTEGER NOT NULL
);
