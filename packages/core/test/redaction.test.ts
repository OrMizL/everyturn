import { describe, expect, it } from "vitest";
import { buildPosterModel, buildReport, redact, renderPosterSvg, skillListing } from "../src/index";
import { FAMILIES, redactGeneric } from "../src/patterns.mjs";

// Every canary is assembled at runtime so the repository privacy scan never sees a literal secret shape.
const j = (...parts: string[]) => parts.join("");
const hex40 = () => j("0123456789abcdef", "0123456789abcdef", "01234567");
const hex32 = () => j("fedcba9876543210", "fedcba9876543210");
const uuid = () => j("123e4567-", "e89b-12d3-", "a456-", "426614174000");
const b64 = () => j("dXNlcjpwYXNz", "d29yZDEyMzQ1Ng==");
const idem = (text: string) => {
  const once = redact(text);
  expect(redact(once)).toBe(once);
  return once;
};

describe("explicit patterns for formats entropy cannot catch", () => {
  it("redacts 32+ char hex runs but keeps short git SHAs readable", () => {
    expect(idem(`key ${hex40()} end`)).toBe("key [secret] end");
    expect(idem(hex32())).toBe("[secret]");
    expect(idem(j("sha256:", hex40(), hex40()))).toBe("sha256:[secret]");
    expect(idem("fixed in a1b2c3d and 0123456789ab (12 chars); merge 1234567")).toBe("fixed in a1b2c3d and 0123456789ab (12 chars); merge 1234567");
    expect(redact(hex32().slice(0, 31))).toBe(hex32().slice(0, 31));
  });
  it("redacts UUIDs", () => {
    expect(idem(`id=${uuid()} done`)).toBe("id=[secret] done");
    expect(idem(uuid().toUpperCase())).toBe("[secret]");
  });
  it("redacts Basic credentials in headers and bare, but not prose", () => {
    // an `authorization` key masks everything after its separator (the scheme word included): fail-closed.
    expect(idem(j("Authorization: Bas", "ic ", b64()))).toBe("Authorization: [secret]");
    expect(idem(j("authorization:Basic ", "dXNl"))).toBe("authorization:[secret]");
    expect(idem(j("send Bas", "ic ", b64(), " now"))).toBe("send Basic [secret] now");
    for (const prose of ["Basic documentation", "Basic internationalization support", "Basic dXNlcjpw"]) expect(redact(prose)).toBe(prose);
  });
  const flags = ["--token", "--password", "--passwd", "--secret", "--api-key", "--apikey", "--auth"].map((f) => j(f.slice(0, 3), f.slice(3)));
  it.each(flags)("redacts the value after %s with a space or =, of any length", (flag) => {
    for (const value of ["x", "ab", "v".repeat(5), "Zz9".repeat(20)]) {
      expect(idem(`run ${flag} ${value} --verbose`)).toBe(`run ${flag} [secret] --verbose`);
      expect(idem(`run ${flag}=${value} --verbose`)).toBe(`run ${flag}=[secret] --verbose`);
    }
    expect(idem(`${flag} "two words"`)).toBe(`${flag} [secret]`);
  });
  it("does not treat longer flag names or words as secret flags", () => {
    for (const text of ["--token-file path", "--author name", "--password-file x", "x-pp y", "--auth-url u"]) expect(redact(text)).toBe(text);
  });
  it("redacts a JSON value on the line after its key", () => {
    const out = idem(j('{\n  "tok', 'en":\n    "', "v1", '",\n  "user": "bob"\n}'));
    expect(out).toBe(j('{\n  "tok', 'en":\n    "[secret]",\n  [secret]\n}')); // the sibling lies in the same JSON node
    expect(idem(j("pass", "word:\n  hunter2\nnext line"))).toBe(j("pass", "word:\n  [secret]\nnext line"));
    // fail-closed, the next non-empty line is the value whatever it looks like (prose included).
    expect(idem(j("Pass", "word:\nUse the locker for this one."))).toBe(j("Pass", "word:\n[secret]"));
  });
  it("redacts values behind => and -> arrows", () => {
    expect(idem(j('"pass', 'word" => "', "v1", '"'))).toBe('"password" => "[secret]"');
    expect(idem(j("tok", "en => ", "v1"))).toBe("token => [secret]");
    expect(idem(j("api_", "key -> ", "v1x"))).toBe("api_key -> [secret]");
    expect(idem(j("$conf['sec", "ret'] = 'v1'"))).not.toContain("v1");
  });
  it("redacts multi-word values after password/secret/token/passphrase keys", () => {
    expect(idem(j("pass", "word: correct horse battery"))).toBe("password: [secret]");
    expect(idem(j("sec", "ret = a b c d"))).toBe("secret = [secret]");
    // no delimiter stops the mask; only a closing quote followed by nothing but `,` `}` `]` is kept.
    expect(idem(j("pass", "phrase: 'correct horse' and more"))).toBe("passphrase: [secret]");
    expect(idem(j("pass", "phrase: 'correct horse',"))).toBe("passphrase: '[secret]',");
    expect(idem(j("the tok", "en: my long phrase"))).toBe("the token: [secret]");
    expect(idem(j('{"pass', 'word": "correct horse", "user": "bob"}'))).toBe('{"password": [secret]');
    expect(idem(j('{"pass', 'word": "correct horse"}'))).toBe('{"password": "[secret]"}');
    expect(idem(j("api_", "key: one two"))).toBe("api_key: [secret]");
  });
  it("redacts home paths whose username has spaces, and bare dash-encoded homes", () => {
    // every non-repo-relative path is `[path]`, the whole path (the old `~` stand-in is gone).
    expect(idem(j("/ho", "me/Fake Alice/x"))).toBe("[path]");
    expect(idem(j("/Us", "ers/Fake Alice/x/y"))).toBe("[path]");
    expect(idem(j("see /ho", "me/Fake Alice B/proj/CLAUDE.md"))).toBe("see [path]");
    expect(idem(j("C:", "\\Users", "\\Fake Alice\\x"))).toBe("[path]");
    expect(idem(j("/ho", "me/fakeuser and /etc/hosts"))).toBe("[path]"); // two paths joined by plain words are one run
    expect(idem(j("-ho", "me-fakeuser"))).toBe("[path]");
    expect(idem(j("~/.claude/projects/-Us", "ers-fakeuser/x"))).toBe("[path]");
    expect(idem(j("-Us", "ers-fakeuser"))).toBe("[path]");
  });
});

describe("public names and labels stay readable", () => {
  it("keeps filenames and skill paths intact", () => {
    for (const text of [
      ".claude/skills/release2026-notes/SKILL.md",
      "read .claude/skills/release2026-notes/SKILL.md first",
      ".claude/rules/database_migrations_2026_checklist.md",
      "packages/core/src/release2026-notes-for-the-big-quarterly-planning-review.ts",
      "release2026-notes-for-the-big-quarterly-planning-review",
    ]) expect(idem(text)).toBe(text);
  });
  it("still redacts a long high-entropy segment inside a path, and base64 with slashes", () => {
    const blob = j("aB3dE6gH9jK2mN5p", "Q8sT1vW4yZ7cF0iL", "xY2");
    expect(idem(`.claude/skills/${blob}/SKILL.md`)).toBe(".claude/skills/[secret]/SKILL.md");
    expect(idem(j("aB3dE6gH9jK2mN5p/", "Q8sT1vW4yZ7cF0iL"))).toBe("[secret]");
    expect(idem(j("/aB3dE6gH9jK2mN5p/", "Q8sT1vW4yZ7cF0iL"))).toBe("[path]"); // absolute: a path, whatever its segments look like
  });
  it("keeps prose key words that only contain or precede a key word: Primary key, hotkey, monkey", () => {
    for (const text of ["Primary key: id", "hotkey: ctrl+k", "monkey: banana", "turkey = 3", "Foreign key: user_id", "keyboard: us", "author: someone"]) {
      expect(redact(text)).toBe(text);
    }
  });
  it("a bare key, and compound names with a key word, are masked (fail-closed)", () => {
    expect(idem("key: value")).toBe("key: [secret]");
    expect(idem("mytokens: 3")).toBe("mytokens: [secret]");
    expect(idem("max_tokens: 4096")).toBe("max_tokens: [secret]");
    expect(idem("primary_key: id")).toBe("primary_key: [secret]");
  });
  it("still treats key as a secret name after api/secret/private/access prefixes and for token/secret/password words", () => {
    for (const [text, expected] of [
      [j("api", "Key: v1x"), "apiKey: [secret]"],
      [j("secret", "_key = v1x"), "secret_key = [secret]"],
      [j("private", "Key: v1x"), "privateKey: [secret]"],
      [j("access", "-key: v1x"), "access-key: [secret]"],
      [j("x-api", "-key: v1x"), "x-api-key: [secret]"],
      [j("GITHUB_", "TOK", "EN=v1x"), "GITHUB_TOKEN=[secret]"],
      [j("my", "tok", "en: v1x"), "mytoken: [secret]"],
      [j('{"db_pass', 'word":"v1x"}'), '{"db_password":"[secret]"}'],
    ] as const) expect(idem(text)).toBe(expected);
  });
  it("redacts the root home only at a path start", () => {
    expect(idem(j("cd /ro", "ot/x"))).toBe("cd [path]");
    expect(idem(j('"/ro', 'ot"'))).toBe('"[path]"');
    expect(idem(j("HOME=/ro", "ot"))).toBe("HOME=[path]");
    expect(idem(j("a:/ro", "ot/x"))).toBe("[path]"); // "a:/" reads as a drive path
    expect(idem(j("/ro", "ot"))).toBe("[path]");
    for (const text of ["app/root/x", "src/root/index.ts", "the root of the tree"]) expect(redact(text)).toBe(text);
    expect(idem("use /rooted/path")).toBe("use [path]"); // any absolute path is redacted, not only home directories
  });
  it("keeps --home-dir-path style flags", () => {
    for (const text of ["pass --home-dir-path /x", "--home-dir", "a--home-dir-path=1", "foo-home-bar"]) expect(redact(text)).toBe(text);
  });
});

describe("redaction is linear", () => {
  const KIB = 1024;
  const LIMIT = 1000;
  const time = (text: string) => {
    const start = performance.now();
    redact(text);
    return performance.now() - start;
  };
  const adversarial = (unit: string) => unit.repeat(Math.ceil((256 * KIB) / unit.length)).slice(0, 256 * KIB);
  it("256 KiB single token", () => { expect(time("aB3dE6gH".repeat(32 * KIB))).toBeLessThan(LIMIT); });
  it("256 KiB of a_", () => { expect(time(adversarial("a_"))).toBeLessThan(LIMIT); });
  it("256 KiB of dash-path text", () => {
    expect(time(adversarial("-a"))).toBeLessThan(LIMIT);
    expect(time(adversarial(j("-ho", "me-fake-dev-")))).toBeLessThan(LIMIT);
    expect(time(adversarial("a-b/c-d_e.f-"))).toBeLessThan(LIMIT);
  });
  it("256 KiB of mixed instruction text", () => {
    const paragraph = [
      "- Always run `npm test` before committing; see .claude/skills/release2026-notes/SKILL.md for the process.",
      "- Primary key: id. Token budget is 4000. Set API_URL=https://api.example.com and ask owner@example.org.",
      j("- Do not print the pass", "word: use the locker. Run mkdir -", "p build && node --home-dir-path=. app/root/x.js"),
      "Commit 0123456789ab fixed it; trace id a1b2c3d4. Basic documentation lives in docs/guide-2026.md.",
      "",
    ].join("\n");
    expect(time(adversarial(paragraph))).toBeLessThan(LIMIT);
  });
  it("adversarial repeats of every gate stay linear", () => {
    const units = ["@", "a.", "/home/", j("-----BEG", "IN PRIVATE KEY-----\n"), "tok" + "en ", "Basic ", "://", "a-", "sk-", "tok" + "en:\n", "pass" + "word: ", "--tok" + "en ", "-" + "p ", "A1", ".a.b", "a@", "Bearer ", "/ro" + "ot", " ", "\n"];
    for (const unit of units) expect(time(adversarial(unit)), JSON.stringify(unit)).toBeLessThan(LIMIT);
  });
  it("doubling the input does not quadruple the time", () => {
    const text = (n: number) => adversarial(j("-ho", "me-fake-dev-x a_b ")).repeat(1).slice(0, n);
    const a = Math.max(time(text(64 * KIB)), 1), b = time(text(256 * KIB));
    expect(b / a).toBeLessThan(16);
  });
});

describe("shared patterns", () => {
  it("every family is idempotent on its own output and returns clean text unchanged", () => {
    const dirty = [hex40(), uuid(), j("Authorization: Bas", "ic ", b64()), j("--tok", "en x"), j("pass", "word: a b"), j("/ho", "me/Fake Alice/x"), j("-ho", "me-fakeuser"), "owner@example.org"].join("\n");
    for (const family of FAMILIES) {
      const once = family.apply(dirty);
      expect(family.apply(once)).toBe(once);
      expect(family.apply("plain prose, nothing to see.")).toBe("plain prose, nothing to see.");
    }
    expect(redactGeneric(dirty)).toBe(redact(dirty));
  });
});

describe("poster excerpts use the same redaction", () => {
  it("redacts the new families in finding quotes and never emits the canaries", () => {
    const canaries = [hex40(), uuid(), b64(), "Fake Alice", "correct horse"];
    const report = buildReport([{ logicalPath: "CLAUDE.md", text: "- Be brief.", scope: "project" }]);
    const quote = (text: string, path: string) => ({ text, ref: { path, line: 1 } });
    const svg = renderPosterSvg(buildPosterModel(report, { findings: {
      conflicts: [{
        a: quote(j("Key ", hex40(), " id ", uuid(), " ", j("Authorization: Bas", "ic ", b64())), "CLAUDE.md"),
        b: quote(j("pass", "word: correct horse battery; /ho", "me/Fake Alice/x"), "AGENTS.md"),
        confidence: "high", note: "Both load at repo root.",
      }],
      duplicates: [],
    } }));
    for (const canary of canaries) expect(svg).not.toContain(canary);
    expect(svg).toContain("[secret]");
  });
});

describe("multi-line quoted descriptions", () => {
  it("strips the closing quote on the last continuation line", () => {
    for (const q of ['"', "'"]) {
      const text = `---\nname: demo\ndescription: ${q}First part\n  second part${q}\nother: x\n---\nbody`;
      expect(skillListing(text)).toEqual({ name: "demo", description: "First part second part" });
    }
  });
  it("keeps single-line quoted and plain descriptions as before", () => {
    expect(skillListing('---\nname: demo\ndescription: "One line"\n---\n')?.description).toBe("One line");
    expect(skillListing("---\nname: demo\ndescription: Don't stop\n  it's fine\n---\n")?.description).toBe("Don't stop it's fine");
    expect(skillListing("---\nname: demo\ndescription: >\n  folded \"quoted\"\n---\n")?.description).toBe('folded "quoted"');
  });
});

describe("flag rule does not garble ordinary commands", () => {
  it("keeps mkdir -p and similar short flags readable", () => {
    expect(redact("Run mkdir -p dist before building.")).toBe("Run mkdir -p dist before building.");
  });
});

describe("more secret shapes", () => {
  it("redacts space-separated key names (API key, secret key, access key, private key)", () => {
    for (const name of ["API ke", "secret ke", "access ke", "private ke", "Deploy API ke"]) {
      expect(idem(j(name, "y: fakeSmall9xyz"))).toBe(`${name}y: [secret]`);
    }
    expect(idem(j("the secret ke", "y = fakeSmall9xyz and more"))).toBe("the secret key = [secret]");
    for (const text of ["Primary key: id", "foreign key: user_id"]) expect(redact(text)).toBe(text);
    expect(idem("press the key: Enter")).toBe("press the key: [secret]"); // only the listed prose words exempt a bare `key`
  });
  it.each([["--access-", "tok", "en"], ["--github-", "tok", "en"], ["--db-", "pass", "word"], ["--client-", "sec", "ret"], ["--my-long-name-", "api-k", "ey"], ["--", "tok", "en"]] as const)(
    "redacts prefixed flags %s%s%s",
    (prefix, a, b) => {
      const flag = j(prefix, a, b);
      expect(idem(`run ${flag} v1x --verbose`)).toBe(`run ${flag} [secret] --verbose`);
      expect(idem(`run ${flag}=v1x --verbose`)).toBe(`run ${flag}=[secret] --verbose`);
    },
  );
  it("keeps look-alike flags", () => {
    for (const text of ["--token-file path", "--password-stdin", "--secrets-dir x", "--author name", "--no-tokens x"]) expect(redact(text)).toBe(text);
  });
  it("redacts PASS, PWD and PASSWD environment assignments, but not look-alikes", () => {
    expect(idem(j("export DB_PA", "SS=hunter2x"))).toBe("export DB_PASS=[secret]");
    expect(idem(j("MYSQL_P", "WD=v1x mysql"))).toBe("MYSQL_PWD=[secret] mysql");
    // an unknown next word may be part of a .env value, so the whole value is masked.
    expect(idem(j("MYSQL_P", "WD=v1x run"))).toBe("MYSQL_PWD=[secret]");
    expect(idem(j("DB_PASS", "WD='a b'"))).toBe("DB_PASSWD='[secret]'");
    expect(idem(j("P", "ASS=v1x"))).toBe("PASS=[secret]");
    for (const text of ["BYPASS_CACHE=1", "COMPASS_DIR=/x", "SURPASS=1", "PWDX=3", "PASSENGER_COUNT=2"]) expect(redact(text)).toBe(text);
  });
  it("redacts -p after mysql/mariadb/mysqldump/psql/sshpass/redis-cli, attached or separated, anywhere later on the line", () => {
    expect(idem(j("mysql -u root -", "pFakeV1x db"))).toBe("mysql -u root -p[secret] db");
    expect(idem(j("mysql -", "p v1x db"))).toBe("mysql -p [secret] db");
    expect(idem(j("mysqldump --single-transaction -h db -", "pv1x > dump.sql"))).toBe("mysqldump --single-transaction -h db -p[secret] > dump.sql");
    expect(idem(j("sshpass -", "p v1x ssh host"))).toBe("sshpass -p [secret] ssh host");
    expect(idem(j("sshpass -", "p 'two words' ssh host"))).toBe("sshpass -p [secret] ssh host");
    // psql and redis-cli use -p for the port, so it is kept; redis-cli's password flag is -a.
    expect(idem("psql -h db -U app -p 5432")).toBe("psql -h db -U app -p 5432");
    expect(idem("redis-cli -h x -p 6379 ping")).toBe("redis-cli -h x -p 6379 ping");
    expect(idem(j("redis-cli -h x -", "a v1x ping"))).toBe("redis-cli -h x -a [secret] ping");
    expect(idem(j("mariadb -", "pv1x"))).toBe("mariadb -p[secret]");
  });
  it("keeps plain -p and a -p with no value", () => {
    const plain = ["mkdir -p dist", "Run mkdir -p dist before building.", "tar -p x", "cp -p a b", "run ps -p 1"];
    const clients = [j("mysql -", "p"), j("mysql -", "p --host=x"), "mysql --port 3306", j("use `mysql -", "p` to be prompted"), j("(mysql -", "p), then")];
    for (const text of [...plain, ...clients]) {
      expect(redact(text)).toBe(text);
    }
    // -p before the client name is not its flag.
    const before = j("mkdir -p dist ; my", "sql -u root");
    expect(redact(before)).toBe(before);
  });
  it("redacts home paths case-insensitively", () => {
    expect(idem(j("/Ho", "me/fakeuser/x"))).toBe("[path]");
    expect(idem(j("/us", "ers/fakeuser/x"))).toBe("[path]");
    expect(idem(j("see /HO", "ME/fakeuser/x/y"))).toBe("see [path]");
    expect(idem(j("/Us", "ers/fakeuser"))).toBe("[path]");
    expect(idem(j("C:", "\\users", "\\fakeuser", "\\x"))).toBe("[path]");
  });
  it("redacts a JSON value that comes after one or more blank lines", () => {
    expect(idem(j('{\n  "tok', 'en":\n\n    "v1x"\n}'))).toBe(j('{\n  "tok', 'en":\n\n    "[secret]"\n}'));
    expect(idem(j('"tok', 'en":\n\n\n  \n\t\n  v1x,\n"user": "bob"'))).toBe(j('"tok', 'en":\n\n\n  \n\t\n  [secret]\n"user": "bob"'));
    expect(idem(j("pass", "word:\n\nhunter2"))).toBe(j("pass", "word:\n\n[secret]"));
    // prose after blank lines is the value too (fail-closed).
    expect(idem(j("Pass", "word:\n\nUse the locker for this one."))).toBe(j("Pass", "word:\n\n[secret]"));
  });
  it("stays linear on many keys followed by blank runs, repeated client names and long flag runs", () => {
    const text = j('"tok', 'en":\n') + "\n".repeat(50) + j('"tok', 'en":\n').repeat(2000);
    const started = performance.now();
    redact(text);
    redact(j("mysql ", "x ").repeat(20_000) + "-p");
    redact(j("--a-", "b").repeat(30_000));
    expect(performance.now() - started).toBeLessThan(1500);
  });
});

describe("prose after a secret key is masked too", () => {
  it("masks ordinary prose after a plain secret key", () => {
    for (const text of [j("Never print the sec", "ret: rotate weekly"), j("Never print the sec", "ret: rotate it weekly."), j("sec", "ret: keep this out of logs")]) {
      expect(idem(text)).toBe(text.replace(/: .*$/, ": [secret]"));
    }
    expect(idem(j("Never print the sec", "ret: rotate weekly 2026"))).toBe("Never print the secret: [secret]");
    expect(idem(j("sec", "ret: Rotate Weekly"))).toBe("secret: [secret]");
    expect(idem(j("sec", "ret: abc-123 weekly"))).toBe("secret: [secret]");
    expect(idem(j("sec", "ret: weekly"))).toBe("secret: [secret]");
    expect(idem(j("sec", "ret = a b c d"))).toBe("secret = [secret]");
    // The exemption is for `secret` only: passwords, tokens and passphrases keep masking multi-word values.
    expect(idem(j("pass", "word: correct horse battery"))).toBe("password: [secret]");
    expect(idem(j("the tok", "en: rotate weekly"))).toBe("the token: [secret]");
    expect(idem(j("pass", "phrase: correct horse battery staple"))).toBe("passphrase: [secret]");
  });
});
