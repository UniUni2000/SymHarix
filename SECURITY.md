# Security Policy

SymHarix handles automation, repository access, and Telegram-facing workflows, so
security reports are taken seriously.

## Reporting a Vulnerability

Do not open a public issue if the report contains a token, credential, private
chat id, webhook secret, database dump, log excerpt with secrets, or an
exploitable vulnerability.

Preferred reporting path:

1. Open a private GitHub security advisory:
   https://github.com/UniUni2000/SymHarix/security/advisories/new
2. If private advisories are unavailable, contact the maintainers privately
   through the repository owner's GitHub profile or an existing private project
   channel.

Please include:

- A short description of the issue and impact.
- Affected commit, tag, or release.
- File paths, endpoint paths, or workflow names involved.
- Reproduction steps, if safe to share.
- For leaked secrets, the secret type and where it appeared, with the actual
  secret redacted.

## Token or Secret Leakage

If you discover a real token, webhook secret, Telegram bot token, Telegram chat
id, API key, database, or log containing sensitive data:

1. Stop sharing it publicly.
2. Report it privately using the process above.
3. Revoke or rotate the token if it belongs to you.
4. Include the commit SHA, file path, and whether the leak is present in git
   history, a release artifact, CI logs, or the current worktree.

Maintainers should treat confirmed leakage as compromised, rotate affected
credentials, remove the secret from current files, and clean git history when
the repository has already been published.

## Response Expectations

We aim to acknowledge reports within 48 hours and provide a triage update within
7 days. Coordinated disclosure timing depends on severity, exploitability, and
whether credential rotation or history cleanup is required.

## Supported Versions

Security fixes target the current `main` branch unless a release branch is
explicitly maintained.
