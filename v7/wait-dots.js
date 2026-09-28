// Animated "…" for v7's waiting messages ("שומרים…", "מכינים את הכיוונים
// המוזיקליים…"): the three dots appear one after another, then clear, and
// repeat — a sign the page is still working. Shared by the onboarding app
// (v7/) and the account app (v7/account/); injects its own CSS on import, so
// static markup can also use the WAIT_DOTS_HTML span directly.
//
//   waitDots()            → a <span class="wait-dots"> element
//   WAIT_DOTS_HTML        → the same span as an HTML string (innerHTML templates)
//   waitNodes(text)       → text as nodes: every "…" / "..." becomes animated
//                           dots, every "\n" a <br>
//   setWaitText(el, text) → el shows waitNodes(text)
//
// Only for WAITING messages — placeholders and truncated text keep a plain "…".
// Client-only (touches document); never import it from an api/ module.

const DOTS = /…|\.\.\./;

export const WAIT_DOTS_HTML =
  '<span class="wait-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>';

const CSS = `
.wait-dots { display: inline-block; white-space: nowrap; }
.wait-dots > span { opacity: 0; animation: 1.6s linear infinite; }
.wait-dots > span:nth-child(1) { animation-name: wait-dot-1; }
.wait-dots > span:nth-child(2) { animation-name: wait-dot-2; }
.wait-dots > span:nth-child(3) { animation-name: wait-dot-3; }
@keyframes wait-dot-1 { 0%, 14% { opacity: 0; } 15%, 84% { opacity: 1; } 85%, 100% { opacity: 0; } }
@keyframes wait-dot-2 { 0%, 34% { opacity: 0; } 35%, 84% { opacity: 1; } 85%, 100% { opacity: 0; } }
@keyframes wait-dot-3 { 0%, 54% { opacity: 0; } 55%, 84% { opacity: 1; } 85%, 100% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .wait-dots > span { animation: none; opacity: 1; } }
`;

if (typeof document !== 'undefined' && !document.getElementById('wait-dots-css')) {
  const style = document.createElement('style');
  style.id = 'wait-dots-css';
  style.textContent = CSS;
  document.head.appendChild(style);
}

export function waitDots() {
  const span = document.createElement('span');
  span.className = 'wait-dots';
  span.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i++) span.appendChild(document.createElement('span')).textContent = '.';
  return span;
}

export function waitNodes(text) {
  const nodes = [];
  String(text ?? '').split('\n').forEach((line, i) => {
    if (i) nodes.push(document.createElement('br'));
    line.split(DOTS).forEach((part, j) => {
      if (j) nodes.push(waitDots());
      if (part) nodes.push(document.createTextNode(part));
    });
  });
  return nodes;
}

export function setWaitText(el, text) {
  if (el) el.replaceChildren(...waitNodes(text));
}
