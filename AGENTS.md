# Instructions for coding and deployment agents

## If the user asks you to install this repository

Read `docs/AGENT-INSTALL.md` and `SECURITY.md` first. Choose client/server/both as requested.
The same package serves all roles. Do not invent a separate npm package or use the old herdr TUI.
Do not confuse GitHub deploy credentials with Dev Tunnels login.

## Project map

- `herdr-devtunnel.mjs`: CLI, transparent IO bridge, strict hc bootstrap adapter, devtunnel supervisor, doctor.
- `install.mjs`: dependency-free user-local installer. Never performs login, networking or machine registration
  unless the user explicitly requests `--check` (doctor reads CLI login/service status).
- `test/bridge.test.mjs`: offline protocol/lifecycle tests.
- `test/install.test.mjs`: sandboxed installer tests. Never writes to the real user installation.
- `test/live-smoke.py`: opt-in private tunnel + scratch hc integration test.
- `SERVER-SETUP.md`: foreground and background launch recipes.

## Development rules

1. Keep the official CLI as the authentication authority. No token scraping or credential files.
2. Default to ordinary-user, owner-only, loopback-only operation; reject extra ACL grants.
3. Never execute the bootstrap supplied by hc. Validate known connection-only syntax and map to fixed `hc connect`.
4. stdin/stdout of the connector is binary protocol, never a diagnostic stream. Use stderr for logs.
5. Preserve half-close, backpressure, framed traffic and child cleanup. Avoid screen parsing/agent-loop adapters.
6. Do not silently restart core/agents, delete tunnels, change machine configs or modify SSH.
7. Do not commit keys, tokens, logs, machine IDs, personal paths or real deployment configuration.
8. Tests must use scratch locations/sessions. Never stop a working core as part of testing.
9. Keep documentation explicit about known tested platforms vs intended support; Windows client still needs E2E.
10. A protocol/bootstrap change must be explicit and tested; do not broaden validation to arbitrary shell commands.

Run `npm test` and `npm run check` before proposing a commit. No npm dependencies are needed.
Only run the live test when network/resource creation is authorized. It creates a private test tunnel and deletes
that exact tunnel afterward. Do not use the user's existing tunnel for automated lifecycle tests.

Changes in the checkout do not update an already installed copy. Deployment updates require rerunning the
installer and coordinating any bridge restart. Do not do that to live connections just to test documentation.
