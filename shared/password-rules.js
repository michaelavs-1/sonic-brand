// Password rules for v7 accounts — one source for the browser (registration,
// new-password screen, Profile) and the server (signup, set-v7-passwords).
//
// Mirrors the Supabase Auth settings (Authentication → Sign In / Providers →
// Email): minimum length 8 + "Digits, lowercase and uppercase letters".
// Supabase enforces them when a password is saved; checking here first lets
// the registration screen reject a password BEFORE payment instead of after.
// Supabase's leaked-password check can't be run here — a leaked password is
// refused only when it's saved (error_code 'weak_password', reason 'pwned').
//
// Server-reachable: bare imports only, no ?v= on imports inside this file.

export const PASSWORD_MIN = 8;

export const PASSWORD_RULES_TEXT = 'לפחות 8 תווים, כולל אות גדולה ואות קטנה באנגלית ומספר';

// Hebrew "a, b ו־c" — the conjunction attaches to the last item.
function joinHe(items) {
  if (items.length < 2) return items[0] || '';
  return `${items.slice(0, -1).join(', ')} ו${items[items.length - 1]}`;
}

// Hebrew description of what's wrong with a password, or null when it passes.
// Upper/lowercase means English letters — that's what Supabase checks (Hebrew
// has no case).
export function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
    return `הסיסמה צריכה להכיל לפחות ${PASSWORD_MIN} תווים`;
  }
  // 72 bytes is bcrypt's limit — Supabase rejects longer.
  if (new TextEncoder().encode(password).length > 72) return 'הסיסמה ארוכה מדי';
  const missing = [];
  if (!/[A-Z]/.test(password)) missing.push('אות גדולה באנגלית');
  if (!/[a-z]/.test(password)) missing.push('אות קטנה באנגלית');
  if (!/[0-9]/.test(password)) missing.push('מספר');
  if (missing.length) return `הסיסמה צריכה לכלול גם ${joinHe(missing)}`;
  return null;
}
