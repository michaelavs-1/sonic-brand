/* SonicBrands — Data Box v1
   מאגר הידע המוזיקלי לפי סוג עסק.
   מקור: גיליון "Data Box - AI playlist" של Michael Avshalom.
   זהו ה-L0 של מוח Robin — האמת הבסיסית שעליה כל שאר השכבות נבנות. */

window.SB_DATA_BOX = {

  vibes: [
    'קליל','רקיד','אורבני','משפחתי','רגוע',
    'אינטימי','אלגנטי','צעיר','מודרני','חאפלה',
    'סקסי','קצבי','יוקרתי','בועט','אפל'
  ],

  entries: [

    /* ══════════════════════════════
       בָּרִים, פָּאבִים, חַיֵּי לַיְלָה
    ══════════════════════════════ */
    {
      id: 'neighborhood_bar',
      label: 'בר שכונתי / פאב',
      keywords: ['בר','פאב','שכונתי','pub','bar','ביליארד','בירה','beer','tavern'],
      genres: 'Lo-Fi / Indie / Rock',
      playlists: [
        { id:'4wwqBmPvztunSovwUcuEbY', moods:['קליל','קצבי','אורבני','צעיר'] },
        { id:'1AQI4Itc8ufEZOTuhVm1ih', moods:['אורבני','אפל','קצבי'] },
        { id:'61jNo7WKLOIQkahju8i0hw', moods:['קצבי','צעיר','בועט'] },
        { id:'37i9dQZF1DX6Gwl5uG0dwX', moods:['קצבי','בועט'] },
        { id:'72JbwSy5zwNH17Fy1Dzxro', moods:['קצבי','קליל','בועט'] },
        { id:'5JMSQOMQq5Pvj0wyGdsOIN', moods:['קצבי','קליל','בועט','צעיר'] },
        { id:'2nFiBPsadcJtkZB9wVwQ1j', moods:['קצבי','בועט'] },
        { id:'1ZYiwkcUa0pZUAbyrFUnO6', moods:[] },
        { id:'6MNEDiFcAkOB5peLM7pnp2', moods:[] },
        { id:'3QwpkIyfYJ3KP1OYEM1wFG', moods:[] },
        { id:'1ZkZA7a9Fdw26WZyIV58Gw', moods:[] },
      ],
      energyLow:  { label:'אינדי ולו-פיי', description:'כשהמקום עדיין שקט ואנשים מתחילים להגיע — מוזיקה שמאפשרת שיחה ומרגישה כמו הבר שאוהבים.' },
      energyHigh: { label:'רוק ובועט', description:'כשהמקום מלא והאנרגיה מרקיעה — גיטרות, ביטים, ואנשים שמרגישים בבית.' },
      purpose: 'a nostalgic, casual atmosphere — familiar rock and indie create a relaxed social environment',
      category: 'bars'
    },

    {
      id: 'wine_bar',
      label: 'בר יין',
      keywords: ['יין','בר יין','וויסקי','ויסקי','ורמוט','wine bar','wine','קנטינה','cantina'],
      genres: 'RnB / Beats / Smooth Jazz / Bossa Nova / French Jazz / Vocal Jazz',
      playlists: [
        { id:'6bX6RfpkoRwqH3at702xja', moods:['אלגנטי','קצבי','סקסי'] },
        { id:'37i9dQZF1DWWgccrbg3zbJ', moods:['אלגנטי','אינטימי','קצבי','יוקרתי'] },
        { id:'37i9dQZF1E4xdJ0ma3vTH1', moods:['מודרני','קצבי','אורבני'] },
        { id:'26hCFGqpzWO7WcDfaoSxzG', moods:['אלגנטי','משפחתי','יוקרתי','קליל'] },
        { id:'39tLdLdPZHekU6bPJLwe3n', moods:['סקסי','קצבי','אלגנטי'] },
        { id:'0V1Xw5HVMI5fpYt81uMkca', moods:['סקסי','קצבי','אלגנטי'] },
        { id:'3gcZeTnpMILN1Jv0tQcTit', moods:['קצבי','קליל'] },
      ],
      energyLow:  { label:'ג׳אז צרפתי ובוסה נובה', description:'לתחילת הערב — שיחה נינוחה, טעימות ראשונות. המוזיקה יושבת מתחת לשיחה, לא מעליה.' },
      energyHigh: { label:'RnB וביטים סקסיים', description:'לערב שמתחמם. הראש טיפה זז מצד לצד, הבקבוק השני כבר הוזמן.' },
      purpose: 'sophisticated, cozy atmosphere — music sits underneath conversation, enables intimacy and slow drinking',
      category: 'bars'
    },

    {
      id: 'dance_bar',
      label: 'דאנס בר',
      keywords: ['דאנס','ריקוד','ריקודים','מועדון','club','dance bar','clubbing','דיסקו'],
      genres: 'Indie Dance / Vocal House / Afro House / Deep House / Hip Hop / EDM / Pop Remixes',
      playlists: [
        { id:'2S2R3fAMQ0APh45cU1TAth', moods:['בועט','רקיד','צעיר','קצבי','מודרני'] },
        { id:'37i9dQZF1DXcZDD7cfEKhW', moods:['בועט','רקיד','צעיר','קצבי','מודרני'] },
        { id:'37i9dQZF1E4qQ00I1Jm1ay', moods:['צעיר','אורבני','קצבי','סקסי'] },
        { id:'3EOra0sJJ4vKRVf49KZGNh', moods:['צעיר','רקיד','אורבני','מודרני'] },
        { id:'1po9a30RIjEq96GciF2OvY', moods:['רקיד','אורבני','אפל','צעיר'] },
        { id:'487jKTFqWhs6b0AEUz0WpX', moods:['רקיד','צעיר','אורבני','מודרני','אפל'] },
        { id:'3DaU9QPNMVXNwegTUPamNw', moods:['רקיד','צעיר','אורבני','מודרני','אפל'] },
      ],
      energyLow:  { label:'פופ קצבי ורמיקסים', description:'להיכנס לזרם — ביטים שמניעים אבל עדיין מאפשרים לדבר. לפני שהמסיבה מתחילה.' },
      energyHigh: { label:'דיפ האוס ואלקטרו', description:'מסיבה מלאה — בייס, רמיקסים, אנרגיה שמכריחה לזוז.' },
      purpose: 'high energy — bass and tempo force close conversation, push alcohol sales, fusion of dancing and bar talk',
      category: 'bars'
    },

    {
      id: 'cocktail_bar',
      label: 'בר קוקטיילים',
      keywords: ['קוקטיל','קוקטיילים','cocktail','cocktails','מיקסולוגי','mixology','aperitivo'],
      genres: 'Lofi / Bossa Nova / Vocal Jazz / Jazzy House',
      playlists: [
        { id:'5R3X2RiiFhNaiNsZbteZfs', moods:['רגוע','אלגנטי','יוקרתי','אינטימי'] },
        { id:'37i9dQZF1DWWgccrbg3zbJ', moods:['משפחתי','קצבי','אלגנטי','יוקרתי','קליל'] },
        { id:'37i9dQZF1DX0khTY3HFA4M', moods:['סקסי','קצבי','אפל','אלגנטי'] },
        { id:'79jjnPCe2TK4N3vTGfYJXK', moods:['אלגנטי','משפחתי','יוקרתי','קליל'] },
        { id:'37i9dQZF1DX6syac0fWYdV', moods:['רקיד','צעיר','אפל','אלגנטי','סקסי'] },
        { id:'7i8PotqqlAb88Bwybh7PAk', moods:['רקיד','צעיר','אפל','אלגנטי','סקסי'] },
      ],
      energyLow:  { label:'בוסה נובה וווקאל ג׳אז', description:'שיחה שקטה מעל הקוקטייל הראשון — אלגנטי, אינטימי, נינוח.' },
      energyHigh: { label:'ג׳אזי האוס וביטים', description:'לקוקטייל השני — ביטים שמניעים אבל לא שוברים את האווירה.' },
      purpose: 'music sits underneath conversation — cool, modern, subtle. Never louder than the conversation',
      category: 'bars'
    },

    {
      id: 'culinary_bar',
      label: 'בר קולינרי / גסטרו בר',
      keywords: ['גסטרו','קולינרי','culinary','גסטרובר','gastro','food and drinks','אוכל ובר','ביסטרו בר'],
      genres: 'Soul / Neo-Soul / Lo-Fi Beats / 90s-2000s Hip Hop / RnB',
      playlists: [
        { id:'6N7E8beWM4r4tXNmo5NbJX', moods:['אורבני','קצבי','סקסי'] },
        { id:'0bhpV9zKrJiCjdv6xX9wdc', moods:['אורבני','צעיר','קצבי'] },
        { id:'37i9dQZF1DWYoYGBbGKurt', moods:['רגוע','אינטימי','אלגנטי'] },
        { id:'3WwBMqBr5TupGBwW9Ve9Pf', moods:['קצבי','סקסי','מודרני','בועט','אורבני'] },
        { id:'33alWtYP5HBWhRaji8k212', moods:['קצבי','אורבני','קליל'] },
        { id:'3gcZeTnpMILN1Jv0tQcTit', moods:['קצבי','קליל'] },
        { id:'2XD24lgANiicaKd38DWBpg', moods:[] },
      ],
      energyLow:  { label:'סול ו-RnB רך', description:'ארוחה ראשונה — מוזיקה שמבדילה אתכם ממסעדה רגילה, אבל עדיין מאפשרת שיחה.' },
      energyHigh: { label:'היפ הופ וביטים גרובי', description:'כשהמקום מתחמם — קצב שמרים, ראשים זזים בין ביס לביס.' },
      purpose: 'modern, late-night groove — music distinguishes bar from restaurant, enables table conversation, feels sophisticated',
      category: 'bars'
    },

    {
      id: 'hotel_bar',
      label: 'בר מלון / לובי מלון',
      keywords: ['מלון','לובי','hotel','lobby','בר מלון','hotel bar','לאונג׳','lounge'],
      genres: 'Instrumental / Chill / New Wave / Soft Jazz',
      playlists: [
        { id:'6k9bh7kZWzm6fsZxrVm92U', moods:['צעיר','קליל'] },
        { id:'5R3X2RiiFhNaiNsZbteZfs', moods:['יוקרתי','קליל','אינטימי'] },
        { id:'37i9dQZF1DWVqfgj8NZEp1', moods:['יוקרתי','אלגנטי','אינטימי','רגוע'] },
        { id:'6xwz5O60HTBCBJEeUceBGB', moods:['יוקרתי','אלגנטי','רגוע','אינטימי'] },
        { id:'5rWwygGtLi1Ro8JtwNJZns', moods:['רגוע','אלגנטי','יוקרתי'] },
      ],
      energyLow:  { label:'ג׳אז רך ואינסטרומנטלי', description:'קבלת פנים — מוזיקה שמחברת בין הנכנסים לאווירת הלובי. אלגנטי, שקט, מפנה מקום.' },
      energyHigh: { label:'צ׳יל אלקטרו וניו-ווייב', description:'כשהבר מתחיל להתמלא — קצב עדין שמרגיש מודרני ומרים את האווירה.' },
      purpose: 'welcoming, calming — connects new arrivals to the existing lobby atmosphere, universal and upscale',
      category: 'bars'
    },

    /* ══════════════════════════════
       מִסְעָדוֹת
    ══════════════════════════════ */
    {
      id: 'workers_restaurant',
      label: 'מסעדת פועלים / שוק',
      keywords: ['פועלים','שוק','עממי','מאפה','ארוחת עובדים','מזרחי עממי','חפיף','חפיפון'],
      genres: 'מוזיקה מזרחית ישנה / שירים טורקים / נעימות צפון אפריקאיות',
      playlists: [
        { id:'2z4tm86ivNjyO3oKDpVOnV', moods:[] },
        { id:'1w26vYQCXCnritR3Zjl8Ho', moods:[] },
        { id:'1YAsFTPgF2keIHbcpYnHDU', moods:[] },
        { id:'7MT2zvfmRxAPEP1f3VKvAp', moods:[] },
        { id:'53GX7x7Z6bfrESNL7ndTKK', moods:['חאפלה','קצבי'] },
      ],
      energyLow:  { label:'מזרחית עדינה וקלאסית', description:'לארוחה שקטה — נגינות צפון אפריקאיות ותורכיות שמוציאות נוסטלגיה.' },
      energyHigh: { label:'מזרחית קצבית ורועשת', description:'לאנרגיית הצהריים — ביטים, ריתמוסים, ואנשים שמרגישים בבית.' },
      purpose: 'familiar north-african and iraqi atmosphere — nostalgic, authentic, culturally resonant for the community',
      category: 'restaurants'
    },

    {
      id: 'chef_restaurant',
      label: 'מסעדת שף / ביסטרו / יוקרה',
      keywords: ['שף','מסעדת שף','ביסטרו','יוקרה','fine dining','גורמה','gourmet','מסעדה יוקרתית','איטלקית','צרפתית','יפנית','תאילנדית','אסייתית','אירופאית'],
      genres: 'World Jazz / Instrumental Funk / French Jazz / Soul & Soulful House',
      playlists: [
        { id:'37i9dQZF1EIgOj03IPzJ1N', moods:['רגוע','אינטימי','משפחתי','אלגנטי'] },
        { id:'1wVXfJA0uiOCX0ohySHxan', moods:['קצבי','קליל'] },
        { id:'70E2PO0iRuTZrcm3PK20rb', moods:['רגוע','אלגנטי','קליל'] },
        { id:'79jjnPCe2TK4N3vTGfYJXK', moods:['משפחתי','קליל','אלגנטי'] },
        { id:'3MFh9h1W1AhWD4jwWmaVA7', moods:['קצבי','אלגנטי','קליל'] },
        { id:'52btkQlZMKBkIaUuG5kSMf', moods:['קצבי','קליל'] },
        { id:'60jaxNF3IP5GmASVpJ93Mc', moods:['רגוע','משפחתי','אינטימי','קליל'] },
        { id:'6spuUOcX0rerhifPrAQqii', moods:['קצבי','קליל','אלגנטי'] },
        { id:'3zsTKkYKyldUAQOtRiFZa0', moods:['מודרני','סקסי','רקיד','קצבי'] },
        { id:'4HrRxH3MIyfb9eabjVUwzw', moods:['סקסי','קצבי','אלגנטי'] },
        { id:'0tzHVhoFXRMbEWc89EEIJ7', moods:['קצבי','רקיד','יוקרתי','קליל'] },
        { id:'0pRtayTQifQyZhoc1tKfRv', moods:['קצבי','רקיד','סקסי','קליל'] },
        { id:'1lq2I8XFgXuTD6QLDlaTDD', moods:['קצבי','אלגנטי','קליל'] },
        { id:'3gcZeTnpMILN1Jv0tQcTit', moods:['קצבי','קליל'] },
      ],
      energyLow:  { label:'ג׳אז עולמי ופאנק מתון', description:'ארוחה ראשונה — מוזיקה שממלאת שקטים בחן, מאפשרת שיחה ומרגישה מדויקת למקום.' },
      energyHigh: { label:'סולפול האוס ולטינו', description:'כשהמסעדה מלאה ויש אנרגיה — גרוב שמרים אבל לא שובר את האלגנטיות.' },
      purpose: 'chic, upscale feeling — diners relax and feel vibrant, music fills silence without dominating conversation',
      category: 'restaurants'
    },

    {
      id: 'themed_restaurant',
      label: 'מסעדת נושא מדיני',
      keywords: ['נושא','טמטי','themed','תאילנד','יפן','מקסיקו','הודו','סיני','ויאטנאמי','אתיופי','מרוקאי','אוזבקי'],
      genres: 'National music in the language of origin',
      playlistIds: ['140K2T3EltwgrGZeOQHEKg','0l02pjIfzPKwsiWcc7lB7a','4S8yzCFWjOhCypyCl32BMy'],
      purpose: 'music sonically reflects the culture of origin, creating immersive and authentic experience',
      category: 'restaurants'
    },

    {
      id: 'hummus_shawarma',
      label: 'חומוסייה / שיפודייה / שווארמה',
      keywords: ['חומוס','שווארמה','שיפוד','פלאפל','חומוסייה','שיפודיה','מנגל','barbecue','bbq','ישראלי','ישראלית'],
      genres: 'Israeli Pop hits with groove and Mizrachi',
      playlistIds: [
        '0JB65ghOmV4L8HpvqA1ePA','1oZgvIgDGkYIIO8tGdJsub','37i9dQZF1DWT9L7hoCDtjB',
        '2tuwpyW7rkN2bErlMPpX3t','37i9dQZF1DWUCy47lptxiG','7MT2zvfmRxAPEP1f3VKvAp'
      ],
      energyLow:  { label:'ישראלי קליל ומוכר', description:'לארוחת בוקר וצהריים שקטים — מוזיקה מוכרת שמרגיעה ומאפשרת לשבת בנחת.' },
      energyHigh: { label:'מזרחי קצבי ועולה', description:'לשעת ההמולה — ביטים וגרוב שמואצים את הקצב ואת המכירות.' },
      purpose: 'familiar upbeat Israeli music — matches lunch energy, customers feel at home and comfortable',
      category: 'restaurants'
    },

    /* ══════════════════════════════
       בָּתֵּי קָפֶה
    ══════════════════════════════ */
    {
      id: 'neighborhood_cafe',
      label: 'בית קפה שכונתי',
      keywords: ['בית קפה','קפה','cafe','coffee shop','coffee','קפיטריה','coffeehouse','קפה שכונתי','ברוויסטה','barista'],
      genres: 'Indie Pop / RnB / Indie Rock / Soft Israeli Rock / Oldies Israeli Songs',
      playlistIds: [
        '5toKV2v9Hmvt3mDQgeTwVD','3NlvO5jgbBoK9sRCj8VFod','1lKKcdJYSmeInBFpWg0Q95',
        '1b881WhUkUGB0KjjvxKxzq','20Jp6qr45rQQlAUcNkPjXd','1m8tlUqBDidL9gA8cMD4ho',
        '1ZkZA7a9Fdw26WZyIV58Gw'
      ],
      energyLow:  { label:'אינדי פופ ו-RnB עדין', description:'לשעות הבוקר ועבודה מהשולחן — מוזיקה שמרגישה "קול" בלי להפריע.' },
      energyHigh: { label:'אינדי רוק ישראלי', description:'לאחר הצהריים כשהמקום מתמלא — קצב שמרים, ראשים מהנהנים, שיחות נמשכות.' },
      purpose: 'relaxed, inviting — head-bob worthy but no extreme bass or tempo. Enables work and conversation',
      category: 'cafes'
    },

    {
      id: 'chain_cafe',
      label: 'רשת בתי קפה',
      keywords: ['רשת','רשת קפה','chain cafe','ארומה','קפה גרג','cafe cafe','נט קפה','רשת קפיות'],
      genres: 'Blend of Pop, Rock and Indie hits',
      playlistIds: [
        '5dRQCcekOYFR8K8Z5PA8KK','6eSP50WlHILqGuRBrgMhww','530uNcFyRtIB3r8b2O17mp'
      ],
      energyLow:  { label:'פופ ואינדי מוכר', description:'לשעות השקטות — להיטים שכולם מכירים, אווירה נעימה ומוכרת.' },
      energyHigh: { label:'פופ קצבי ואינדי רוק', description:'לשעות העומס — אנרגיה שמניעה את הסרוויס קדימה.' },
      purpose: 'accessible and familiar — broad appeal across age groups with known hits',
      category: 'cafes'
    },

    {
      id: 'bakery',
      label: 'קונדיטוריה / מאפייה',
      keywords: ['קונדיטוריה','מאפייה','מאפה','עוגות','לחם','bakery','patisserie','אפייה','קרואסון','עוגיות'],
      genres: 'Blend of happy trendy beats in English and Hebrew',
      playlistIds: ['0FxhdYIyQQ1MZvyekmPvdo','20Jp6qr45rQQlAUcNkPjXd'],
      purpose: 'happy, warm, welcoming — upbeat and familiar, complements the comfort of fresh baked goods',
      category: 'cafes'
    },

    /* ══════════════════════════════
       יוֹפִי וְטִיפּוּחַ
    ══════════════════════════════ */
    {
      id: 'womens_hair_salon',
      label: 'מספרת נשים',
      keywords: ['מספרה','ספר','תסרוקת','שיער','beauty salon','מספרת נשים','קולר','צביעה','קרטין','בלונד'],
      genres: 'Upbeat Pop / RnB / Soft Rock / Radio Hits / Female Power anthems',
      playlistIds: [
        '3D0h60khFXmfYWlCKNRZ17','2grgwRdgTA7QSCUQQhhgv8','1NrJZTctsmYy6vJ305oIhd',
        '33Gh7eRE6PsCBOVvw27oGN','3IADOkaYr1pprCcpPXfBfv','1q01v8Q8LFWQR0epGsHDzv'
      ],
      energyLow:  { label:'פופ רך ו-RnB', description:'לשעות הרגועות — מוזיקה שמרימה את הרוח בלי להעמיס.' },
      energyHigh: { label:'פמייל פאוור ורדיו להיטים', description:'לשעות ההמולה — שירים שמאחדות ומרגישות.' },
      purpose: 'uplifting energy for women — positive atmosphere during the long hairdressing process, sing-along potential',
      category: 'beauty'
    },

    {
      id: 'barbershop',
      label: 'מספרת גברים / ברבריה',
      keywords: ['ברבר','ברבריה','barber','מספרת גברים','גברים','גבר','גילוח','beard','zichron'],
      genres: 'Blues / Rock Hits / Rhythm and Blues / Hip Hop',
      playlistIds: [
        '2AguYoBHvhW8IEjbzUaJRh','18Ad0Qk6HFuH0RmoJYI6sh','5gGb3w6lOEzmfZ7d4AFBkt'
      ],
      energyLow:  { label:'בלוז ו-RnB קלאסי', description:'לגילוח מרגיע — מוזיקה גברית ואיכותית.' },
      energyHigh: { label:'רוק והיפ הופ', description:'לאנרגיית הברבריה — ביטים שמרגישים בבית.' },
      purpose: 'masculine testosterone-driven environment — heavy on male voices in Rock and Rap, feels like a boys club',
      category: 'beauty'
    },

    {
      id: 'spa',
      label: 'ספא / מסאז׳ / ריטריט',
      keywords: ['ספא','מסאז','מסאז׳','spa','massage','טיפול','wellness','ריטריט','retreat','רפלקסולוגיה','רגיעה','מדיטציה'],
      genres: 'Ambient / Soft Classical / Nature Sounds',
      playlistIds: [
        '37i9dQZF1DXebxttQCq0zA','37i9dQZF1DWYaxoJ3YwOh3','37i9dQZF1DX65caF1CvtIN'
      ],
      energyLow:  { label:'אמביינט וקלאסי רך', description:'לטיפול שלם — מוזיקה שמורידה דופק ומכניסה לרגיעה.' },
      energyHigh: { label:'צ׳יל אינסטרומנטלי', description:'לתחילת הביקור — מרגיע עם קצת חיות.' },
      purpose: 'reduce heart rates and induce relaxation — calming, minimal, breath-paced, organic',
      category: 'beauty'
    },

    {
      id: 'nail_salon',
      label: 'מכון לק / ציפורניים',
      keywords: ['לק','ציפורניים','ג\'ל','nail','מניקור','פדיקור','nail bar','נייל','gel'],
      genres: 'Trendy Soft RnB Pop / Radio Pop hits',
      playlistIds: [
        '6xLTji3pUH0RnAltYLgk9K','6wm6uONfugp5Y2XOQPDorX','3UE4447S8KhMb9Xw5csrbg'
      ],
      energyLow:  { label:'פופ RnB רך', description:'לתחילת הביקור — טרנדי ונעים.' },
      energyHigh: { label:'רדיו להיטים', description:'לאווירה חברתית — שירים שכולן מכירות.' },
      purpose: 'familiar energetic atmosphere — feel-good radio hits make the appointment fun and social',
      category: 'beauty'
    },

    {
      id: 'clinic_aesthetics',
      label: 'קליניקת בוטוקס / אסתטיקה',
      keywords: ['בוטוקס','פילר','קליניקה','אסתטיקה','botox','filler','clinic','אנטי אייג\'ינג','ליזר','laser','פילינג'],
      genres: 'Lo-Fi / Chill / Ambient / Soft Instrumental',
      playlistIds: [
        '38urkSaLUJrsZnsL5YblQO','5VW3BIGp3psfD7aOpGWiOM','1EdmfpZXrxZeGT7TnqITi4'
      ],
      energyLow:  { label:'לו-פיי ואמביינט', description:'לטיפול — יוצר אמון ומרגיע.' },
      energyHigh: { label:'צ׳יל אינסטרומנטלי', description:'לחדר המתנה — נינוח עם נוכחות.' },
      purpose: 'clean instrumental — calm, reduce heart rate, reinforce clinical trust and professionalism',
      category: 'beauty'
    },

    /* ══════════════════════════════
       בִּיגוּד וְקַמְעוֹנָאוּת
    ══════════════════════════════ */
    {
      id: 'beachwear',
      label: 'חנות בגדי ים / גלישה / חוף',
      keywords: ['בגדי ים','ים','גלישה','beach','surf','ים ושמש','קיץ','summer','ביקיני','בגד ים'],
      genres: 'Reggae / Tropical House / Afrobeats',
      playlistIds: [
        '24gphesROpSxAy1Icv4iJ6','6buyfbddoaTUTXGZok6zno','1XNRitMRNotCvoQUmpp6D0'
      ],
      energyLow:  { label:'רגאיי ותרופיקל מתון', description:'כשהחנות שקטה — ווייב חופש מרגיע.' },
      energyHigh: { label:'תרופיקל האוס קצבי', description:'כשהחנות מלאה — חופש בקצב שמניע.' },
      purpose: 'immersive vacation atmosphere — elevates customer mood, reinforces brand, boosts dwell time and sales',
      category: 'clothing'
    },

    {
      id: 'lingerie',
      label: 'חנות הלבשה תחתונה',
      keywords: ['הלבשה תחתונה','תחתונים','לינגרי','lingerie','אינטימי','סקסי','sexy','bodies','בגד גוף'],
      genres: 'Lo-Fi Beats / Sensual Lounge / Deep House',
      playlistIds: [
        '37i9dQZF1DX0khTY3HFA4M','37i9dQZF1DX2TRYkJECvfC','6UbZqL2lg2j1ZIzGrbr7V3'
      ],
      energyLow:  { label:'לו-פיי ולאונג׳ סנסואלי', description:'אינטימי ומרגיע.' },
      energyHigh: { label:'דיפ האוס אינטימי', description:'קצב שמעצים ומכניס לאווירה.' },
      purpose: 'sensual, empowering — mimics intimate late-night setting, confident atmosphere',
      category: 'clothing'
    },

    {
      id: 'luxury_clothing',
      label: 'חנות בגדי יוקרה',
      keywords: ['יוקרה','luxury','מותג','designer','פריז','מילאנו','high end','high-end','בוטיק','boutique','גוצ\'י','פראדה'],
      genres: 'Nu Disco / Electro / Indie Dance / Deep House',
      playlistIds: [
        '3GFgGQVFvdA5q6W3MOgCI4','0mDWNRMmvA9YKcjDDG5v8J','0HOLXwNqjo6DruEPkRY1iT'
      ],
      energyLow:  { label:'אינדי דאנס עדין', description:'לקניה מרוכזת — ביטים יוקרתיים.' },
      energyHigh: { label:'ניו דיסקו ואלקטרו', description:'לחנות מלאה — אנרגיה שמרימה.' },
      purpose: 'prestigious atmosphere — unique beats create instant upscale feeling, elevating to glorify the garments',
      category: 'clothing'
    },

    {
      id: 'streetwear',
      label: 'חנות בגדי סטריט / אורבן',
      keywords: ['סטריט','אורבן','streetwear','street','hip hop','היפ הופ','urban','סניקרס','sneakers','skate','סקייט'],
      genres: 'Rap / Hip Hop / Punk / Indie Rock / Post Punk',
      playlistIds: [
        '38C9DNtEBFdjWgX5beA5Kf','1tkE5kEyABOqi6culrKNlB','4plCeDzeVnk15wp1tJfTFA',
        '0ptDDmk80kbvPnGzGAVSd6'
      ],
      energyLow:  { label:'אינדי רוק אורבני', description:'לכניסה — מוזיקה שאומרת אתה בבית.' },
      energyHigh: { label:'ראפ והיפ הופ קצבי', description:'כשהחנות מלאה — ביטים אמיתיים.' },
      purpose: 'immediate cultural trust — music makes the customer feel at home in their culture, prolongs dwell time',
      category: 'clothing'
    },

    /* ══════════════════════════════
       אַחֵר
    ══════════════════════════════ */
    {
      id: 'toy_comics_gaming',
      label: 'חנות צעצועים / קומיקס / גיימינג',
      keywords: ['צעצועים','קומיקס','comics','toys','גיימינג','gaming','רטרו','retro','משחקים','games','אנימה','anime'],
      genres: 'Synthwave / Retro 80s / Electro Pop / Chiptune',
      playlistIds: ['7dCEN3pOke0Nv1Iz62VBnJ','1niLsvjFMoS7w6xAUAsxw9'],
      energyLow:  { label:'סינת׳ וייב ורטרו 80s', description:'נוסטלגיה שמחייכת ומזמינה.' },
      energyHigh: { label:'אלקטרו פופ קצבי', description:'קצב שמרגיש כמו משחק.' },
      purpose: 'nostalgic, fun, immersive — connects with the retro and playful spirit of the products',
      category: 'other'
    }
  ]
};

/* ──────────────────────────────────────
   matchDataBox(bizDesc) → entry | null
   Keyword scoring: longer keywords score more points (more specific).
   Minimum threshold: 3 points before we trust the match.
────────────────────────────────────────*/
window.SB_matchDataBox = function(bizDesc){
  if(!window.SB_DATA_BOX) return null;
  const text = (bizDesc||'').toLowerCase();
  let best = null, bestScore = 0;
  for(const entry of window.SB_DATA_BOX.entries){
    let score = 0;
    for(const kw of entry.keywords){
      if(text.includes(kw.toLowerCase())) score += kw.length;
    }
    if(score > bestScore){ bestScore = score; best = entry; }
  }
  return bestScore >= 3 ? best : null;
};
