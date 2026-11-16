-- הלוח הראשי של כל משתמש: הודעה אחת מוצמדת שמתעדכנת
ALTER TABLE users ADD COLUMN panel_msg INTEGER;

-- הודעות הטיול שנשלחו לבני הבית, כדי לעדכן אותן בסיום במקום לשלוח הודעה חדשה
CREATE TABLE walk_msgs (
  walk_id    INTEGER NOT NULL,
  chat_id    INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  PRIMARY KEY (walk_id, chat_id)
);
