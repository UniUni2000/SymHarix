# SymHarix Claude-Compatible Runtime

**Language:** English | [Chinese](./README.md)

This directory contains the bundled Claude-compatible runtime used by SymHarix. It is invoked by the root-level adapter at `scripts/claude-adapter.cjs` and is not the primary user-facing CLI.

Most users should run SymHarix from the repository root:

```bash
bun run start:local
```

## Entrypoints

- `bin/claude-symharix`: preferred internal runtime entrypoint.
- Legacy compatibility entrypoint retained for existing local setups.

The adapter resolves `claude-symharix` first and falls back to the legacy entrypoint only when the preferred entrypoint is unavailable.

## Environment

The runtime inherits environment variables from the parent SymHarix process. If `claude-code/.env` exists, `bin/claude-symharix` also loads it for local debugging; production deployments should configure secrets at the SymHarix service level.

## Checks

From the repository root:

```bash
bun run runtime:check
```

For direct runtime debugging:

```bash
claude-code/bin/claude-symharix --help
```
