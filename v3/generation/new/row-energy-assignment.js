// Stage 2: pick which row's playlists feed the calm playlist and which feed the
// energetic one. When the same row covers both energies, both fields reference it.

export function assignEnergyRows(rows) {
  const row1  = rows.find(r => r.energy === '1');
  const row2  = rows.find(r => r.energy === '2');
  const row12 = rows.find(r => r.energy === '1+2');
  const first = rows[0];

  const calm      = row1 || row12 || first;
  const energetic = row2 || row12 || first;

  return {
    calm,
    energetic,
    isCalmAndEnergeticFromSameRow: calm === energetic,
  };
}
