import { PAGE_HEADERS } from "../http.ts";

/** A small page for when linking can't go on, said for the person holding the phone. Nothing may frame it. */
export function messagePage(status: number, title: string, message: string): Response {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;font:17px/1.45 system-ui,sans-serif;background:#f7f4ec;color:#1d2420}main{max-width:32rem;margin:12vh auto;padding:0 20px}h1{font-size:1.4rem}@media(prefers-color-scheme:dark){body{background:#141a17;color:#eef2ee}}</style>
</head><body><main><h1>${esc(title)}</h1><p>${esc(message)}</p></main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...PAGE_HEADERS,
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "x-frame-options": "DENY",
    },
  });
}
