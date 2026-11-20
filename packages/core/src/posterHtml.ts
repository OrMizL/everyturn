import { redact, type Denylist } from "./redact";
import { light as t } from "./theme";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Self-contained page around the already-outlined poster SVG (no fonts needed, so nothing to embed).
 * No scripts and no remote URLs; the CSP blocks everything except inline styles and data: images/fonts.
 */
export function renderPosterHtml(outlinedSvg: string, opts: { title?: string; alt?: string; denylist?: Denylist } = {}): string {
  // Custom titles are caller text: they go through the same redaction as report strings.
  const title = redact(opts.title ?? "Every Turn: what your agent is told every turn", opts);
  const alt = redact(opts.alt ?? title, opts);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{margin:0;background:${t.paper};color:${t.ink};font-family:${t.font}}
figure{margin:0 auto;max-width:800px;padding:24px}
figure svg{display:block;width:100%;height:auto}
</style></head><body>
<figure role="img" aria-label="${esc(alt)}">
${outlinedSvg.replace(/^<\?xml[^>]*>\s*/, "")}
</figure>
</body></html>
`;
}
