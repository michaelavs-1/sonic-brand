/* SonicBrand — Multiple-Choice → Fader value mappings */
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
};

/* Helper: convert MC selection to faders object.
   vocal / energy / era are now auto-determined by the system. */
window.SB_V2_mcToFaders = function(mc){
  return {
    familiarity: (window.SB_V2_MC.familiarity.options[(mc.familiarity||3)-1] || {}).value || 50,
    hebrew:      (window.SB_V2_MC.hebrew.options[(mc.hebrew||3)-1]           || {}).value || 50,
    vocal:       50,   // auto — determined by business type via Data Box
    energy:      50,   // auto — playlist generates both calm and energetic
    era:         50,   // auto — GPT uses Data Box context
  };
};
