/* data-box-energy.js
   Energy-separated playlist data built from the live Google Sheet.
   Used as fallback when /api/databox cannot fetch the sheet directly.
   Keys: entry label (Hebrew) → {1: {playlists, genres}, 2: {playlists, genres}}
*/
window.SB_ENERGY_MAP = {
  'בר שכונתי': {
    1: { genres: 'Soft Rock / Indie Folk', playlists: ['37i9dQZF1DX2taNm7KfjOX','6tcGPrI5Pp9JvRkEyWxRvD','1YKdR6u7Dy2IlPKb1LSEJm','1obVQm7zQwtoRS4XeZFxPW','6Y7Bjg1JyRcLE5UPCJTtxV','7v5a89nkSfyIktt8R9KaGy','1IrxAoXnYPTYNw88HEYnEJ'] },
    2: { genres: 'Indie Rock / Electronic Rock / Indietronica', playlists: ['4uo2WHQgnUElflSl9oWntX','0Sm64Lu6z1OK8yM3Oeo4Wx','43SrzWg5noH2HFxIYcuft4','7pDYHhlAulEmE68iW83zU1','37i9dQZF1DWUoqEG4WY6ce','1DA520JoZgKucdnsqUTN7V','37i9dQZF1DWYBF1dYDPlHw','4wwqBmPvztunSovwUcuEbY','3QwpkIyfYJ3KP1OYEM1wFG','1ZkZA7a9Fdw26WZyIV58Gw'] }
  },
  'פאב / ביליארד': {
    1: { genres: 'Blues / Classic Rock', playlists: ['61jNo7WKLOIQkahju8i0hw','37i9dQZF1DX6Gwl5uG0dwX','72JbwSy5zwNH17Fy1Dzxro'] },
    2: { genres: 'Rock / Vintage Rock', playlists: ['61jNo7WKLOIQkahju8i0hw','37i9dQZF1DX6Gwl5uG0dwX','72JbwSy5zwNH17Fy1Dzxro','5JMSQOMQq5Pvj0wyGdsOIN','2nFiBPsadcJtkZB9wVwQ1j','1ZYiwkcUa0pZUAbyrFUnO6','6MNEDiFcAkOB5peLM7pnp2'] }
  },
  'בר יין': {
    1: { genres: 'Smooth Jazz / Bossa Nova / French Jazz / Vocal Jazz', playlists: ['37i9dQZF1DWWgccrbg3zbJ','26hCFGqpzWO7WcDfaoSxzG','70E2PO0iRuTZrcm3PK20rb','37i9dQZF1DX4wta20PHgwo','37i9dQZF1DWUN87b7HRrCS','6v0TJqUAzj684mRivDguz2','43pFvfkcBOepFnzaMqisEU'] },
    2: { genres: 'LoFi Beats / RnB / Funk / Instrumental Hip Hop', playlists: ['6bX6RfpkoRwqH3at702xja','1qbKICgD1C72mXBDEkq3GJ','37i9dQZF1E4xdJ0ma3vTH1','38ZYabMAAtoNccXp4KhIVW','0V1Xw5HVMI5fpYt81uMkca','3gcZeTnpMILN1Jv0tQcTit','2AyLDm0G9KPt5LGOZZ9jYI','5CFwl3kAjHPBrOQyNCYeLP','3TPnPPj870dWNfMxOyLAbF','6oPgzAtNrMTI0nZPxzLY6R'] }
  },
  'דאנס בר': {
    1: { genres: 'Hip Hop / Latin / AfroBeats / Neo Disco', playlists: ['5pvJLjAhcKCHXGOb7pEbBZ','7IfWkPjxjtGpHKzvbZd8YV','37i9dQZF1E4qQ00I1Jm1ay','3EOra0sJJ4vKRVf49KZGNh','1po9a30RIjEq96GciF2OvY','0ZeRX5AJLFEVEP5X4fZn7f','5AW6DcdalIgp37X1hZbuoJ'] },
    2: { genres: 'Indie Dance / Vocal House / Afro House / Deep House', playlists: ['2S2R3fAMQ0APh45cU1TAth','3DaU9QPNMVXNwegTUPamNw','487jKTFqWhs6b0AEUz0WpX','04MO4lWaVFdTChYeVHmCSr','580P0wvHL8eRYyEODWQAeR','1dlzwT5nffXECmUnxvcxYG','6vDGVr652ztNWKZuHvsFvx'] }
  },
  'בר קוקטיילים': {
    1: { genres: 'Late Night Jazz / Chill Lounge', playlists: ['37i9dQZF1DX0khTY3HFA4M','6y6NN5sdrPMgnHQjFXHcBm','0vVU5gveFYC1GP3lgR14ba','40GL5ThzCnJFhMw0469JUy','7Hkv1zwKEYByNZtxUmfM9t','20800ip0m0MCeMRUdLgiu5','5RvmV3kOYs9cllgBu0eB0T','37i9dQZF1DWYoYGBbGKurt'] },
    2: { genres: 'Jazz House / Lounge Groove', playlists: ['2lJmIUfPa3m1gyrhVYy6gw','37i9dQZF1DX6syac0fWYdV','3GPRP14OMTWXvd2qpWbvxp','62wfXU42UYX68lYSajGw9z','5GrWuliLODvT0KtZTDhYKT','7i8PotqqlAb88Bwybh7PAk','3fjJwIX6Uuqc0xRUtguUbH'] }
  },
  'בר קולינרי / בר אוכל': {
    1: { genres: 'RnB / Lounge Jazz', playlists: ['0bhpV9zKrJiCjdv6xX9wdc','6u08x3MsXfaHbl50phdGEe','5X3SFbbEUxdHDZuLvrKbEw','3Jl1XkEZp6NmCoFnBC3MGZ','1YELxi7ZMshYceszjzYK7V','3cVOSi3w5OIoPmpQ3hZ5MM','4j41EtSLPvCeVUEe3Z31Zi','4B0BZlWyMZJrgWFDUVqiad'] },
    2: { genres: 'Jazzy Beats / Neo Soul / Funky Hip Hop', playlists: ['6N7E8beWM4r4tXNmo5NbJX','3WwBMqBr5TupGBwW9Ve9Pf','33alWtYP5HBWhRaji8k212','2XD24lgANiicaKd38DWBpg','7gMwgeD3Pyxt47osgFgurH','0xhPfZBMEWZFiiRe6VI9bZ','0qO6unQdqd4dLBiJuokIN1','2n9Yt7n7pKFEoG9dEWbMjD'] }
  },
  'בר מלון': {
    1: { genres: 'Instrumental Covers / Chill / Piano Jazz', playlists: ['37i9dQZF1DX9j444F9NCBa','37i9dQZF1DWWfxnl2EyBbd','4Gn6rgEi6D1kbXIn5qKHxV','37i9dQZF1EIcLGCg3rZSWj','7Hkv1zwKEYByNZtxUmfM9t','4ep0Rr0ppCNMgtd2nOhOrg','37i9dQZF1DWSADWNdZfn11'] },
    2: { genres: 'Instrumental / Chill / Soft Jazz', playlists: ['37i9dQZF1DWVqfgj8NZEp1','6xwz5O60HTBCBJEeUceBGB','5rWwygGtLi1Ro8JtwNJZns','0jHRe3GHILXcj5SyIIBMwr'] }
  },
  'מסעדת פועלים': {
    1: { genres: 'Israeli Folk / Mediterranean', playlists: ['37i9dQZF1DWT9L7hoCDtjB','0JB65ghOmV4L8HpvqA1ePA','2tuwpyW7rkN2bErlMPpX3t'] },
    2: { genres: 'מזרחית ישנה / שירים טורקים', playlists: ['2z4tm86ivNjyO3oKDpVOnV','1w26vYQCXCnritR3Zjl8Ho','1YAsFTPgF2keIHbcpYnHDU','7MT2zvfmRxAPEP1f3VKvAp','53GX7x7Z6bfrESNL7ndTKK','37i9dQZF1DWT9L7hoCDtjB'] }
  },
  'מסעדת שף / ביסטרו / יוקרה': {
    1: { genres: 'French Jazz / Swing Jazz / Lounge / Bossa Nova', playlists: ['37i9dQZF1EIgOj03IPzJ1N','70E2PO0iRuTZrcm3PK20rb','3MFh9h1W1AhWD4jwWmaVA7','1wVlvYMwQBx4lP9Uj8ss0I','3BVAmkpL6LzyJTQiguENhJ','5PtQjXruBYC5pB3S4uYqZF','0uhWLJ55gI2gslB4oTTPbE','5UyTZtFH4Ou6fS5MofX1ay','67waO0NR8HTySxtB7wfMBZ'] },
    2: { genres: 'World Jazz Funk / Soul / World Beats', playlists: ['5TNGJeYkQvZBzuj2LiDxlP','1wVXfJA0uiOCX0ohySHxan','1rEI4oadbmJdMkkl9Aez92','52btkQlZMKBkIaUuG5kSMf','6spuUOcX0rerhifPrAQqii','0tzHVhoFXRMbEWc89EEIJ7','0pRtayTQifQyZhoc1tKfRv','1lq2I8XFgXuTD6QLDlaTDD','3gcZeTnpMILN1Jv0tQcTit','0UWFIElyqzoJ2fOzZrmOqa'] }
  },
  'פיצריה': {
    1: { genres: 'Hip Hop / Rap Rock / Nu Metal', playlists: ['6lJ6bBkC4VPGIPf35HgX2C','4EAWwX0pdBwoTNIIbxDeYo','0EzKU9BEaAP9avKUGaZ8Ab','37i9dQZF1DX89XXHpIgTCJ','4NDXWHwYWjFmgVPkNy4YlF','1tkE5kEyABOqi6culrKNlB','6ubbnVqHoXsha40OhigJk5'] },
    2: { genres: 'Punk / Ska', playlists: ['4IKGSUCK45fENklONNSpZR','1LNzim8XS5VY1DyJN9y5vZ','6bBFO138OfKV5ERbA1dmjq','37i9dQZF1DX3MU5XUozve7','0nAM16QCmWnpjszRFgICKn','7ITmaFa2rOhXAmKmUUCG9E','39sVxPTg7BKwrf2MfgrtcD'] }
  },
  'בית קפה שכונתי': {
    1: { genres: 'Soft Israeli Rock / Oldies Israeli / Folk', playlists: ['20Jp6qr45rQQlAUcNkPjXd','1m8tlUqBDidL9gA8cMD4ho','1b881WhUkUGB0KjjvxKxzq','506JWjzFDpAKOOH2fV4vq0','5ZbHqfh9NMr5QvfYshzOXQ','2Ohl2UcuxvxC5HGDl9AAym','37i9dQZF1DX7iFijMqb6EI'] },
    2: { genres: 'Indie Pop / RnB / Indie Rock / Indie Folk', playlists: ['3i85OZp17tSPHmvk1W8RSi','3NlvO5jgbBoK9sRCj8VFod','1ZkZA7a9Fdw26WZyIV58Gw','37i9dQZF1DX2ogDiL6nZJr','37i9dQZF1DWXnscMH24yOc','4PhOHUfBWnBiKWPsjsuPNa','6GGG5ORMQzG71ttIb2tEwZ','1WXXO8g0zyY9f2OIRsL96X'] }
  },
  'רשת בתי קפה': {
    1: { genres: 'Blend of Pop, Rock and Indie hits (mellow)', playlists: ['5dRQCcekOYFR8K8Z5PA8KK','6eSP50WlHILqGuRBrgMhww','530uNcFyRtIB3r8b2O17mp'] },
    2: { genres: 'Blend of Pop, Rock and Indie hits (upbeat)', playlists: ['0QJ8I2ziY4h83TlIyQmHeF','7sWfQOYjHprVKggIUbUQBk','2i20Lr7DtaXhbN73KVCjhA','7sRNY3Rw6G0jfeJNTDiqEL'] }
  },
  'מספרת נשים - מרכז': {
    1: { genres: 'RnB / Indie Pop', playlists: ['3D0h60khFXmfYWlCKNRZ17','0Knxr6VROT1TmgdtEmmDN4','1kW7uZG2FWxwLXuW117rmO','4ELWRIEcvyn2lSDwegTscV','5Azbe8NcoQr8zxW5RHvcdC','37i9dQZF1DX9loJQLuEvap','5IXp6BcaMYpvkWo28FssCh'] },
    2: { genres: 'Radio Hits / Female Pop / Dance Pop', playlists: ['2grgwRdgTA7QSCUQQhhgv8','1NrJZTctsmYy6vJ305oIhd','0orDWyz3Wv1XDpO0YuiRw1','3LmU27D0ewMsGMIeXNEGw5','1BH5AuJ0y0aKcWM1plFTU4','3QOTmgVzZk9SHf91V4x5Cw','37i9dQZF1DWSoyxGghlqv5'] }
  },
  'חנות בגדי ים / גלישה': {
    1: { genres: 'Reggae / Dub', playlists: ['6buyfbddoaTUTXGZok6zno','71R43lBYQZ6JQXH6LmRo1I','0s8tfHVdQa8duFMev3ZlgD','2b0VpVcOpT7G10uCame2ZE','4ONdTgODsdMvCrJ9ANld3Y','5AJztwqwpJzCEp6PQ9sXlu','1bGqie6UHT3iIocWVHR9Sj'] },
    2: { genres: 'Tropical House / Ibiza', playlists: ['24gphesROpSxAy1Icv4iJ6','5WTdHhrKAxeUUDgnKG2Jcj','2sUnJwjAHuUU9Ums6jp6aA','1a9rhlfD3saI76yXmpnFpA','0OlHnaT6znyZaehdULrpN9','5PGV2Lsh8Vkev6BIAAIF9x','6Drs3IryMIG7fJS09fVJuU'] }
  },
  'חנות הלבשה תחתונה': {
    1: { genres: 'LoFi Beats / Jazz Beats', playlists: ['1iIeJHuimsK1bNHtPeIQ8C','5yY3jdNUdKH2lB9gVAXgca','1MCUdum5G1kAAvY1MWs6Sj','55tuQdlp7RYsNek5fqv7kU','6pwCRsiPJYpjw8yk0ATP7C','3TOaVLBEi5QfO1CDLtcgHJ','44loJtZbbTyL6vi2LzhaQO'] },
    2: { genres: 'Deep House / Jazzy House', playlists: ['37i9dQZF1DX2TRYkJECvfC','49N1inEbHZhJZ5Pc0TOh70','0J6PqJNHKqfTGk47XCLrIR','7lZ2BTkAxWGUwjeeo9z5jF','5BDVY5NLHuJotlnLnG2ein','6wfub4I1E0JZzU9Fj4oXuC','1zFJBaybcLgT4vcT4eMdgn'] }
  },
};

/* On load: merge SB_ENERGY_MAP into SB_LIVE_ENTRIES as fallback */
(function(){
  if(!window.SB_LIVE_ENTRIES){
    // Build minimal live entries from the energy map
    window.SB_LIVE_ENTRIES = Object.entries(window.SB_ENERGY_MAP).map(([label, energy])=>({
      label,
      keywords: [], // matching still handled by SB_DATA_BOX static keywords
      energy,
    }));
    console.log('[DataBox] Loaded', window.SB_LIVE_ENTRIES.length, 'entries from static energy map');
  }

  // Also enrich SB_DATA_BOX entries with energy data
  if(window.SB_DATA_BOX){
    window.SB_DATA_BOX.entries.forEach(entry=>{
      const energyData = window.SB_ENERGY_MAP[entry.label];
      if(energyData) entry.energy = energyData;
    });
  }
})();
