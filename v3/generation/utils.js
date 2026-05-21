export function safeJSON(str) {
  if (!str) return {};
  try { return JSON.parse(str); } catch {}
  const m = str.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  return {};
}
