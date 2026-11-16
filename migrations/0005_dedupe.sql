-- עדכונים שכבר טופלו, כדי שמשלוח חוזר של טלגרם לא יתועד פעמיים
CREATE TABLE processed_updates (
  update_id INTEGER PRIMARY KEY,
  ts        INTEGER NOT NULL
);
