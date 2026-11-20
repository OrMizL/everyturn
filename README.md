# Every Turn

Every Turn makes a poster of the instructions an AI coding agent loads on every turn, before you type anything. It reads a repo's agent files (`CLAUDE.md`, `AGENTS.md`, Cursor rules, Copilot and Windsurf instructions, skill listings), estimates their size in tokens, and flags rules that conflict with or duplicate each other. It supports Claude Code, Codex, Cursor, Copilot and Windsurf.

Token counts are estimates (UTF-8 bytes ÷ 4, rounded up per source), and conflict detection uses deterministic heuristics, not a model.

Conflict and duplicate findings are heuristics: paraphrases outside the built-in lexicon are missed. They are checked against a labelled corpus of 77 cases (43 held out, 34 tuning) in `fixtures/corpus/cases.json`. The cases and the heuristics were written together, so this is regression coverage, not an independent precision measurement.

## Usage

```sh
npx everyturn [repo]
```

Requires Node.js 18 or later. The only official npm package is the unscoped `everyturn`; Every Turn has no `@everyturn/...` packages. With no argument it scans the current directory and writes into a new private directory under your temp folder (`$XDG_RUNTIME_DIR/everyturn` when set, otherwise `<tmpdir>/everyturn-<uid>`):

- `everyturn.png`, `everyturn.svg`, `everyturn.html`: the poster (1600 × 2000);
- `everyturn.source.svg`: an editable copy of the poster;
- `everyturn-sources.html`: every source with its size and status;
- `everyturn.json`: the full report.

Common options (`npx everyturn --help` lists them all):

- `--agent <claude-code|codex|cursor|copilot|windsurf>` picks the agent whose always-loaded files are counted (default `claude-code`).
- `--out <dir>` writes to a directory you choose. Writing inside the scanned repo also needs `--allow-out-in-repo`. Existing files are only replaced with `--overwrite`.
- `--include-user` also reads your user-level files (such as `~/.claude/CLAUDE.md`). Without it, only the repo is read, and scanning your home directory is refused.
- `--deny <term>` (repeatable) and `--denylist <file>` (one term per line) black out private names such as a company or project name. Only the number of terms is printed.
- `--findings off` skips conflict and duplicate detection.
- `--show-names` shows MCP server names and unknown settings keys, which are aliased by default.
- `--print-paths` prints the output directory. By default the CLI prints only file names, so terminal screenshots stay clean.

## Web page

A static web page does the same in the browser: paste or drop your files and download the poster. It includes a synthetic sample setup.

## Privacy

- **Everything runs locally.** The CLI reads files on your machine and writes to a local directory. The web page is static and runs entirely in your browser: no upload, no analytics, no storage, and its Content Security Policy sets `connect-src 'none'`, so it cannot send your files anywhere. Nothing is sent to a model or a server.
- **Review before sharing.** Look over the poster and especially `everyturn.json` before you post or send them. The JSON keeps the redacted text of every source; the poster also withholds an excerpt when it is unsure.
- **Redaction.** Secrets (by key name, known token shape or high entropy), home-directory paths, emails and hosts are masked before anything is written. Redaction is best effort; see the limits below.

## Build from source

```sh
npm ci
npm run everyturn -- <repo>   # the CLI from source
npm run gate                  # typecheck, lint, build, tests, privacy scan
npm run demo                  # the sample poster in out/demo
```

The npm package is built with `npm pack -w packages/cli`; `npm run pack-check` installs the tarball in a temp directory and compares its output with the repo's.

## Known redaction limits

Redaction is **best effort**. The rules block the common forms and the tool fails closed where it can (over-masking is accepted), but it is a set of heuristics, not a guarantee. The common forms (plain key/value, standard paths, `$HOME` and the other environment home roots, quoted values) are treated as bugs when they leak; forms rarer than those are documented here instead.

- **Secrets are found by key name.** A value is masked when it follows a secret-looking key (`token`, `secret`, `password`, `key`, ...), when it has a known token shape (prefixes such as `ghp_`, `sk-`, `AKIA`, JWTs, private-key blocks) or when a long run is high-entropy. Multi-line values (quoted, triple-quoted, `|` and `>` block scalars, `[...]` and `{...}`), YAML anchors, tags and aliases, and name/value pairs (a `name` entry that holds a secret name, next to its `value` entry; the name may be folded, anchored or an alias) are followed; an opener that never closes masks to the end of the file. Any run of spaces, tabs or no-break spaces between a key and its `=` or `:` is allowed (aligned `.env`, INI and TOML blocks). Best effort, and not covered:
  - a YAML `name` counts as a secret name only when it is a **single token** (`name: API_KEY`, also folded, anchored or an alias): `name: "GitHub token"` and `name: MY API KEY` are not, so the `value` next to them stays;
  - the privacy scan cannot flag the old leaking output of the triple-quote, anchored-quote and alias forms (it can only judge text it can read as a key and value); those forms are covered by the end-to-end tests (`packages/cli/test/r10.test.ts`, `r11.test.ts`), not by the scan;
  - exotic YAML: complex keys (`? ` beyond the plain `? name` / `: value` pair), multi-document tricks with `---`, custom tags that change what a value means, merge keys (`<<`), and anchors shared across documents or files (anchors are tracked over the whole text of one file, and an `@import` is not followed for them);
  - a secret written in prose without a key name (`the passphrase is amber violet`), prose that has a key word but no `:` or `=` after it (``the token is `violetzz` `` reaches the output), and a personal name written without a path or key around it. The page has no private-name denylist; the CLI's denylist is opt-in;
  - a secret split in a way no key or token shape shows, such as a password in a sentence, or digits that are not long or random enough to look like a token.
- **Markdown emphasis and tables.** Emphasis (`*`, `**`, `_`, `__`, `~~`), code ticks, quotes and the HTML tags `<b>…</b>`, `<strong>…</strong>`, `<em>…</em>` and `<i>…</i>` (any case; spaces around the key inside the tags are allowed: `<b>key </b>:`) around a key are stripped before the name is judged, so a bold, italic, struck-through or code-formatted label before its `:` or `=` is masked like the plain form. A table row whose key cell (any cell, emphasis and ticks stripped, at most four words) is a secret name has the cells to its right masked (a row such as `| <secret name> | value | note |` keeps only its first cell), and in a header-style table (a `|---|---|` delimiter row follows the header) a secret-named header masks its column in every row below it until the table ends. Table names are judged with the classic subset and a plural `s` ignored, so `| Name | Value |`, `| Key | Action |`, `| Auth | required |` and `| Session | 30 |` stay as they are. Tables without outer pipes work the same: a header line with a pipe above a delimiter row that has a pipe (`--- | ---`, `---|---`, `:--|--:`) starts a table, and every line with a pipe after it is a row until a blank line, a line without a pipe or a list item (`- … | …`, `1. … | …`, which is read as a rule and still scanned by the key and token rules); those rows are masked like piped ones and are never read as rules (a plain `---` rule or front-matter fence is not a delimiter). Not covered: a space inside a tag itself (`<b>key</b >:`), a `<code>key</code>:` key, a list item right after a table (`- token | value`: it ends the table, so its cells are not masked by the table's column; a `:` or `=` after a secret key in it is still masked), a secret in a table with no secret-named key cell or header (a column called `Details`), a row that does not start with `|` in a table that has no delimiter row, an HTML table, a row inside a block quote or a list item, a value cell to the LEFT of its key cell (`| <value> | <secret name> |`), and a header row that itself holds the value (`| <secret name> | <value> |` followed by `|---|`: the header is the key, the value is in the header line). Over-masked: a column headed `Tokens` or `Password` is masked whole even when it holds counts.
- **Setext headings.** A title underlined with `===` or `---` is read as paragraph text, not as a heading: it does not become heading context for the rules under it, and a directive-shaped title (`Never add comments` over `===`) is read as a rule. ATX headings (`#`) are handled.
- **Non-UTF-8 and binary input.** A file with a NUL byte is skipped as binary and a file that is not valid UTF-8 is skipped as invalid UTF-8, each with a warning that does not echo content. Nothing is decoded lossily, so it never reaches the report. Text in another encoding that happens to decode as UTF-8 is read as written.
- **Size limits.** A file over 256 KiB is skipped (a `SKILL.md` over that is read up to its first 64 KiB, enough for its front matter, and marked "read first 64 KiB"); a run stops reading at 5 MiB in all. The skipped files and the stop are reported as warnings; their content is not analysed.
- **Paths are heuristic.** Masked as `[path]`: `~`, `~/x`, a tilde-user path (`~name` followed by a slash), absolute POSIX paths, drive paths (`C:\`, `C:/`), UNC paths, `file://` URLs, and the environment home roots `$HOME`, `${HOME}`, `$USERPROFILE`, `$env:USERPROFILE`, `%USERPROFILE%`, `%HOMEPATH%`, `%APPDATA%` and `%LOCALAPPDATA%` when a slash or backslash follows (`$HOME` and `$USERPROFILE` are matched in upper case, `%VAR%` and `$env:` in any case). A folder name with spaces is handled by masking through the last slash-bearing word of the run; any run of spaces, tabs or no-break spaces counts as one separator, and a run ends at a line break, at `.` `;` `,` `)` followed by a space, at a quote or backtick, at `<` `>`, or at the UI separators `←` `→` `≠` `·` `|`.
  - May be **missed**: a bare `~name` with no slash, a drive-relative path (`C:name\x`), a bare `$HOME` with no slash (no path is disclosed), a path split across lines, a path whose folder name contains a quote, backtick, `<`, `>` or `|` (the run ends there), a home directory described in words, and repo-relative text that merely looks like a user path (`Users/alice/x` without a leading slash is a relative path and stays).
  - **Accepted limits:** `$HOME`, `${HOME}`, `$USERPROFILE` are matched in **upper case only**, so a lower-case `$home/…` or `${home}/…` is left as written (it reads as a template variable); and a drive-relative path such as `C:alice\x.md` **may be missed**.
  - May be **over-masked**: the prose that follows a path on the same line is swallowed up to the last slash-bearing word (`Use ~/x/y.md and docs/a.md` becomes `Use [path]`; `cd ~ && npm test in packages/core/src` becomes `cd [path]`).
- **The OCR render check is a gate check, not a guarantee.** `npm run render-check` runs `tesseract` (English) over the PNGs this tool generated and fails on text the redactor would have changed; it also scans the matching source SVG/HTML. It exists to catch our own rendering regressions. It can miss stylised, small or low-contrast text, and it says nothing about an image you made another way. It needs `tesseract` installed and is a development gate; the CLI and the page do not run it.
- **Time and memory.** Redaction time grows linearly with the input for every adversarial shape the tests try (`packages/core/test/r10-privacy.test.ts`, `r11-privacy.test.ts`: long runs of spaces before a separator, emphasis and quote runs, Markdown tables, repeated triple, single and double quotes, aliases, unclosed brackets; each 256 KiB input finishes in under 500 ms for `redactGeneric`, `secretBlockLines`, the scanner families and `looseSecretKey`, and doubling the size stays well below 4x). That is measured, not proven for every possible input. A 256 KiB file is the per-file cap.

## Release notes

- Published without npm provenance (manual publish).

## License

MIT. See [LICENSE](LICENSE). The bundled fonts, Inter and JetBrains Mono, are under the SIL Open Font License 1.1; their licence texts ship next to them.
