import { DENY_TOKEN, redact, type Denylist } from "./redact";
import { theme } from "./theme";
import { AGENTS, type Report } from "./types";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** Escape, then show each denylist placeholder as a black inline block (no text revealed to readers). */
const cell = (s: string) => s.split(DENY_TOKEN).map(esc).join(`<span class="rd" role="img" aria-label="redacted">${DENY_TOKEN}</span>`);
const agentLabel = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", copilot: "Copilot", windsurf: "Windsurf" };
const fmt = (n: number) => n.toLocaleString("en-US");

const KIND_TITLE = { conflict: "Possible conflict", "setting-conflict": "Setting conflict", duplicate: "Duplicate", "near-duplicate": "Near-duplicate", "repeated-in-file": "Repeated within one file" } as const;

/** Claude Code @imports: one physical file, listed once; the import is an occurrence, not a second copy. */
function importsHtml(report: Report): string {
  const byId = new Map(report.sources.map((s) => [s.id, s]));
  const items = report.sources.flatMap((s) => s.importedBy.map((r) => `<li>${cell(s.logicalPath)} ← ${cell(byId.get(r.by)?.logicalPath ?? "?")}:${r.line}</li>`));
  return items.length ? `<h2>Imports</h2><div class="sub">Claude Code <code>@path</code> imports. Each file is counted once in the totals; the import adds it to the Claude Code profile.</div><ul>${items.join("")}</ul>` : "";
}

function findingsHtml(report: Report): string {
  if (!report.findingCounts.checked) return `<h2>Findings</h2><div class="sub">Not checked (findings off).</div>`;
  if (!report.findings.length) return `<h2>Findings</h2><div class="sub">No possible conflicts or duplicates found by the heuristics.</div>`;
  const c = report.findingCounts;
  const items = report.findings.map((f) => {
    const score = f.score !== undefined ? ` · score ${f.score.toFixed(2)} (threshold ${f.threshold ?? "—"})${f.shingleScore !== undefined ? `, shingles ${f.shingleScore.toFixed(2)}` : ""}` : "";
    const ev = f.evidence.map((e) => `<li><span class="p">${cell(e.path)}:${e.line}</span> ${e.excerpt === null ? `<span class="m">text withheld (privacy)</span>` : cell(e.excerpt)}</li>`).join("");
    return `<div class="f ${f.kind}"><b>${KIND_TITLE[f.kind]}</b> · ${f.confidence} confidence${score}${f.intentionalOverride ? " · likely intentional override" : ""}<ul>${ev}</ul><div class="sub">${esc(f.applicability)} ${esc(f.precedence)}</div></div>`;
  }).join("\n");
  const overrides = c.headline.overrides ? `${c.headline.overrides} likely intentional override${c.headline.overrides === 1 ? "" : "s"}, ` : "";
  return `<h2>Findings</h2><div class="sub">${c.headline.conflicts} possible conflicts and ${c.headline.duplicates} duplicates (medium or high confidence, same profile); ${overrides}${c.byConfidence.low} low confidence and ${c.repeatedInFile} repeats within one file are listed but not counted. Heuristics, not proof: check the evidence. Duplicates compare distinct files only.</div>\n${items}`;
}

/** Self-contained HTML sources table, largest first. Report values are already redacted by buildReport; a custom title is redacted here. */
export function renderSourcesTableHtml(report: Report, rawTitle = "Every Turn — sources by size", opts: { denylist?: Denylist } = {}): string {
  const title = redact(rawTitle, opts);
  const max = Math.max(1, ...report.sources.map((s) => s.estTokens));
  const rows = report.sources
    .map(
      (s) => `<tr><td class="n">${esc(s.id.slice(1))}</td><td>${cell(s.label)}${s.represents === "config-summary" ? " (config summary)" : ""}<div class="p">${cell(s.logicalPath)}</div></td>
<td>${agentLabel[s.agent]}</td><td class="sc">${esc(s.scope)}</td><td class="r">${fmt(s.bytes)}</td><td class="r">~${fmt(s.estTokens)}</td>
<td class="b"><div style="width:${((s.estTokens / max) * 100).toFixed(1)}%"></div></td></tr>`,
    )
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
body{font-family:${theme.font};color:${theme.ink};background:${theme.paper};margin:40px;}
h1{font-size:22px;margin:0 0 4px}.sub{color:${theme.muted};font-size:13px;margin-bottom:18px}
table{border-collapse:collapse;width:100%;font-size:14px}th{text-align:left;color:${theme.muted};font-weight:500;border-bottom:1px solid ${theme.rule};padding:6px 8px}
td{border-bottom:1px solid ${theme.rule};padding:7px 8px;vertical-align:top}.r{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.n{color:${theme.muted};width:24px}.p{font-family:${theme.mono};font-size:12px;color:${theme.muted}}.sc{color:${theme.muted}}
.rd{background:${theme.ink};color:transparent;border-radius:4px;user-select:none}
h2{font-size:17px;margin:28px 0 4px}.f{border-left:4px solid ${theme.conflict};background:${theme.surface};padding:6px 12px;margin:10px 0;font-size:14px}.f.duplicate,.f.near-duplicate,.f.repeated-in-file{border-left:4px dashed ${theme.duplicate}}.m{color:${theme.muted}}.f ul{margin:4px 0 4px 18px;padding:0}
.b{width:30%}.b div{height:10px;background:${theme.bar};margin-top:4px}tfoot td{font-weight:600;border-bottom:none}
</style></head><body>
<h1>${cell(title)}</h1>
<div class="sub">Inventory across all agents: ${fmt(report.totals.sources)} sources · ${fmt(report.totals.bytes)} bytes · ~${fmt(report.totals.estTokens)} tokens (estimated, UTF-8 bytes ÷ 4). Not one live turn.</div>
<div class="sub">${AGENTS.filter((a) => report.byAgent[a]).map((a) => `${agentLabel[a]} ~${fmt(report.byAgent[a]!.estTokens)}`).join(" · ")}</div>
<table><thead><tr><th>#</th><th>Source</th><th>Agent</th><th>Scope</th><th class="r">Bytes</th><th class="r">Tokens</th><th></th></tr></thead>
<tbody>
${rows}
</tbody>
<tfoot><tr><td></td><td>Inventory</td><td></td><td></td><td class="r">${fmt(report.totals.bytes)}</td><td class="r">~${fmt(report.totals.estTokens)}</td><td></td></tr></tfoot></table>
${importsHtml(report)}
${findingsHtml(report)}
</body></html>`;
}
