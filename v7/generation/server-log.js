// Warnings from modules that run both in the browser and in Node (server
// endpoints, scripts). Printed only outside the browser, so owners' DevTools
// consoles stay clean while Vercel logs and script output keep them.
// SERVER-REACHABLE — no imports.

export function serverWarn(...args) {
  if (typeof window === 'undefined') console.warn(...args);
}
