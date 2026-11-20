import { describe, expect, it } from "vitest";
import { buildReport, configSummary, measure, redact, renderSourcesTableHtml, skillListing } from "../src/index";

const j = (...parts: string[]) => parts.join("");
const canary = () => j("Canary", "Value9");
const cases: [string, () => string, string][] = [
  ["bare TOKEN", () => j("TOKEN", "=", canary()), "TOKEN=[secret]"],
  ["bare PASSWORD", () => j("PASSWORD", "=", canary()), "PASSWORD=[secret]"],
  ["bare SECRET", () => j("SECRET", "=", canary()), "SECRET=[secret]"],
  ["legacy uppercase suffixed key", () => j("SERVICE_KEYNAME", "=", canary()), "SERVICE_KEYNAME=[secret]"],
  ["lower api_key", () => j("api_key", "=", canary()), "api_key=[secret]"],
  ["mixed apiKey", () => j("apiKey", ": ", canary()), "apiKey: [secret]"],
  ["lower password", () => j("password", ": ", canary()), "password: [secret]"],
  ["quoted token", () => j("tok", 'en: "', canary(), '"'), 'token: "[secret]"'],
  ["JSON API key", () => JSON.stringify({ [j("X_API_", "KEY")]: canary() }), '{"X_API_KEY":"[secret]"}'],
  ["JSON password", () => JSON.stringify({ [j("pass", "word")]: canary() }), '{"password":"[secret]"}'],
  ["escaped JSON value", () => JSON.stringify({ [j("pass", "word")]: j(canary(), '"', canary()) }), '{"password":"[secret]"}'],
  ["Authorization header", () => j("Authorization: Bear", "er ", canary()), "Bearer [secret]"],
  ["bare Bearer", () => j("Bear", "er ", canary()), "Bearer [secret]"],
  ["PEM block", () => j("-----BEGIN ", "RSA PRIVATE KEY-----\n", canary(), "\n", canary(), "\n-----END RSA ", "PRIVATE KEY-----"), "[secret]"],
  ["untyped PEM block", () => j("-----BEGIN ", "PRIVATE KEY-----\n", canary(), "\n-----END ", "PRIVATE KEY-----"), "[secret]"],
  ...["sk-", "sk_live_", "sk_test_", "rk_live_"].map((prefix): [string, () => string, string] => [prefix, () => j(prefix.slice(0, 2), prefix.slice(2), "abcdefghijklmnop1234"), "[secret]"]),
  ["short underscore key", () => j("sk", "_test_", "x"), "[secret]"],
  ["root home", () => j("/ro", "ot"), "[path]"],
  ["root descendant", () => j("/ro", "ot/proj/CLAUDE.md"), "[path]"],
  ["Linux home", () => j("/ho", "me/fakeuser/proj"), "[path]"],
  ["Mac home", () => j("/Us", "ers/fakeuser/proj"), "[path]"],
  ["Windows home", () => j("C:", "\\Users", "\\fakeuser", "\\proj"), "[path]"],
  ["JSON Windows home", () => j("C:", "\\\\Users", "\\\\fakeuser", "\\\\proj"), "[path]"],
  ["URL credentials before email", () => j("https://", "deployuser:", canary(), "@host/x"), "https://[credentials]@host/x"],
  ["email", () => j("private", "@", "company.test"), "[email]"],
  ...["internal", "local", "corp", "lan", "intranet"].map((suffix): [string, () => string, string] => [suffix, () => j("ci-runner", ".", "department", ".", suffix), "[host]"]),
  ...["home-fakeuser", "Users-fakeuser", "root"].map((prefix): [string, () => string, string] => [j("encoded ", prefix), () => j("-", prefix, "-dev-secretproj"), "[path]"]),
  ["host at sentence end", () => j("Service ", "mcp", ".acme", ".internal", "."), "Service [host]."],
  ["entropy", () => j("aB3dE6gH9jK2mN5p", "Q8sT1vW4yZ7cF0iL"), "[secret]"],
  ["entropy with base64 slashes", () => j("aB3dE6gH9jK2mN5p/", "Q8sT1vW4yZ7cF0iL"), "[secret]"],
  ["GitHub key", () => j("gh", "p_", "abcdefghijklmnopqrstuv12"), "[secret]"],
  ["GitHub PAT", () => j("github", "_pat_", "abcdefghijklmnopqrstuv12"), "[secret]"],
  ["Slack key", () => j("xox", "b-", "abcdefghijklmnop"), "[secret]"],
  ["AWS key", () => j("AK", "IA", "ABCDEFGHIJKLMNOP"), "[secret]"],
  ["JWT", () => j("ey", "Jabcdefghijklm.abcdefghijklmn.abcdefghijklmn"), "[secret]"],
];

describe("redaction boundaries", () => {
  it.each(cases)("redacts %s and is idempotent", (_label, make, expected) => {
    const result = redact(make());
    expect(result).toBe(expected);
    expect(redact(result)).toBe(result);
  });
  it("preserves ordinary prose, skill paths and low entropy strings", () => {
    const text = "Always read .claude/skills/release-notes/SKILL.md and documentation. " + "a1z9".repeat(15);
    expect(redact(text)).toBe(text);
    expect(redact(".claude/settings.local.json")).toBe(".claude/settings.local.json");
  });
  it("leaves no canary in JSON or HTML", () => {
    for (const [, make] of cases) {
      const report = buildReport([{ logicalPath: "CLAUDE.md", text: make(), scope: "project" }]);
      expect(report.sources[0]?.represented).toBe(redact(make()));
      expect(JSON.stringify(report) + renderSourcesTableHtml(report)).not.toContain(make());
    }
  });
});

describe("config summaries", () => {
  function adversarial() {
    const values = Array.from({ length: 9 }, (_, i) => j("FAKE", String(i), "-sensitive-value"));
    const home = j("/ho", "me/fakeuser/private/helper");
    const host = j("mcp", ".acme", ".internal");
    return { values: [...values, home, host], sources: [
      { logicalPath: ".mcp.json", scope: "project" as const, text: JSON.stringify({ mcpServers: {
        safe: { command: values[0], args: ["--token", values[1]], env: { FAKE: values[2] }, headers: { Authorization: j("Bear", "er ", values[3]!) }, url: j("https://", host, "/", values[4]!), type: "sse" },
      } }) },
      { logicalPath: ".claude/settings.local.json", scope: "project" as const, text: JSON.stringify({
        env: { [j("ANTHROPIC_API_", "KEY")]: values[5], [j("GITHUB_", "TOKEN")]: values[6] }, [j("api", "KeyHelper")]: home,
        permissions: { allow: [values[7]], deny: [values[8]], ask: [home] },
        hooks: { PreToolUse: [{ hooks: [{ command: home }, { command: values[0] }] }] }, model: home,
      }) },
    ] };
  }
  it("exports only permitted metadata, sizes summaries, and keeps rawBytes", () => {
    const { values, sources } = adversarial();
    const report = buildReport(sources);
    const output = JSON.stringify(report) + renderSourcesTableHtml(report) + report.sources.map((s) => s.represented).join("\n");
    for (const value of values) expect(output).not.toContain(value);
    for (const value of ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "--token", "command", "Authorization"]) expect(output).not.toContain(value);
    expect(output).toContain("(config summary)");
    const settings = report.sources.find((s) => s.kind === "settings")!;
    expect(settings.represented).toContain("allow 1, deny 1, ask 1");
    expect(settings.represented).toContain("PreToolUse: 2");
    expect(settings.represented).toContain("Environment variables: 2");
    expect(settings.represented).toContain("Model: [custom]");
    expect(settings.represented).toContain("API key helper: set");
    for (const source of report.sources) {
      expect(source.represents).toBe("config-summary");
      expect(source.bytes).toBe(measure(source.represented).bytes);
      expect(source.rawBytes).toBe(measure(sources.find((r) => r.logicalPath === source.logicalPath)!.text).bytes);
    }
    expect(report.sources.find((s) => s.kind === "mcp")?.represented).toBe("MCP servers: 1; server-1 (sse)");
  });
  it("shows a model only for public families (or default/opusplan)", () => {
    for (const model of ["sonnet", "opus", "haiku", "claude-sonnet-4-5", "claude-opus-4-1-20250805", "claude-sonnet-4", "claude-haiku-4-5-20251001", "default", "opusplan",
      "sonnet[1m]", "opus[1m]", "claude-sonnet-4-5[1m]", "claude-3-5-sonnet-latest", "claude-3-5-haiku-20241022", "claude-opus-5-5"]) {
      expect(configSummary(JSON.stringify({ model }), "settings").text).toContain(`Model: ${model}\n`.trimEnd());
    }
    // Slug-shaped private names, private suffixes, fine-tunes, paths and non-strings are never shown.
    for (const model of ["acme-secretproj-ft", "claude-4.5", "Sonnet", "sonnet-" + "a".repeat(30), "custom/path", "opus/x", 5, null,
      "sonnet-acme-secret", "claude-sonnet-acme", "claude-opus-4-1-acme", "opus-4-ft", "sonnet-4.5", "claude-opus-4-1-2025", "sonnet[1m]x", "default-x", "claude-sonnet-4-5-20250929-acme", "opus[2m]"]) {
      expect(configSummary(JSON.stringify({ model }), "settings").text).toContain("Model: [custom]");
    }
  });
  it("reports invalid JSON without parser errors or raw values", () => {
    const text = j('{"tok', 'en": ', canary());
    const report = buildReport([{ logicalPath: ".mcp.json", scope: "project", text }]);
    expect(report.sources[0]?.represented).toBe(`unparseable JSON, ${measure(text).bytes} bytes`);
    expect(report.warnings).toEqual([".mcp.json: unparseable JSON; config values omitted"]);
    expect(JSON.stringify(report)).not.toContain(canary());
  });
  it("aliases MCP server names (sorted by original name) and emits only transport choices", () => {
    const name = j("/ho", "me/fakeuser/") + "n".repeat(60);
    const servers = { [name]: { type: canary(), command: canary() }, "acme-payments-prod": { url: canary() }, stream: { type: "http" } };
    const summary = configSummary(JSON.stringify({ mcpServers: servers }), "mcp").text;
    for (const leak of ["fakeuser", canary(), "acme", "payments", "stream"]) expect(summary).not.toContain(leak);
    // Code-unit order: "/…" < "acme-…" < "stream".
    expect(summary).toBe("MCP servers: 3; server-1 (stdio); server-2 (http); server-3 (http)");
    const reversed = Object.fromEntries(Object.entries(servers).reverse());
    expect(configSummary(JSON.stringify({ mcpServers: reversed }), "mcp").text).toBe(summary);
  });
  it("--show-names (showNames) shows redacted, truncated server names", () => {
    const name = j("/ho", "me/fakeuser/") + "n".repeat(60);
    const summary = configSummary(JSON.stringify({ mcpServers: { [name]: { command: canary() }, http: { url: canary() } } }), "mcp", { showNames: true }).text;
    expect(summary).not.toContain("fakeuser");
    expect(summary).not.toContain(canary());
    expect(summary).toContain("[path] (stdio)"); // any absolute path is [path]
    expect(summary).toContain("http (http)");
  });
  it("shows only known settings keys and hook events by name; counts the rest", () => {
    const odd = j("fakeKeyName_", "orfake32");
    const settings = { model: "opus", env: { A: "1" }, [odd]: 1, another: 2, hooks: { PreToolUse: [{ hooks: [{}] }], [j("Acme", "Event")]: [{ hooks: [{}, {}] }], Stop: [{ hooks: [{}] }] }, permissions: { defaultMode: "plan", additionalDirectories: [j("/ho", "me/fakeuser/x")] } };
    const text = configSummary(JSON.stringify(settings), "settings").text;
    expect(text).toBe([
      "Settings fields: env, hooks, model, permissions, permissions.defaultMode, additionalDirectories, 2 other keys",
      "Permissions: allow 0, deny 0, ask 0",
      "Hooks: PreToolUse: 1; Stop: 1; 1 other event",
      "Environment variables: 1",
      "Model: opus",
    ].join("\n"));
    for (const leak of [odd, "another", "AcmeEvent", "fakeuser", "plan"]) expect(text).not.toContain(leak);
    const named = configSummary(JSON.stringify(settings), "settings", { showNames: true }).text;
    expect(named).toContain("another");
    expect(named).toContain("AcmeEvent: 2");
    expect(configSummary(JSON.stringify({ [odd]: 1 }), "settings").text).toContain("Settings fields: 1 other key");
    expect(configSummary("{}", "settings").text).toContain("Settings fields: none");
  });
});

it("orders equal sizes by original paths even when redaction collapses them", () => {
  const raw = ["z", "A", "a"].map((user, i) => ({ logicalPath: j("/ho", "me/", user, "/CLAUDE.md"), text: String(i), scope: "nested" as const }));
  const report = buildReport(raw, [j("z /ho", "me/fakeuser/file"), "A warning"]);
  expect(report.sources.map((s) => s.represented)).toEqual(["1", "2", "0"]);
  expect(buildReport([...raw].reverse(), [...report.warnings].reverse())).toEqual(report);
  expect(report.warnings).toEqual(["A warning", "z [path]"]);
});

it("groups only present agents in stable order and labels static inventory", () => {
  const paths = [".windsurfrules", ".github/copilot-instructions.md", ".cursor/rules/a.mdc", ".agents/skills/a/SKILL.md", ".codex/skills/a/SKILL.md", "AGENTS.override.md", "CLAUDE.local.md", ".claude/rules/a.md"];
  const report = buildReport(paths.map((logicalPath) => ({ logicalPath, text: logicalPath.endsWith("SKILL.md") ? "---\nname: demo\n---\n" : "rule", scope: "project" })));
  expect(Object.keys(report.byAgent)).toEqual(["claude-code", "codex", "cursor", "copilot", "windsurf"]);
  expect(report.byAgent.codex?.sources).toBe(3);
  for (const [agent, inventory] of Object.entries(report.byAgent)) {
    expect(inventory.bytes).toBe(report.sources.filter((s) => s.agent === agent).reduce((n, s) => n + s.bytes, 0));
  }
  const html = renderSourcesTableHtml(report);
  expect(html).toContain("Inventory across all agents:");
  expect(html).toContain("Not one live turn.");
  expect(html).toContain("<th>Agent</th>");
  expect(html).toMatch(/Claude Code ~\d+ · Codex ~\d+ · Cursor ~\d+ · Copilot ~\d+/);
  expect(html).not.toContain("before you type anything");
  expect(report.schemaVersion).toBe("1.3.0");
});

it.each([">", "|", "initial line"])("joins multiline skill descriptions (%s)", (style) => {
  expect(skillListing(`---\nname: demo\ndescription: ${style}\n  First continuation\n  second continuation\nother: ignored\n  not a description\n---\nbody`)).toEqual({ name: "demo", description: `${style === "initial line" ? "initial line " : ""}First continuation second continuation` });
});
