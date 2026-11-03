# Server setup / 服务端启动

Read [SECURITY.md](SECURITY.md) first. Use the ordinary account that owns the remote hc session,
projects and agent credentials. No SSH or administrator/root privileges are required.

## Install and preflight

From a reviewed checkout:

```sh
node install.mjs --role server --check
```

If doctor fails, fix the reported dependencies/login. Node >=22, hc with `connect --session`, and official
`devtunnel` must be available. The tunnel owner account/provider must match the client's login.
The installer prints an absolute launcher path; use it if the launcher directory is not on PATH.

Existing manual PoC users: review the installation and use `--adopt` only if it is really this project.
Do not overwrite a working server's files/restart it without coordinating with its users.

## Foreground first

Choose a unique, dedicated tunnel name; replace `my-unique-agent-host` below.

```sh
herdr-devtunnel serve --tunnel my-unique-agent-host --create
```

Windows without a PATH entry:

```powershell
& "$env:LOCALAPPDATA\herdr-devtunnel\bin\herdr-devtunnel.cmd" serve --tunnel my-unique-agent-host --create
```

Defaults: loopback port `43821`, remote hc session `default`. Use `--port N` / `--session NAME` when needed;
the client must use the same values. `--hc PATH` and `--devtunnel PATH` select explicit executables.

Success requires BOTH:

```text
Bridge listening on 127.0.0.1:43821; hc session=default
Ready to accept connections for tunnel: NAME.CLUSTER
```

The `CLIENT COMMAND` log line alone does not mean the network is ready. Give the client the complete
identifier from the Ready line. `--create` is only for the first new tunnel. Future starts omit it.
Do not delete an existing tunnel because a name conflicts: verify ownership/purpose or choose another name.
Do not publish another user's port; if port 43821 is busy, choose a different one instead of killing its process.

## Windows: recommended long-term launch

Use the explicit current-user login task in [Windows autostart](docs/WINDOWS-AUTOSTART.md):

```powershell
herdr-devtunnel autostart install --name workbox --tunnel NAME.CLUSTER
# Verify/stop any old manual bridge first; do not stop hc or its agents.
herdr-devtunnel autostart start --name workbox
```

This runs only while the user is logged in, without SYSTEM/passwords/elevation. The task has bounded failure
retries and log rotation. `stop` disables future autostart until `start`; `uninstall` removes the task.
Registration does not automatically take over the old background process. Read the migration guide first.

## Windows manual background launch (temporary / fallback)

Do not start this while a foreground instance still owns the same port. Use the verified current account.

```powershell
$install = Join-Path $env:LOCALAPPDATA 'herdr-devtunnel'
$script = Join-Path $install 'herdr-devtunnel.mjs'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$tunnel = 'my-unique-agent-host'
# Add '--create' ONLY for a new tunnel that has not been created yet.
$arguments = @(('"{0}"' -f $script), 'serve', '--tunnel', $tunnel)
$stdout = Join-Path $install 'server.stdout.log'
$stderr = Join-Path $install 'server.stderr.log'
$p = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $install `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
$p.Id | Set-Content (Join-Path $install 'server.pid')
Start-Sleep -Seconds 10
Get-Content $stderr -Tail 40
```

For custom ports/sessions, append the same flags to `$arguments`. If tools are not on PATH, include their
absolute paths. This is a user process, not a Windows Service. Check readiness and whether it is still alive;
a PID by itself is not proof of success. Read logs instead of endlessly retrying `--create`.

## macOS / Linux background launch

Use the actual launcher/runtime paths printed by the installer (adjust for XDG/custom directories):

```sh
install_dir="${XDG_DATA_HOME:-$HOME/.local/share}/herdr-devtunnel"
nohup "$HOME/.local/bin/herdr-devtunnel" serve --tunnel my-unique-agent-host \
  </dev/null >"$install_dir/server.stdout.log" 2>"$install_dir/server.stderr.log" &
echo $! >"$install_dir/server.pid"
sleep 5
tail -n 40 "$install_dir/server.stderr.log"
```

Again, add `--create` only if the tunnel is new. This is not launchd/systemd or boot persistence.

## Stop / restart / partial creation

Before stopping, verify the PID still belongs to this project, not a reused PID. Stop only that bridge process.
On Windows, if a forced termination leaves a devtunnel host child behind, identify it by its exact tunnel
and process ancestry before cleanup; do not terminate every devtunnel process on the machine.
Core terminals are not deliberately stopped by the bridge. OS logout/reboot can still end user processes.

Restart with the same tunnel/port/session and **without `--create`**. Local hc reconnects independently.
Do not repeatedly `hc machine add` a connection that is already reconnecting.

If tunnel creation succeeded but port creation failed, inspect the dedicated tunnel first:

```sh
devtunnel show NAME.CLUSTER --json
devtunnel port create NAME.CLUSTER --port-number 43821 --protocol auto
```

Only create a missing port after verifying this is the intended owner-only tunnel. The bridge requires exactly
one published port and no additional access grants. Never reuse an unrelated SSH/application tunnel.

## Return to the client/operator

- Node, hc and devtunnel versions.
- Full tunnel identifier, published port and hc session.
- Install path, current server PID, log paths and readiness status.
- `herdr-devtunnel add --name workbox --tunnel NAME.CLUSTER --port 43821 --session default`.
- Errors redacted as needed; **no tokens, passwords or SSH keys**.

客户端收到后执行 add，检查 `hc machine ls` 和 `hc exec --on workbox whoami`，
最后查看 Herdr App 的远端机器/space。安装服务端不需要修改 sshd、域登录或 SSH key。
