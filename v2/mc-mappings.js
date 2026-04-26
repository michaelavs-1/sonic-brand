/* SonicBrand v2 — Multiple-Choice → Fader value mappings
   Each MC question has 5 options; selection maps to a 0-100 value
   compatible with the existing brain's fader/audio param logic. */
window.SB_V2_MC = {
  familiarity: {
    label: 'כמה מוכרת תרצו שהמוזיקה תהיה?',
    icon: '🎤',
    options: [
      { id: 1, label: 'שירה בציבור',          subtitle: 'להיטים שכולם מכירים, מסיבת קריוקי', value: 95 },
      { id: 2, label: 'להיטים לצד הפתעות',     subtitle: 'מוזיקה ידועה עם נגיעות לא צפויות',   value: 72 },
      { id: 3, label: 'לא חייבים לבחור',       subtitle: 'מאוזן בין מוכר ובין גילוי',           value: 50 },
      { id: 4, label: 'החבר שמבין',            subtitle: 'בחירות של חבר עם טעם, פחות רדיו',    value: 30 },
      { id: 5, label: 'חוויה ייחודית',         subtitle: 'גילויים, אנדרגראונד, מוזיקה נדירה',  value: 12 },
    ],
    default: 3,
  },
  hebrew: {
    label: 'איזה שילוב של עברית ולועזית?',
    icon: '🇮🇱',
    options: [
      { id: 1, label: 'רק עברית',              subtitle: 'אוצר ישראלי בלבד',                     value: 100 },
      { id: 2, label: 'בעיקר עברית',           subtitle: 'יותר ישראלי, מעט בינלאומי',           value: 70 },
      { id: 3, label: 'לא חייבים לבחור',       subtitle: 'תערובת מאוזנת',                         value: 50 },
      { id: 4, label: 'בעיקר לועזית',          subtitle: 'יותר בינלאומי, מעט ישראלי',           value: 30 },
      { id: 5, label: 'רק לועזית',             subtitle: 'בינלאומי בלבד',                         value: 0 },
    ],
    default: 3,
  },
  vocal: {
    label: 'כמה ירצו לשמוע שירה בפלייליסט?',
    icon: '🎙️',
    options: [
      { id: 1, label: 'כולם שרים',             subtitle: 'שירה דומיננטית בכל שיר',               value: 92 },
      { id: 2, label: 'בעיקר שרים',            subtitle: 'מרבית השירים עם ווקאל',                value: 70 },
      { id: 3, label: 'לא חייבים לבחור',       subtitle: 'תערובת של שירה ואינסטרומנטלי',          value: 50 },
      { id: 4, label: 'בעיקר אינסטרומנטלי',    subtitle: 'בעיקר ללא שירה, עם נגיעות ווקאליות',  value: 28 },
      { id: 5, label: 'ללא שירה',              subtitle: 'אינסטרומנטלי בלבד / אווירה',          value: 8 },
    ],
    default: 3,
  },
  energy: {
    label: 'מה רמת האנרגיה הכללית?',
    icon: '⚡',
    options: [
      { id: 1, label: 'רגוע ועדין',            subtitle: 'אווירה צ׳ילית, נסיגה',                  value: 18 },
      { id: 2, label: 'נינוח',                 subtitle: 'מתון, נעים לרקע',                       value: 36 },
      { id: 3, label: 'לא חייבים לבחור',       subtitle: 'אנרגיה מאוזנת',                         value: 52 },
      { id: 4, label: 'תוסס',                  subtitle: 'מלא חיים, עם קצב',                      value: 72 },
      { id: 5, label: 'אנרגטי מאוד',           subtitle: 'דוחף, מסיבתי',                          value: 90 },
    ],
    default: 3,
  },
  era: {
    label: 'אילו שנים מתאימות לעסק?',
    icon: '📅',
    options: [
      { id: 1, label: 'רטרו וקלאסי',           subtitle: 'לפני 2000, נוסטלגיה',                  value: 12 },
      { id: 2, label: 'שנות ה-2000',            subtitle: 'גם 90s וגם תחילת המילניום',            value: 32 },
      { id: 3, label: 'לא חייבים לבחור',       subtitle: 'מקלאסי לעכשווי',                        value: 50 },
      { id: 4, label: 'עכשווי',                 subtitle: '2010 והלאה',                            value: 72 },
      { id: 5, label: 'הכי חדש',                subtitle: 'רק 3 שנים אחרונות',                    value: 92 },
    ],
    default: 3,
  },
};

/* Helper: convert MC selection to faders object compatible with existing brain */
window.SB_V2_mcToFaders = function(mc){
  return {
    familiarity: (window.SB_V2_MC.familiarity.options[mc.familiarity-1] || {}).value || 50,
    hebrew:      (window.SB_V2_MC.hebrew.options[mc.hebrew-1]           || {}).value || 50,
    vocal:       (window.SB_V2_MC.vocal.options[mc.vocal-1]             || {}).value || 50,
    energy:      (window.SB_V2_MC.energy.options[mc.energy-1]           || {}).value || 50,
    era:         (window.SB_V2_MC.era.options[mc.era-1]                 || {}).value || 50,
  };
};
