# Security and deployment assumptions

This prototype grants full herdr-core access, including command execution, terminal control, and file access,
as the account running the server. It is not a sandbox, policy engine, or multi-tenant service.

## Authentication boundary

- Use the official Dev Tunnels CLI; both sides sign in as the same owner identity/provider.
- The server binds only `127.0.0.1`. It publishes exactly one dedicated tunnel port and rejects additional
  tunnel/port ACL grants at startup. No anonymous or shared-access configuration is supported in this PoC.
- Do not change tunnel ACLs after startup. The initial check is not continuous policy enforcement.
- The application handshake checks protocol/session only. It is **not** a password or identity proof.
- Local processes can bypass Dev Tunnels authentication by connecting to the loopback listener. Therefore
  the server machine and its local users/processes must be trusted. For untrusted multi-user systems, add
  authenticated local transport or OS isolation before deployment. Loopback is not a per-user boundary.
- Dev Tunnels supplies network access control and transport protection; herdr-core does not add another
  independent user authentication/encryption layer.

## Privileges and lifetime

Run as an ordinary user, not root/Administrator. Access to this bridge means access to that user's resources.
Running inside an existing Windows user session avoids the failing sshd login/token-creation path; it does
not grant new domain/network rights or bypass company policy.

The bridge is a user process, not a service. Closing the bridge does not deliberately kill hc agent terminals,
but OS logout/reboot, process/job policies, or core/holder loss may end them. Do not promise unattended
persistence across these events.

## Input and process handling

The client recognizes the tested hc connection bootstrap but never evaluates it. The server only spawns the
configured hc executable with `connect --session NAME`, not a shell supplied by a network client.
Core API callers still have core's normal ability to run commands. Bootstrap validation is not a sandbox.

Handshake size/time and connection counts are bounded; protocol bytes use stream backpressure. stdout is
reserved for protocol data. A lifetime-pipe supervisor cleans up official CLI children when a connector dies;
platform-specific forced termination behavior still needs broader testing.

## Installation and maintenance

Review source/revision before running. Install under the current user. The installer does not fetch dependencies,
modify PATH/SSH/ACLs, create tunnels, register machines or restart services. Doctor reads dependency versions
and login status; its output can contain an account identifier. Do not post that output publicly unredacted.

The installer records executable paths and file hashes in a local manifest. This is bookkeeping, not a code
signature or protection against a malicious account-local process. Source-control pinning/checksums are not
an independent audit. Treat any dependency, hc, or CLI update as requiring compatibility validation.

GitHub deploy keys are only for repository maintenance. Never include a private key, credential store,
access token, log, or real deployment config in the repository or release archive. Public users can clone
this repository without a deploy key.

## Reporting

Do not put credentials or sensitive logs in public issues. If a security issue could expose user access,
use GitHub's private vulnerability reporting when enabled, or contact the maintainer privately first.
