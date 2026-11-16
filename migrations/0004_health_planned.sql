-- done=0: תזכורת עתידית שעוד לא בוצעה. done=1: אירוע שכבר היה.
ALTER TABLE health_log ADD COLUMN done INTEGER NOT NULL DEFAULT 1;
