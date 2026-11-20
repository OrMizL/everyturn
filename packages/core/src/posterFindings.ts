import { isCounted, isListedOverride } from "./findings";
import { activationIn, inProfile } from "./profile";
import type { PosterConflict, PosterDuplicate, PosterFindings, PosterQuote } from "./poster";
import type { Agent, Evidence, Finding, Report } from "./types";

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const CONF = { high: 0, medium: 1, low: 2 } as const;

const quote = (e: Evidence): PosterQuote => ({ text: e.excerpt ?? "", ref: { path: e.path, line: e.line }, ...(e.excerpt === null ? { withheld: true } : {}) });
const note = (f: Finding) => `${f.applicability} ${f.precedence}`;

/**
 * The findings one poster shows, for one agent profile: medium and high confidence only, and only findings whose
 * sources are all in that profile (an imported file counts for Claude Code). Low confidence and cross-agent findings never appear.
 * A finding reaches the poster only through the same predicate as the headline count (`isCounted`), so the badge, the
 * "1 of N shown" note and the card always agree. Likely intentional model overrides are listed separately, not counted.
 *
 * Highlight order: a finding whose text can be shown before a fully withheld one; instruction conflicts before setting
 * conflicts; then confidence; then both sources always-loaded before nested ones; then document order.
 * Returns undefined when detection was off, so the card says "not checked" instead of "none found".
 */
export function posterFindings(report: Report, agent: Agent): PosterFindings | undefined {
  if (!report.findingCounts.checked) return undefined;
  const byId = new Map(report.sources.map((s) => [s.id, s]));
  const always = (f: Finding) => f.evidence.every((e) => { const s = byId.get(e.sourceId); return s && activationIn(s, agent) === "always"; });
  const inAgent = (f: Finding) => f.agents.includes(agent) && isCounted(f);
  const withheld = (f: Finding) => f.evidence.filter((e) => e.excerpt === null).length;
  const index = new Map(report.findings.map((f, i) => [f, i]));
  const toPoster = (f: Finding): PosterConflict => ({
    a: quote(f.evidence[0]!), b: quote(f.evidence[1]!), confidence: f.confidence, note: note(f),
    ...(f.kind === "setting-conflict" ? { setting: true } : {}), ...(f.intentionalOverride ? { override: true } : {}),
  });
  const conflicts = report.findings.filter((f) => (f.kind === "conflict" || f.kind === "setting-conflict") && inAgent(f))
    .sort((a, b) => withheld(a) - withheld(b) || Number(a.kind === "setting-conflict") - Number(b.kind === "setting-conflict") || CONF[a.confidence] - CONF[b.confidence]
      || Number(!always(a)) - Number(!always(b)) || index.get(a)! - index.get(b)!);
  const poster: PosterConflict[] = conflicts.map(toPoster);
  const overrides = report.findings.filter((f) => f.agents.includes(agent) && isListedOverride(f)).sort((a, b) => index.get(a)! - index.get(b)!).map(toPoster);
  // Duplicates: only the members that are in this profile; a group needs two of them.
  const dups: { d: PosterDuplicate; exact: boolean; i: number }[] = [];
  for (const f of report.findings) {
    if ((f.kind !== "duplicate" && f.kind !== "near-duplicate") || !inAgent(f)) continue;    const members = f.evidence.filter((e) => { const s = byId.get(e.sourceId); return s && inProfile(s, agent); });
    if (members.length < 2) continue;
    const withheld = members.some((m) => m.excerpt === null);
    dups.push({
      exact: f.kind === "duplicate", i: index.get(f)!,
      d: { text: members[0]!.excerpt ?? "", refs: members.map((m) => ({ path: m.path, line: m.line })), ...(f.kind === "near-duplicate" ? { similarity: f.score } : {}), ...(withheld ? { withheld: true } : {}) },
    });
  }
  dups.sort((a, b) => Number(!!a.d.withheld) - Number(!!b.d.withheld) || Number(!a.exact) - Number(!b.exact) || b.d.refs.length - a.d.refs.length || (b.d.similarity ?? 1) - (a.d.similarity ?? 1)
    || compare(a.d.refs[0]!.path, b.d.refs[0]!.path) || a.i - b.i);
  return { conflicts: poster, duplicates: dups.map((x) => x.d), overrides };
}
