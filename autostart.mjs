#!/usr/bin/env node
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync, unlinkSync, statSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { executable, serve } from './herdr-devtunnel.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const APP = 'herdr-devtunnel';
const ACTIVE = new Set(['starting', 'ready', 'stopping']);
const HELP = `Windows login task management (explicit opt-in, current user, Limited/Interactive).

  herdr-devtunnel autostart install --name NAME --tunnel ID.CLUSTER [--start]
  herdr-devtunnel autostart start|stop|restart|status|logs|uninstall --name NAME

install: registers/enables a login task; does NOT start it now unless --start.
start: enables login autostart and starts the bridge (never creates a tunnel).
stop: DISABLES login autostart/retries and gracefully stops only this bridge.
restart: stop, then enable/start. uninstall: stop and unregister; keep config/logs.

Install options: --port 43821 --session default --hc PATH --devtunnel PATH
Other options: --timeout 90 (seconds), --json; logs: --lines 80

Requires the user-local installer first. No SYSTEM, stored password, elevation,
ExecutionPolicy changes, forced core/agent stop, or automatic legacy-process takeover.
Login is required after reboot. macOS/Linux autostart is not implemented yet.
`;

export function atomicJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temp, path); }
  finally { if (existsSync(temp)) unlinkSync(temp); }
}
function readJson(path, optional = false) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}
function nameOf(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(name ?? '')) throw new Error('--name must contain 1-32 letters/digits/_/- and start with a letter/digit');
  return name;
}
function integer(value, fallback, max) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`Invalid number: ${value}`);
  return n;
}
export function quoteWindows(value) {
  if (/["\r\n\0]/.test(value) || value.endsWith('\\')) throw new Error('Unsupported task action path');
  return `"${value}"`;
}
export function buildConfig({ name, sid, tunnel, port = 43821, session = 'default', root, configPath, node, hc, devtunnel }) {
  nameOf(name);
  if (!/^S-1-\d+(?:-\d+)+$/.test(sid)) throw new Error('Invalid Windows user SID');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{1,150}$/.test(tunnel ?? '')) throw new Error('An existing dedicated tunnel is required; --create is not supported here');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(session)) throw new Error('Invalid session');
  for (const path of [root, configPath, node, hc, devtunnel]) if (!isAbsolute(path ?? '')) throw new Error('Autostart requires absolute executable/config paths');
  const runner = join(root, 'autostart.mjs');
  return {
    app: APP, schema: 1, name, sid, tunnel, port: integer(port, 43821, 65535), session,
    root, configPath, node, hc, devtunnel, runner, cli: join(root, 'herdr-devtunnel.mjs'),
    taskName: `HerdrDevTunnel-${sid}-${name}`, marker: `${APP}/autostart/v1:${sid}:${name}`,
    actionArguments: `${quoteWindows(runner)} _run --config ${quoteWindows(configPath)}`,
  };
}
export function validateConfig(config) {
  const expected = buildConfig(config);
  for (const key of Object.keys(expected)) if (expected[key] !== config[key]) throw new Error(`Invalid saved task configuration: ${key}`);
  return config;
}
function configLocation(name) {
  if (!process.env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is missing');
  return join(process.env.LOCALAPPDATA, APP, 'autostart', nameOf(name), 'config.json');
}
function runtimePath(c) { return join(dirname(c.configPath), 'status.json'); }
function controlPath(c) { return join(dirname(c.configPath), 'stop-request.json'); }
function logPath(c) { return join(dirname(c.configPath), 'server.log'); }

export function taskRequest(operation, config = null, previous = null) {
  if (process.platform !== 'win32') throw new Error('Windows Task Scheduler is only available on Windows');
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const scratch = mkdtempSync(join(tmpdir(), 'hdt-task-'));
  try {
    const payload = join(scratch, 'request.json');
    writeFileSync(payload, JSON.stringify({ config, previous }), { mode: 0o600 });
    const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(ROOT, 'scripts', 'windows-task.ps1'), '-Operation', operation, '-Payload', payload], {
      encoding: 'utf8', windowsHide: true, timeout: 30000,
    });
    if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr.trim() ?? 'Task Scheduler failed');
    return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

export function rotatingLogger(path, maxBytes = 5 * 1024 * 1024, backups = 3) {
  mkdirSync(dirname(path), { recursive: true });
  return message => {
    const line = `${new Date().toISOString()} ${String(message).slice(0, 65536)}\n`;
    if (existsSync(path) && statSync(path).size + Buffer.byteLength(line) > maxBytes) {
      if (existsSync(`${path}.${backups}`)) unlinkSync(`${path}.${backups}`);
      for (let i = backups - 1; i >= 1; i--) if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
      renameSync(path, `${path}.1`);
    }
    appendFileSync(path, line, { mode: 0o600 });
  };
}

// The task action runs this function in its foreground Node process. We do not
// use Start-Process, store user credentials, or terminate an hc process tree.
export async function runInstance(config, startBridge = serve, { pollMs = 500 } = {}) {
  validateConfig(config);
  const logger = rotatingLogger(logPath(config));
  const state = { runId: randomUUID(), pid: process.pid, phase: 'starting', startedAt: new Date().toISOString(), updatedAt: '', lastReadyAt: null, error: null };
  let handle, stopping = false, fault = null;
  const publish = () => { state.updatedAt = new Date().toISOString(); atomicJson(runtimePath(config), state); };
  const requestStop = () => {
    if (!stopping) { stopping = true; state.phase = 'stopping'; publish(); logger('Graceful stop requested; core/agent processes are not stopped.'); }
    if (handle) void handle.stop();
  };
  logger(`Starting profile ${config.name}; tunnel=${config.tunnel}; port=${config.port}; session=${config.session}`);
  publish();
  let lastHeartbeat = Date.now();
  const timer = setInterval(() => {
    try {
      const request = readJson(controlPath(config), true);
      if (request?.operation === 'stop' && request.runId === state.runId) requestStop();
      if (Date.now() - lastHeartbeat >= 5000) { publish(); lastHeartbeat = Date.now(); }
    } catch (error) {
      fault = error;
      try { requestStop(); } catch { if (handle) void handle.stop(); }
    }
  }, pollMs);
  try {
    handle = await startBridge({ _: [], tunnel: config.tunnel, port: config.port, session: config.session, hc: config.hc, devtunnel: config.devtunnel }, {
      logger,
      onReady: () => { if (!stopping) { state.phase = 'ready'; state.lastReadyAt = new Date().toISOString(); publish(); } },
    });
    if (stopping) await handle.stop();
    const code = await handle.done;
    if (fault) throw fault;
    state.phase = code === 0 ? 'stopped' : 'failed';
    state.error = code === 0 ? null : `Bridge exited with code ${code}`;
    logger(state.error ?? 'Bridge stopped cleanly.');
    publish();
    return code;
  } catch (error) {
    if (handle) await handle.stop();
    state.phase = 'failed'; state.error = error.message;
    logger(`FAILED: ${error.message}`); publish();
    return 1;
  } finally { clearInterval(timer); }
}

export function summarize(config, task, runtime, now = Date.now()) {
  const fresh = !!runtime && now - Date.parse(runtime.updatedAt) >= 0 && now - Date.parse(runtime.updatedAt) < 20000;
  const active = task.exists && task.state === 'Running' && fresh && ACTIVE.has(runtime?.phase);
  return { name: config.name, tunnel: config.tunnel, port: config.port, session: config.session, task, runtime,
    active: !!active, ready: !!active && runtime.phase === 'ready',
    log: logPath(config), config: config.configPath };
}
function inspect(config) { return summarize(config, taskRequest('inspect', config), readJson(runtimePath(config), true)); }
function runtimeProcessActive(runtime) {
  if (!ACTIVE.has(runtime?.phase) || !Number.isInteger(runtime.pid) || runtime.pid < 1) return false;
  try { process.kill(runtime.pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function portAvailable(port) {
  await new Promise((resolvePromise, reject) => {
    const listener = net.createServer();
    listener.once('error', () => reject(new Error(`Port ${port} is already occupied. Verify and stop the old bridge yourself; no existing process was killed.`)));
    listener.listen(port, '127.0.0.1', () => listener.close(resolvePromise));
  });
}
async function start(config, timeout) {
  const before = inspect(config);
  if (!before.task.exists) throw new Error('Task is not installed');
  if (before.ready) { taskRequest('enable', config); return inspect(config); }
  const needsNewRun = !['Running', 'Queued'].includes(before.task.state) && !runtimeProcessActive(before.runtime);
  if (needsNewRun) {
    await portAvailable(config.port);
    taskRequest('enable', config); taskRequest('start', config);
  } else taskRequest('enable', config);
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const status = inspect(config);
    if (status.ready && (!needsNewRun || status.runtime?.runId !== before.runtime?.runId)) return status;
    if (status.runtime?.runId !== before.runtime?.runId && status.runtime?.phase === 'failed') throw new Error(`Task failed: ${status.runtime.error}. See ${status.log}`);
    await delay(1000);
  }
  throw new Error(`Task requested but readiness was not confirmed. Inspect autostart status/logs; task remains enabled. Log: ${logPath(config)}`);
}
export async function stopManaged(config, timeout, { inspectState = inspect, requestTask = taskRequest, pause = delay } = {}) {
  let status = inspectState(config);
  if (status.task.exists) requestTask('disable', config); // Prevent login/restart races during maintenance.
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    status = inspectState(config);
    // A disabled task can still have a running action. Do not equate Disabled
    // with stopped. Never kill a PID: only send an instance-scoped stop request.
    if (!['Running', 'Queued'].includes(status.task.state) && !runtimeProcessActive(status.runtime)) return status;
    if (status.runtime?.runId) atomicJson(controlPath(config), { operation: 'stop', runId: status.runtime.runId });
    await pause(500);
  }
  throw new Error('Task is disabled but did not stop gracefully. Inspect logs; no process was force-killed. Do not stop hc or its agents.');
}
function parse(argv) {
  const [operation, ...rest] = argv, args = { operation };
  const flags = new Set(['help', 'json', 'start']);
  const values = new Set(['name', 'tunnel', 'port', 'session', 'hc', 'devtunnel', 'timeout', 'lines', 'config']);
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i].startsWith('--') ? rest[i].slice(2) : '';
    if (flags.has(key)) args[key] = true;
    else if (values.has(key) && rest[i + 1] && !rest[i + 1].startsWith('--')) args[key] = rest[++i];
    else throw new Error(`Unknown option or missing value: ${rest[i]}`);
  }
  return args;
}
function preflight(config) {
  const result = spawnSync(config.node, [config.cli, 'doctor', '--role', 'server', '--hc', config.hc, '--devtunnel', config.devtunnel, '--json'], { encoding: 'utf8', timeout: 180000, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`Preflight failed before task registration:\n${result.error?.message ?? result.stdout ?? result.stderr}`);
}
export async function autostart(argv) {
  const args = parse(argv);
  if (!args.operation || args.operation === '--help' || args.operation === 'help' || args.help) { process.stdout.write(HELP); return; }
  if (process.platform !== 'win32') throw new Error('Autostart is currently Windows-only; manual serve still works on macOS/Linux');
  if (args.operation === '_run') {
    const config = validateConfig(readJson(resolve(args.config ?? '')));
    if (realpathSync(config.runner) !== realpathSync(fileURLToPath(import.meta.url))) throw new Error('Task runner path does not match installation');
    process.exitCode = await runInstance(config); return;
  }
  if (!['install', 'start', 'stop', 'restart', 'status', 'logs', 'uninstall'].includes(args.operation)) throw new Error('Unknown autostart operation');
  const allowed = args.operation === 'install' ? ['operation', 'name', 'tunnel', 'port', 'session', 'hc', 'devtunnel', 'start', 'timeout', 'json'] :
    args.operation === 'logs' ? ['operation', 'name', 'lines', 'json'] : ['operation', 'name', 'timeout', 'json'];
  for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new Error(`--${key} is not valid for ${args.operation}`);
  const location = configLocation(nameOf(args.name));
  const timeout = integer(args.timeout, 90, 600) * 1000;
  let config = readJson(location, true), result;
  if (config) validateConfig(config);
  if (args.operation === 'install') {
    const installed = readJson(join(ROOT, '.herdr-devtunnel-install.json'), true);
    if (installed?.app !== APP) throw new Error('Run node install.mjs first, then use the installed launcher to register autostart (not a checkout)');
    const { sid } = taskRequest('identity');
    const desired = buildConfig({ name: args.name, sid, tunnel: args.tunnel, port: integer(args.port, 43821, 65535), session: args.session ?? 'default',
      root: ROOT, configPath: location, node: realpathSync(process.execPath), hc: executable(args.hc ?? 'hc'), devtunnel: executable(args.devtunnel ?? 'devtunnel') });
    preflight(desired);
    taskRequest('install', desired, config); // Disabled until config has been published.
    atomicJson(location, desired); config = desired;
    taskRequest('enable', config);
    result = args.start ? await start(config, timeout) : inspect(config);
  } else {
    if (!config) throw new Error(`No saved autostart profile ${args.name}; run autostart install first`);
    if (args.operation === 'status') result = inspect(config);
    if (args.operation === 'start') result = await start(config, timeout);
    if (args.operation === 'stop') result = await stopManaged(config, timeout);
    if (args.operation === 'restart') { await stopManaged(config, timeout); result = await start(config, timeout); }
    if (args.operation === 'uninstall') {
      const stopped = await stopManaged(config, timeout);
      if (stopped.task.exists) taskRequest('uninstall', config);
      result = { ...inspect(config), note: 'Task removed. Logs/config retained. No core, agent or tunnel was deleted.' };
    }
    if (args.operation === 'logs') {
      const count = integer(args.lines, 80, 2000);
      const text = existsSync(logPath(config)) ? readFileSync(logPath(config), 'utf8').split(/\r?\n/).slice(-count - 1).join('\n') : '(no log yet)';
      result = { name: config.name, log: logPath(config), text };
      if (!args.json) { process.stdout.write(text + '\n'); return result; }
    }
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result;
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  autostart(process.argv.slice(2)).catch(error => { console.error(`[autostart] ${error.message}`); process.exitCode = 1; });
}
