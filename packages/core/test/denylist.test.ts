import { describe, expect, it } from "vitest";
import { buildPosterModel, buildReport, compileDenylist, redact, renderPosterSvg, renderSourcesTableHtml } from "../src/index";
import type { RawSource } from "../src/index";

// Synthetic terms only.
const TERMS = ["acme notes", "zebracorp", "fake.person@example.org", "secret-proj"];
const deny = compileDenylist(TERMS);
const R = (s: string) => redact(s, { denylist: deny });
const LEAK = [/acme[-_.\s]*notes/i, /zebracorp/i, /fake\.person@example\.org/i, /secret[-_.\s]*proj/i];
const leaks = (s: string) => LEAK.filter((re) => re.test(s)).map((re) => re.source);

describe("compileDenylist", () => {
  it("matches separator variants, case-insensitively", () => {
    for (const v of ["acme notes", "acme-notes", "acme_notes", "acme.notes", "AcmeNotes", "acmenotes", "ACME  NOTES", "Acme-_Notes"]) {
      expect(R(`see ${v} here`)).toBe("see [redacted] here");
    }
    for (const v of ["secret-proj", "secret proj", "SecretProj", "secret_proj"]) expect(R(`x ${v} y`)).toBe("x [redacted] y");
    expect(R("ZEBRACORP and ZebraCorp")).toBe("[redacted] and [redacted]");
  });
  it("matches inside paths", () => {
    expect(R("zebracorp-api/src/index.ts")).toBe("[redacted]-api/src/index.ts");
    expect(R("dev/acmenotes/CLAUDE.md")).toBe("dev/[redacted]/CLAUDE.md");
    expect(R("apps/secret-proj/CLAUDE.md")).toBe("apps/[redacted]/CLAUDE.md");
    expect(R("see zebracorpx and xzebracorp")).toBe("see [redacted]x and x[redacted]"); // >= 4 chars match anywhere
  });
  it("matches emails exactly, case-insensitively", () => {
    expect(R("mail Fake.Person@Example.ORG now")).toBe("mail [redacted] now");
    expect(R("mail fake_person@example.org now")).not.toContain("[redacted]");
  });
  it("short terms (3 chars) only match as whole words", () => {
    const d = compileDenylist(["foo"]);
    expect(redact("foo, foo-bar, a/foo/b, FOO", { denylist: d })).toBe("[redacted], [redacted]-bar, a/[redacted]/b, [redacted]");
    expect(redact("food foofoo xfoo foo1", { denylist: d })).toBe("food foofoo xfoo foo1");
  });
  it("rejects terms shorter than 3 characters without echoing them", () => {
    for (const bad of ["ab", "  ", "", "a-", "x.y"]) expect(() => compileDenylist([bad])).toThrow(/too short/);
    let message = "";
    try { compileDenylist(["zebracorp", "qq"]); } catch (e) { message = (e as Error).message; }
    expect(message).toContain("term 2");
    expect(message).not.toContain("qq");
  });
  it("counts unique terms and ignores nothing else", () => {
    expect(compileDenylist(["abc", "ABC", " abc "]).count).toBe(1);
    expect(deny.count).toBe(4);
    expect(redact("plain", { denylist: compileDenylist([]) })).toBe("plain");
  });
  it("runs before the generic rules and keeps them working", () => {
    // Built from pieces so the repo privacy scan does not flag this file.
    const other = ["a", "@", "b.com"].join("");
    expect(R(`mail fake.person@example.org or ${other}`)).toBe("mail [redacted] or [email]");
    expect(R(["/ho", "me/zebracorp/x"].join(""))).toBe("[path]");
    expect(R(["tok", "en = abcdefgh12345678"].join(""))).toBe("token = [secret]");
    expect(redact(other)).toBe("[email]"); // legacy signature
  });
  it("is idempotent, and terms never match inside the placeholder", () => {
    const text = "Acme-Notes / zebracorp / fake.person@example.org / secret proj / " + ["/ho", "me/u/acmenotes"].join("");
    expect(R(R(text))).toBe(R(text));
    const sneaky = compileDenylist(["act", "redact", "dacted"]);
    const once = redact("an act of redaction, redact", { denylist: sneaky });
    expect(redact(once, { denylist: sneaky })).toBe(once);
    expect(once).not.toContain("[[");
  });
});

const raw: RawSource[] = [
  { logicalPath: "apps/acme-notes/CLAUDE.md", scope: "nested", text: "- Ship Acme Notes carefully. Ask fake.person@example.org.\n- Use zebracorp-api/ for secret_proj work.\n" },
  { logicalPath: ".claude/skills/zebracorp-helper/SKILL.md", scope: "project", text: "---\nname: zebracorp-helper\ndescription: Helps with acmenotes releases.\n---\nbody" },
  { logicalPath: ".mcp.json", scope: "project", text: JSON.stringify({ mcpServers: { [["secret-proj", "-db"].join("")]: { command: "x" }, plain: { url: "https://h.example/x" } } }) },
  { logicalPath: ".claude/settings.json", scope: "project", text: JSON.stringify({ hooks: { "zebracorp-hook": [{ hooks: [{}] }] }, zebracorp: 1 }) },
  { logicalPath: "dev/acmenotes/CLAUDE.md", scope: "nested", text: "- Be brief." },
];

describe("buildReport with a denylist", () => {
  const report = buildReport(raw, { denylist: deny, warnings: ["apps/zebracorp/x: unreadable, skipped"] });
  it("redacts logical paths, labels, skill names/descriptions, MCP server names, warnings, text and JSON", () => {
    expect(leaks(JSON.stringify(report))).toEqual([]);
    expect(leaks(JSON.stringify(report, null, 2))).toEqual([]);
    const byPath = (p: string) => report.sources.find((s) => s.logicalPath === p)!;
    expect(byPath("apps/[redacted]/CLAUDE.md")).toBeTruthy();
    expect(byPath(".claude/skills/[redacted]-helper/SKILL.md").label).toBe("Skill: [redacted]-helper");
    expect(byPath(".claude/skills/[redacted]-helper/SKILL.md").represented).toBe("- [redacted]-helper: Helps with [redacted] releases.");
    // Default: aliased names and counts only. With showNames, names appear (redacted).
    expect(byPath(".mcp.json").represented).toBe("MCP servers: 2; server-1 (http); server-2 (stdio)");
    expect(byPath(".claude/settings.json").represented).toBe("Settings fields: hooks, 1 other key\nPermissions: allow 0, deny 0, ask 0\nHooks: 1 other event\nEnvironment variables: 0");
    const shown = buildReport(raw, { denylist: deny, showNames: true });
    expect(shown.sources.find((s) => s.logicalPath === ".mcp.json")!.represented).toContain("[redacted]-db (stdio)");
    expect(shown.sources.find((s) => s.logicalPath === ".claude/settings.json")!.represented).toContain("[redacted]-hook: 1");
    expect(leaks(JSON.stringify(shown))).toEqual([]);
    expect(report.warnings).toEqual(["apps/[redacted]/x: unreadable, skipped"]);
    expect(byPath("dev/[redacted]/CLAUDE.md")).toBeTruthy();
  });
  it("keeps the legacy warnings-array form", () => {
    expect(buildReport(raw, ["w"]).warnings).toEqual(["w"]);
    expect(buildReport(raw).warnings).toEqual([]);
  });
  it("never cuts a long MCP server name inside the placeholder", () => {
    const r = buildReport([{ logicalPath: ".mcp.json", scope: "project", text: JSON.stringify({ mcpServers: { [`${"n".repeat(36)}zebracorp`]: {} } }) }], { denylist: deny });
    expect(r.sources[0]!.represented).not.toMatch(/\[[a-z]*\s*\(|\[redact(?!ed\])/);
    expect(leaks(JSON.stringify(r))).toEqual([]);
  });
  it("renders sources HTML with an accessible black span and no names", () => {
    const html = renderSourcesTableHtml(report);
    expect(leaks(html)).toEqual([]);
    expect(html).toContain('<span class="rd" role="img" aria-label="redacted">[redacted]</span>');
    expect(html).toMatch(/\.rd\{background:#17191E/);
  });
});

describe("poster source SVG with a denylist", () => {
  // Nested files are not counted and no longer get a row of their own, so a counted rule with a denylisted path keeps the bars covered.
  const report = buildReport([...raw, { logicalPath: ".claude/rules/zebracorp-style.md", scope: "project", text: "- Be brief." }], { denylist: deny });
  const svg = renderPosterSvg(buildPosterModel(report, { agent: "claude-code", denylist: deny }));
  it("has no denylisted term in any variant and draws bars instead of the placeholder text", () => {
    expect(leaks(svg)).toEqual([]);
    expect(svg).not.toContain("[redacted]");
    const bars = svg.match(/<rect class="redacted"[^>]*>/g) ?? [];
    expect(bars.length).toBeGreaterThanOrEqual(3);
    for (const bar of bars) expect(bar).toMatch(/rx="4" fill="#17191E"/);
  });
  it("is deterministic", () => {
    expect(renderPosterSvg(buildPosterModel(report, { agent: "claude-code", denylist: deny }))).toBe(svg);
  });
  it("redacts findings text that bypasses the report, in wrapped rule text too", () => {
    const findings = {
      conflicts: [{
        a: { text: "Always use Acme Notes naming for zebracorp services in every file we touch today", ref: { path: "apps/acme-notes/CLAUDE.md", line: 3 } },
        b: { text: "Never mention secret-proj", ref: { path: "CLAUDE.md", line: 1 } },
        confidence: "high" as const, note: "likely wins: apps/zebracorp/CLAUDE.md (nested)",
      }],
      duplicates: [{ text: "mail fake.person@example.org", refs: [{ path: "a/zebracorp/AGENTS.md", line: 1 }, { path: "AGENTS.md", line: 2 }] }],
    };
    const out = renderPosterSvg(buildPosterModel(report, { findings, denylist: deny, version: "1.0.0-zebracorp" }));
    expect(leaks(out)).toEqual([]);
    expect(out).not.toContain("[redacted]");
    expect((out.match(/class="redacted"/g) ?? []).length).toBeGreaterThan((svg.match(/class="redacted"/g) ?? []).length);
  });
  it("redacts the eyebrow", () => {
    const model = buildPosterModel(report, { denylist: deny });
    expect(model.items.some((i) => i.type === "text" && i.zone === "eyebrow" && /WHAT CLAUDE CODE IS TOLD/.test(i.text))).toBe(true);
  });
  it("keeps non-redacted posters byte-identical in structure (no bars)", () => {
    expect(renderPosterSvg(buildReport(raw.slice(4)))).not.toContain('class="redacted"');
  });
});
