// כאן משנים שמות, סוגי פעולות וכוכבים. שאר הקוד קורא מהקובץ הזה.

export const DOG = 'בל';

// הערה: ה-id הוא מזהה פנימי ולא משתנה. את השם אפשר לשנות בחופשיות.
export const MEMBERS = [
  { id: 'amti', name: 'אמתי' },
  { id: 'riki', name: 'ריקי' },
  { id: 'shuli', name: 'שולי' },
  { id: 'sharoli', name: 'שרולי' },
  { id: 'beri', name: 'בערי' },
];

export const MEMBER_BY_ID = Object.fromEntries(MEMBERS.map((m) => [m.id, m]));

// out: קורה בטיול ונשמר בתוך הטיול הפעיל
// star: כמה כוכבים מקבל מי שתיעד
// accident: תאונה בבית
export const KINDS = {
  pee_out: { emoji: '💧', label: 'פיפי בחוץ', out: true, star: 1 },
  poop_out: { emoji: '💩', label: 'קקי בחוץ', out: true, star: 1 },
  pee_home: { emoji: '🏠', label: 'פיפי בבית', accident: true, star: 0 },
  poop_home: { emoji: '🏠', label: 'קקי בבית', accident: true, star: 0 },
  meal: { emoji: '🍽', label: 'בל אכלה', star: 0 },
  cook: { emoji: '👩‍🍳', label: 'הכנת אוכל', star: 1 },
};

// כוכב על טיול שהסתיים
export const WALK_STAR = 1;

export const STAR_KINDS = Object.entries(KINDS)
  .filter(([, k]) => k.star > 0)
  .map(([id]) => id);

export const DEFAULTS = {
  mealNudgeMin: 20, // כמה דקות אחרי ארוחה להזכיר לצאת
  intervalMin: 180, // כל כמה זמן בלי יציאה להזכיר
  walkMaxMin: 120, // טיול פתוח נסגר לבד אחרי
  quietFrom: 22, // שעות שקט: מהשעה הזו
  quietTo: 7, // ועד השעה הזו
};

export const MEAL_NUDGE_OPTIONS = [15, 20, 30, 45];
export const INTERVAL_OPTIONS = [120, 150, 180, 240];
