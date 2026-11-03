# Changelog

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
