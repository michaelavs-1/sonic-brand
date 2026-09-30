// The email address Hyp gets for invoices and payment confirmations — one
// source for the server (api/v7/payment/_hyp.js, which sends it) and the
// payment screen (v7/result.js, which shows it).
//
// Hyp drops the "+" from an address it stores (seen 2026-09-29: sent as
// roni.mark%2Btestb%40gmail.com, stored as roni.marktestb@gmail.com — most
// likely a double URL-decode, "+" → space → removed). That's a different
// mailbox, possibly a stranger's, and the standing order keeps it for every
// monthly invoice. So Hyp gets the address without its "+tag": the part after
// "+" is only a label at Gmail, Outlook and most providers, so mail still
// reaches the same inbox. The account itself keeps the full address.
//
// Server-reachable: bare imports only, no ?v= on imports inside this file.

export function invoiceEmailFor(email) {
  const addr = String(email || '').trim();
  const at = addr.lastIndexOf('@');
  if (at <= 0) return addr;
  const local = addr.slice(0, at);
  const plus = local.indexOf('+');
  if (plus <= 0) return addr;   // no tag, or nothing before it — leave as is
  return `${local.slice(0, plus)}${addr.slice(at)}`;
}
