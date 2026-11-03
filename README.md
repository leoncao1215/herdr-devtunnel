# herdr-devtunnel

**Use Herdr App on another machine over private Microsoft Dev Tunnels — without an SSH server.**

[中文](README.zh-CN.md) · [Agent installation guide](docs/AGENT-INSTALL.md) · [Server setup](SERVER-SETUP.md) · [Security](SECURITY.md)

```text
Herdr App → local hc → custom --via connector → devtunnel connect
                                                     ↕ private tunnel
CLI agents ← remote hc ← hc connect ← loopback bridge ← devtunnel host
```

Keep your native coding agent (Copilot CLI, Claude Code, etc.) and Herdr's terminal/session handling.
This project replaces the **transport**, not the agent harness. It is an independent community project,
not an official Microsoft or Herdr product, and currently a small proof of concept.

## Install on either side

Same package, different commands. Requires **Node.js 22+**, [herdr-core (`hc`)](https://github.com/herdrdev/herdr-core),
and the [official devtunnel CLI](https://learn.microsoft.com/azure/developer/dev-tunnels/get-started).
For the desktop UI, install [Herdr App](https://github.com/herdrdev/herdr-app) on the client.

```sh
git clone https://github.com/leoncao1215/herdr-devtunnel.git
cd herdr-devtunnel
node install.mjs --role both --check
```

Choose `--role client`, `--role server`, or `--role both`. Role affects preflight checks, not the installed
features. No npm dependencies and no `npm install` required. You can also download and extract this repository's ZIP.
Review the code before installing; use a reviewed commit/tag for repeatable deployments.

The installer copies the runtime out of the checkout and prints an absolute launcher path:

| OS | Runtime | Launcher |
|---|---|---|
| macOS / Linux | `$XDG_DATA_HOME/herdr-devtunnel` or `~/.local/share/herdr-devtunnel` | `~/.local/bin/herdr-devtunnel` |
| Windows | `%LOCALAPPDATA%\herdr-devtunnel` | `%LOCALAPPDATA%\herdr-devtunnel\bin\herdr-devtunnel.cmd` |

Use that launcher directly or add its directory to your **user** PATH. The installer does not change PATH,
install dependencies, elevate privileges, sign in, create tunnels, register machines, or start background services.
With `--check`, missing dependencies/login return a nonzero exit code **after files are installed**.
A pre-existing manual PoC installation requires reviewed, explicit `--adopt`; unrelated files are not overwritten.

## Authentication

On **both machines**, sign in to devtunnel using the **same account and identity provider**:

```sh
devtunnel user login
devtunnel user show
herdr-devtunnel doctor --role both
```

Authentication must be completed by the user. This PoC accepts **owner-only private tunnels**, without extra
access grants. Never enable anonymous access. GitHub deploy keys are unrelated: they are only for maintaining
the Git repository and must not be copied to client/server machines for this tool.

## Server: publish a core

Run as the ordinary user who owns your projects and agent credentials. Pick a unique tunnel name:

```sh
herdr-devtunnel serve --tunnel my-unique-agent-host --create
```

Only the **first** run needs `--create`. Later:

```sh
herdr-devtunnel serve --tunnel my-unique-agent-host
```

Wait for `Ready to accept connections for tunnel: NAME.CLUSTER`, then give the client that full identifier.
Defaults: `127.0.0.1:43821`, remote hc session `default`. Keep this process alive; see
[Server setup](SERVER-SETUP.md) for user-level background launch on Windows, macOS and Linux.
No system service or boot persistence is installed automatically.

### Windows: login autostart

After installing this package and creating the tunnel, opt in explicitly:

```powershell
herdr-devtunnel autostart install --name workbox --tunnel NAME.CLUSTER
# Stop any old manual bridge yourself after verifying its identity, then:
herdr-devtunnel autostart start --name workbox
herdr-devtunnel autostart status --name workbox
herdr-devtunnel autostart logs --name workbox
```

This registers a current-user **Interactive / Limited** task, with bounded failure retries.
It requires login after reboot, stores no password, and does not run as SYSTEM.
`stop` disables autostart and gracefully closes this bridge; `start` enables it again.
See [Windows autostart](docs/WINDOWS-AUTOSTART.md) for migration, restart and removal.
macOS/Linux autostart is not yet implemented.

## Client: add the machine

After the server is ready:

```sh
herdr-devtunnel add --name workbox --tunnel NAME.CLUSTER
hc machine ls
hc exec --on workbox whoami
```

The machine joins the local core's machine list. Herdr App using that core can show its remote spaces/terminals;
if it has no space yet, create one on that machine. **Do not add it again using App's SSH setup.**
Run your coding agent in the remote terminal normally.

No SSH keys, `sshd`, domain-account SSH login or edits to `~/.ssh/config` are involved.
On Windows **clients**, hc's `--via` also needs `sh` on PATH (for example Git for Windows' shell).
A Windows server does not need `sh` for this bridge itself. Native Windows client E2E is not yet verified.

## Install with your agent

Give your agent the repository URL plus this instruction:

> Read `docs/AGENT-INSTALL.md` and `SECURITY.md`. Install this repository for role CLIENT/SERVER/BOTH,
> using my ordinary user. Do not change SSH or enable anonymous access. Verify dependencies and login,
> then configure the connection using the tunnel/name I provide. Report checks, paths and readiness.
> Ask before installing missing dependencies or changing existing running connections.

The guide includes prompts, prerequisites, exact commands, success criteria, and stop conditions.
On a prepared machine, installation is one command; browser authentication and host-specific prerequisites
cannot safely be made unattended.

## Options

```sh
herdr-devtunnel --help
herdr-devtunnel --version
herdr-devtunnel doctor --role client --json
herdr-devtunnel serve --tunnel NAME --port 43822 --session work
herdr-devtunnel add --name workbox --tunnel NAME.CLUSTER --port 43822 --session work
```

`--hc PATH` and `--devtunnel PATH` select explicit executables. `add --timeout 90` changes setup timeout.
Use one dedicated tunnel for each published bridge; port/session must agree at both ends.
A machine may act as a client and server at the same time. Avoid connecting a core to itself or creating cycles.
For multiple server sessions on one machine, use separate ports/tunnels/processes.

## Updates and removal

Update your checkout to a reviewed revision, rerun `node install.mjs --role … --check`, and coordinate a server
bridge restart. Active Node processes keep their loaded code; updates do not restart them or the agents.
The installer preserves logs and unrelated files in owned installation directories.

Client registrations store absolute executable paths. If Node/devtunnel or the installation location changes,
remove/re-add **only the affected connection** with `hc machine rm NAME` and `herdr-devtunnel add …`.
Do not use Herdr's SSH Login / Update Core actions for these machines; maintain hc on the remote host directly.

If using Windows autostart, run `herdr-devtunnel autostart uninstall --name PROFILE` first.
To uninstall, remove the relevant hc machine registration, stop any remaining manual bridge after verifying its PID,
then remove its launcher/runtime directory. This does not stop agent terminals or delete tunnels. Delete only
an explicitly identified, no-longer-needed tunnel with `devtunnel delete NAME.CLUSTER --force`.

## Compatibility and tests

Verified manually:
- macOS client: Node 24.20.0, hc 0.1.17, devtunnel 1.0.2030.
- Native Windows server: Node 24.14.0, hc 0.1.17, devtunnel 1.0.2115.
- Mac → Windows private tunnel: connected machine, `whoami`, remote command execution, and remote space
  appearing in Herdr App 0.1.12. User confirmed the connection works.
- Mac loopback through real Dev Tunnels: bridge restart/reconnect preserves the remote terminal and process PID.

Not yet verified: Windows/Linux client E2E, Linux server E2E, full interactive-agent input/approval behavior,
Chinese/code-page behavior, or persistence after OS logout/reboot. Old `herdr` TUI 0.8.x is not this integration.

The client validates hc 0.1.17's bootstrap format and fails closed on unknown commands. It never evaluates the
received shell line. devtunnel's connect-output parser was tested with the client version above; CLI format
changes may require updating it. This is not a promise of compatibility with every future release.

```sh
npm test                    # offline; no tunnel or login needed
npm run check
python3 test/live-smoke.py   # OPT-IN: creates/deletes a private 1h test tunnel; macOS/Linux
```

Live tests use scratch core sessions, not your working machines. CI runs offline tests on macOS, Linux and
Windows with Node 22/24; Unix-only process fixtures are skipped on Windows. Windows CI explicitly opts into
creating/inspecting/removing a unique **disabled** scratch scheduled task; it never starts one. Local `npm test`
does not create tasks unless `HERDR_TEST_WINDOWS_TASKS=1` is deliberately set. Real user login-trigger behavior
and corporate task policies still require deployment-machine verification.

## Security summary

**Access to the bridge is effectively shell/file access as its server user.** Private-tunnel identity checks
protect the tunnel, not the local listener: trusted local processes can reach `127.0.0.1:43821` directly.
There is no second application password. Do not deploy on an untrusted multi-user host without additional
local authentication/isolation. Read [SECURITY.md](SECURITY.md) before publishing a bridge.

## License

MIT. See [LICENSE](LICENSE).
