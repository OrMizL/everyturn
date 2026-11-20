# Acme Notes — project instructions (synthetic demo)

See @AGENTS.md for shared agent rules.

## Workflow
- Always run `npm test` before committing.
- Keep pull requests small: one concern per PR.
- Use conventional commit messages (feat:, fix:, chore:).
- Never commit directly to main.
- Ask before adding a new dependency.

## Code style
- TypeScript strict mode everywhere.
- Prefer named exports over default exports.
- Don't add comments to code; write self-explanatory names instead.
- Use 2-space indentation.
- Keep functions under 40 lines.

## Testing
- Every bug fix ships with a regression test.
- Use Vitest, not Jest.
- Don't mock the database in integration tests.

## Communication
- Be concise. No summaries at the end of a response.
- When unsure, ask one clarifying question instead of guessing.
