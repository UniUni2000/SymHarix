# Contributing

Thanks for helping improve SymHarix. Keep changes small, testable, and clear.

## Local Setup

Use the documented clean path:

```sh
bun install
cp .env.example .env
cp WORKFLOW.md.example WORKFLOW.md
```

Never commit a real `.env`, database, log directory, Telegram token, Telegram
chat id, webhook secret, API key, or generated workspace.

## Before Opening a PR

Run the same checks expected by CI:

```sh
bun install
bun run test
bun run build
git diff --check
```

Also check that publish-forbidden files are not tracked:

```sh
git ls-files | rg '(^|/)(\.env|.*\.db|logs/|workspaces/|node_modules/)'
```

The command should print nothing, except `.env.example` is intentionally allowed
by project policy.

## Pull Request Requirements

- Open PRs against `main`.
- Keep PRs focused on one feature, fix, or documentation area.
- Include what changed, why it changed, and how it was tested.
- Let GitHub Actions pass before merge.
- Do not bypass failing CI without explaining the failure and the risk.
- Do not include generated local runtime data, ignored files, secrets, or
  private Telegram identifiers.

## Commit Style

Use short, imperative commit messages. A lightweight prefix is welcome when it
helps scanning:

- `feat: ...`
- `fix: ...`
- `docs: ...`
- `test: ...`
- `ci: ...`
- `chore: ...`

## Security-Sensitive Changes

For changes touching Telegram delivery, webhook handling, repository access,
secret loading, local tunnel behavior, or runtime permissions, include focused
tests where practical and describe the real boundary that was verified.

Report suspected vulnerabilities through `SECURITY.md` instead of public issues.
