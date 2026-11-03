# Changelog

## 0.2.0

- Add opt-in Windows current-user login tasks: install, start, stop, restart, status, logs, uninstall.
- Use Interactive/Limited logon, no stored password/elevation; bounded task retries and duplicate suppression.
- Add runId-scoped graceful shutdown, fresh-state reporting, rotating logs, and strict task ownership checks.
- Keep package installation and existing manual bridge processes unchanged until explicit migration.
- Fix Windows tunnel cleanup ordering: close supervisor lifetime pipe before considering forced cleanup.
- Add offline runner tests and opt-in Windows CI checks for unique disabled task registration/cleanup.
- Document migration, login/logout limits, and company-policy failure behavior.

## 0.1.1

- Prepare the public repository, English/Chinese quickstarts and agent deployment runbook.
- Add a dependency-free user-local installer for client/server/both, with ownership checks and dry-run.
- Add `doctor` and version commands; preserve existing live deployments during source preparation.
- Normalize Windows-client paths for hc's sh-based custom connection (E2E still needs verification).
- Add installer tests and a cross-platform offline CI matrix.
- Record successful macOS client → native Windows server connectivity with hc 0.1.17.

## 0.1.0 (local proof of concept)

- Private Dev Tunnels transport, loopback bridge to `hc connect`, and strict `hc --via` adapter.
- Binary streaming, half-close, CLI child cleanup, owner-only tunnel checks.
- Real-tunnel round-trip and reconnection tests with isolated hc sessions.
