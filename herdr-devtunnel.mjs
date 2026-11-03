#!/usr/bin/env node
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { accessSync, constants, realpathSync, readFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const MAGIC = 'herdr-devtunnel/1';
const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const log = (message) => process.stderr.write(`[herdr-devtunnel] ${message}\n`);
const HELP = `Herdr Dev Tunnel transport (PoC, no SSH, Node >=22)

Server (run under the Windows user who owns hc/Copilot):
  node herdr-devtunnel.mjs serve --tunnel NAME --create
  node herdr-devtunnel.mjs serve --tunnel NAME.CLUSTER

Client (after server is ready):
  herdr-devtunnel add --name my-remote --tunnel NAME.CLUSTER

Preflight:
  herdr-devtunnel doctor --role client|server|both [--json]
  herdr-devtunnel --version

Options:
  --port N             Published server port (default 43821)
  --session NAME       hc session (default default)
  --hc PATH            hc executable (default: resolve hc on PATH)
  --devtunnel PATH      Official devtunnel executable
  --timeout N          Setup timeout in seconds (default 45)

serve --create creates a NEW private tunnel and port. It never grants anonymous
access. Subsequent runs omit --create. This PoC requires the SAME devtunnel
account on both sides and an owner-only tunnel with no extra access grants.
No service/autostart is installed. Keep the server process running.

Internal/test modes:
  connect ... '<hc-generated remote command>'    used by hc --via
  serve --no-tunnel --port N                    loopback bridge only
  connect --local-port N ...                    bypass devtunnel for testing

The bridge grants full hc access to its server account. Trust local processes.
Dedicated tunnel only; no automatic hc install/update or arbitrary shell exec.
`;

export function parseArgs(args) {
  const out = { _: [] };
  const flags = new Set(['create', 'no-tunnel', 'help', 'json']);
  const values = new Set(['tunnel', 'port', 'session', 'hc', 'devtunnel', 'timeout', 'name', 'local-port', 'mode', 'role']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    const key = arg.slice(2);
    if (flags.has(key)) out[key] = true;
    else if (values.has(key) && args[i + 1] && !args[i + 1].startsWith('--')) out[key] = args[++i];
    else throw new Error(`Unknown option or missing value: ${arg}`);
  }
  return out;
}

function number(value, fallback, max) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`Invalid number: ${value}`);
  return n;
}
function sessionName(value = 'default') {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(value)) throw new Error('Invalid session name');
  return value;
}
function tunnelName(value) {
  if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9.-]{1,150}$/.test(value)) throw new Error('Use an explicit tunnel name or ID.cluster');
  return value;
}
export function executable(name) {
  const paths = name.includes('/') || name.includes('\\') ? [resolve(name)] :
    (process.env.PATH ?? '').split(delimiter).map(p => join(p, name));
  for (const p of paths) {
    for (const suffix of process.platform === 'win32' ? ['', '.exe'] : ['']) {
      try { accessSync(p + suffix, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return realpathSync(p + suffix); } catch {}
    }
  }
  throw new Error(`Executable not found: ${name}. Install it first or supply its absolute path.`);
}
export const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;

export function accessEntries(access) {
  // The official CLI flattens the SDK's {entries: [...]} into an array.
  if (access === undefined || access === null) return [];
  if (Array.isArray(access)) return access;
  if (Array.isArray(access.entries)) return access.entries;
  throw new Error('Unrecognized tunnel ACL format; refusing to publish');
}

// hc --via supplies a shell line. Do NOT execute it. Only accept the known
// connection-only bootstrap emitted by hc 0.1.17/current upstream. Fail closed
// for probes, installers, changed bootstrap syntax and other sessions.
export function validateBootstrap(line, session = 'default') {
  sessionName(session);
  const unix = /^sh -c 'p=\$\(command -v herdr-core\) \|\| p=\$HOME\/\.local\/bin\/herdr-core; \[ -x "\$p" \] \|\| \{ echo "herdr-core is not installed here" >&2; exit 127; \}; (?:HC_SESSION=([a-zA-Z0-9_.-]+) )?exec "\$p" connect'$/;
  const match = unix.exec(line ?? '');
  if (!match) throw new Error('Unsupported hc bootstrap. This PoC supports connect only (hc 0.1.17); install/update hc manually. No remote shell command was executed.');
  if ((match[1] ?? 'default') !== session) throw new Error('hc session does not match the bridge session');
}

export function forwardingPort(line, remotePort) {
  const match = /Forwarding from 127\.0\.0\.1:(\d+) to host port (\d+)\./.exec(line);
  return match && Number(match[2]) === remotePort ? Number(match[1]) : null;
}

export function readLine(stream, timeout = 10000, max = 4096) {
  return new Promise((resolvePromise, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => fail(new Error('Bridge handshake timed out')), timeout);
    const clean = () => { clearTimeout(timer); stream.off('data', data); stream.off('error', fail); stream.off('end', ended); stream.off('close', ended); };
    const fail = err => { clean(); reject(err); };
    const ended = () => fail(new Error('Bridge closed before handshake completed'));
    const data = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const pos = buffer.indexOf(10);
      if (pos > max || (pos < 0 && buffer.length > max)) return fail(new Error('Bridge handshake too large'));
      if (pos < 0) return;
      stream.pause(); clean();
      const rest = buffer.subarray(pos + 1);
      if (rest.length) stream.unshift(rest);
      resolvePromise(buffer.subarray(0, pos).toString('utf8'));
    };
    stream.on('data', data); stream.once('error', fail); stream.once('end', ended); stream.once('close', ended); stream.resume();
  });
}

function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 2500);
  timer.unref(); child.once('exit', () => clearTimeout(timer));
}

function runCommand(bin, args, timeout = 45000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '', settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) { stopChild(child); reject(error); } else resolvePromise(value);
    };
    const timer = setTimeout(() => finish(new Error(`${bin} timed out`)), timeout);
    child.stdout.on('data', b => { stdout += b; if (stdout.length > 1024 * 1024) finish(new Error('CLI output too large')); });
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-16000); });
    child.once('error', e => finish(e));
    child.once('close', code => finish(code === 0 ? null : new Error(`${bin} exited ${code}: ${stderr || stdout}`), stdout));
  });
}

// A small supervisor owns the CLI. Its stdin is a lifetime pipe from the
// parent: even if hc SIGKILLs our connector, EOF makes it reap devtunnel.
async function tunnelChild(args) {
  if (!['connect', 'host'].includes(args.mode)) throw new Error('Invalid tunnel mode');
  const child = spawn(executable(args.devtunnel ?? 'devtunnel'), [args.mode, tunnelName(args.tunnel)], {
    stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
  });
  const stop = () => stopChild(child);
  process.stdin.resume(); process.stdin.on('end', stop);
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  child.once('error', e => { log(e.message); process.exit(1); });
  child.once('exit', code => process.exit(code ?? 1));
}
function managedTunnel(args, mode) {
  return spawn(process.execPath, [SELF, '_tunnel', '--devtunnel', executable(args.devtunnel ?? 'devtunnel'), '--mode', mode, '--tunnel', tunnelName(args.tunnel)], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
}
function lines(stream, callback) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    pending += chunk;
    let pos;
    while ((pos = pending.indexOf('\n')) >= 0) {
      callback(pending.slice(0, pos).replace(/\x1b\[[0-9;]*m/g, '').trimEnd());
      pending = pending.slice(pos + 1);
    }
    if (pending.length > 65536) pending = pending.slice(-4096);
  });
  stream.on('end', () => { if (pending) callback(pending); });
}
async function tunnelPort(child, remotePort, timeout) {
  return new Promise((resolvePromise, reject) => {
    let mapped, settled = false;
    const timer = setTimeout(() => finish(new Error('No matching devtunnel local port; check host, access, published port and CLI output format')), timeout);
    const finish = (error, port) => {
      if (settled) return; settled = true; clearTimeout(timer);
      child.off('error', errorHandler); child.off('exit', exited);
      error ? reject(error) : resolvePromise(port);
    };
    const errorHandler = error => finish(error);
    const exited = code => finish(new Error(`devtunnel connect exited ${code}`));
    const line = text => {
      if (text) log(text);
      mapped = forwardingPort(text, remotePort) ?? mapped;
      if (mapped && text.includes(`PortForwardingService listening on 127.0.0.1:${mapped}.`)) finish(null, mapped);
    };
    lines(child.stdout, line); lines(child.stderr, line);
    child.once('error', errorHandler); child.once('exit', exited);
  });
}

export function createBridge({ hc, session = 'default', maxConnections = 32 }) {
  sessionName(session);
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    if (sockets.size >= maxConnections) { socket.destroy(); return; }
    sockets.add(socket); socket.setNoDelay(true);
    let child;
    socket.on('error', () => {});
    socket.once('close', () => { sockets.delete(socket); stopChild(child); });
    void (async () => {
      const request = JSON.parse(await readLine(socket));
      if (request.protocol !== MAGIC || request.session !== session) throw new Error('Wrong protocol or session');
      child = spawn(hc, ['connect', '--session', session], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child.once('error', () => socket.destroy());
      await once(child, 'spawn');
      if (socket.destroyed) { stopChild(child); return; }
      child.stdin.on('error', () => socket.destroy());
      child.stdout.on('error', () => socket.destroy());
      lines(child.stderr, text => { if (text) log(`hc: ${text}`); });
      child.once('exit', () => socket.end());
      socket.write(JSON.stringify({ protocol: MAGIC, ok: true, session }) + '\n');
      socket.pipe(child.stdin); child.stdout.pipe(socket); socket.resume();
    })().catch(error => { log(`Bridge rejected/closed: ${error.message}`); socket.destroy(); });
  });
  server.stop = () => { for (const socket of sockets) socket.destroy(); server.close(); };
  return server;
}

async function serve(args) {
  if (args._.length) throw new Error('Unexpected positional arguments');
  const port = number(args.port, 43821, 65535), session = sessionName(args.session);
  const hc = executable(args.hc ?? 'hc');
  const server = createBridge({ hc, session });
  let tunnel;
  const stop = () => { server.stop(); tunnel?.stdin.end(); stopChild(tunnel); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    // Bind before publishing: do not accidentally publish another local service.
    server.listen(port, '127.0.0.1'); await once(server, 'listening');
    log(`Bridge listening on 127.0.0.1:${port}; hc session=${session}`);
    log('Security: authenticated tunnel clients AND trusted local processes get full access to this hc account.');
    if (args['no-tunnel']) return;
    const cli = executable(args.devtunnel ?? 'devtunnel');
    let target = tunnelName(args.tunnel);
    await runCommand(cli, ['user', 'show']);
    if (args.create) {
      const created = JSON.parse(await runCommand(cli, ['create', target, '--json']));
      const t = created.tunnel ?? created;
      if (t.tunnelId && t.clusterId) target = `${t.tunnelId}.${t.clusterId}`;
      log(`Created PRIVATE tunnel ${target}. It remains after this process exits.`);
      await runCommand(cli, ['port', 'create', target, '--port-number', String(port), '--protocol', 'auto', '--json']);
    }
    const data = JSON.parse(await runCommand(cli, ['show', target, '--json']));
    const t = data.tunnel ?? data;
    const ports = t.ports ?? [];
    if (ports.length !== 1 || ports[0].portNumber !== port) throw new Error(`Use a dedicated tunnel with exactly port ${port} published`);
    const entries = [...accessEntries(t.accessControl), ...ports.flatMap(p => accessEntries(p.accessControl))];
    // Fail closed on all additional grants, including flattened CLI ACL
    // strings. Owner access is implicit. Broader sharing is outside this PoC.
    if (entries.length) throw new Error('This PoC requires an owner-only private tunnel with no additional tunnel/port access grants. Use a new dedicated tunnel.');
    if (t.tunnelId && t.clusterId) target = `${t.tunnelId}.${t.clusterId}`;
    tunnel = managedTunnel({ ...args, tunnel: target }, 'host');
    lines(tunnel.stdout, text => { if (text) log(text); });
    lines(tunnel.stderr, text => { if (text) log(text); });
    tunnel.once('error', error => { log(error.message); process.exitCode = 1; stop(); });
    tunnel.once('exit', code => { if (code) process.exitCode = 1; server.stop(); });
    log(`CLIENT COMMAND: herdr-devtunnel add --name my-remote --tunnel ${target} --port ${port} --session ${session}`);
  } catch (error) { stop(); throw error; }
}

async function connect(args) {
  const session = sessionName(args.session);
  if (args._.length !== 1) throw new Error('connect expects the hc-generated bootstrap as its last argument');
  validateBootstrap(args._[0], session);
  const timeout = number(args.timeout, 45, 600) * 1000;
  let child, socket;
  let stopped = false;
  const stop = () => {
    if (stopped) return; stopped = true;
    process.stdin.unpipe(); process.stdin.pause(); socket?.destroy();
    child?.stdin.end(); stopChild(child);
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  process.stdout.on('error', stop);
  try {
    let port;
    if (args['local-port']) port = number(args['local-port'], 0, 65535);
    else {
      child = managedTunnel(args, 'connect');
      child.once('exit', () => { if (socket && !stopped) { process.exitCode = 1; stop(); } });
      port = await tunnelPort(child, number(args.port, 43821, 65535), timeout);
    }
    if (stopped) return;
    socket = net.createConnection({ host: '127.0.0.1', port, allowHalfOpen: true });
    socket.setNoDelay(true);
    const timer = setTimeout(() => socket.destroy(new Error('Local forward connection timed out')), 10000);
    try { await once(socket, 'connect'); } finally { clearTimeout(timer); }
    socket.write(JSON.stringify({ protocol: MAGIC, session }) + '\n');
    const reply = JSON.parse(await readLine(socket, timeout));
    if (reply.protocol !== MAGIC || reply.ok !== true || reply.session !== session) throw new Error('Invalid bridge handshake');
    // hc probe ends stdin immediately after hello. Half-close it and keep
    // draining stdout, rather than killing the response in flight.
    socket.on('error', error => { log(error.message); process.exitCode = 1; stop(); });
    socket.once('end', stop);
    socket.once('close', stop);
    process.stdin.on('error', stop);
    process.stdin.pipe(socket); socket.pipe(process.stdout, { end: false }); socket.resume();
  } catch (error) { stop(); throw error; }
}

async function add(args) {
  if (args._.length || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(args.name ?? '')) throw new Error('add requires --name NAME');
  const hc = executable(args.hc ?? 'hc'), session = sessionName(args.session);
  // hc 0.1.17 runs --via through sh even on Windows. Use Git Bash paths
  // understood by sh; the remote Windows server does not need sh for this bridge.
  if (process.platform === 'win32') executable('sh');
  const pathForShell = value => process.platform === 'win32' ? value.replaceAll('\\', '/') : value;
  const argv = [pathForShell(realpathSync(process.execPath)), pathForShell(SELF), 'connect', '--session', session];
  if (args['local-port']) argv.push('--local-port', String(number(args['local-port'], 0, 65535)));
  else argv.push('--tunnel', tunnelName(args.tunnel), '--port', String(number(args.port, 43821, 65535)), '--devtunnel', pathForShell(executable(args.devtunnel ?? 'devtunnel')));
  if (args.timeout) argv.push('--timeout', String(number(args.timeout, 45, 600)));
  const via = argv.map(shellQuote).join(' ');
  const command = ['machine', 'add', '--name', args.name, '--session', session, '--via', via];
  log(`Adding ${args.name} through private tunnel transport (not SSH).`);
  const child = spawn(hc, command, { stdio: 'inherit', windowsHide: true });
  child.once('error', e => { log(e.message); process.exitCode = 1; });
  const [code] = await once(child, 'exit');
  process.exitCode = code ?? 1;
}

export async function doctor(args = {}) {
  const role = args.role ?? 'both';
  if (!['client', 'server', 'both'].includes(role)) throw new Error('role must be client, server or both');
  const checks = [{ name: 'node', ok: Number(process.versions.node.split('.')[0]) >= 22, detail: process.version }];
  const check = async (name, fn) => {
    try { checks.push({ name, ok: true, detail: await fn() }); }
    catch (error) { checks.push({ name, ok: false, detail: error.message }); }
  };
  let hc, dt;
  await check('hc', async () => {
    hc = executable(args.hc ?? 'hc');
    const version = (await runCommand(hc, ['--version'])).trim();
    const help = await runCommand(hc, role === 'server' ? ['connect', '--help'] : ['machine', 'add', '--help']);
    if (!help.includes(role === 'server' ? '--session' : '--via')) throw new Error('hc is missing the required connection capability');
    if (role === 'both' && !(await runCommand(hc, ['connect', '--help'])).includes('--session')) throw new Error('hc connect lacks --session');
    return `${version}; ${hc}`;
  });
  await check('devtunnel', async () => {
    dt = executable(args.devtunnel ?? 'devtunnel');
    return `${(await runCommand(dt, ['--version'])).split(/\r?\n/)[0]}; ${dt}`;
  });
  await check('devtunnel-login', async () => {
    if (!dt) throw new Error('Install devtunnel first');
    const result = (await runCommand(dt, ['user', 'show'])).trim();
    if (!/logged in as /i.test(result)) throw new Error('Complete devtunnel user login interactively, then retry');
    return result;
  });
  if (process.platform === 'win32' && role !== 'server') await check('sh (Windows client)', async () => executable('sh'));
  const result = { version: VERSION, platform: process.platform, role, ok: checks.every(c => c.ok), checks };
  if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else for (const c of checks) process.stdout.write(`${c.ok ? 'OK' : 'FAIL'} ${c.name}: ${c.detail}\n`);
  if (!result.ok) process.exitCode = 1;
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  if (!command || command === '--help' || command === 'help' || args.help) { process.stdout.write(HELP); return; }
  if (command === '--version' || command === 'version') { process.stdout.write(`herdr-devtunnel ${VERSION}\n`); return; }
  if (command === 'doctor') return doctor(args);
  if (command === 'serve') return serve(args);
  if (command === 'connect') return connect(args);
  if (command === 'add') return add(args);
  if (command === '_tunnel') return tunnelChild(args);
  throw new Error(`Unknown command: ${command}`);
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(SELF)) {
  main().catch(error => { log(error.message); process.exitCode = 1; });
}
