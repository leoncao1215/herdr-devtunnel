import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { buildConfig, validateConfig, quoteWindows, atomicJson, rotatingLogger, runInstance, summarize, taskRequest, stopManaged } from '../autostart.mjs';

const ROOT = dirname(fileURLToPath(new URL('../autostart.mjs', import.meta.url)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(t, name = 'test-profile', sid = 'S-1-5-21-1-2-3-1001') {
  const dir = mkdtempSync(join(tmpdir(), 'hdt-auto-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = buildConfig({ name, sid, tunnel: 'example.use2', root: ROOT, configPath: join(dir, 'config.json'),
    node: process.execPath, hc: process.execPath, devtunnel: process.execPath });
  return { dir, config, status: join(dir, 'status.json'), request: join(dir, 'stop-request.json') };
}
async function waitFor(fn) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (fn()) return; await delay(20); }
  throw new Error('test timed out');
}
function state(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }

test('task config pins current user, fixed runner and safely quoted paths', t => {
  const { config } = fixture(t);
  assert.equal(validateConfig(config), config);
  assert.ok(config.taskName.includes(config.sid));
  assert.ok(config.actionArguments.includes('_run --config'));
  assert.ok(!config.actionArguments.includes('--create'));
  assert.throws(() => buildConfig({ ...config, name: '../other-task' }));
  assert.throws(() => buildConfig({ ...config, sid: 'SYSTEM' }));
  assert.throws(() => buildConfig({ ...config, port: 0 }));
  assert.throws(() => validateConfig({ ...config, taskName: 'somebody-elses-task' }));
  assert.throws(() => validateConfig({ ...config, runner: join(config.root, 'evil.mjs') }));
  assert.throws(() => quoteWindows('path" injected'));
  assert.equal(quoteWindows('path with spaces & unicode'), '"path with spaces & unicode"');
});
test('task status does not treat stale heartbeat or stopped scheduler as ready', t => {
  const { config } = fixture(t), now = Date.now();
  const runtime = { phase: 'ready', updatedAt: new Date(now).toISOString() };
  assert.equal(summarize(config, { exists: true, state: 'Running' }, runtime, now).ready, true);
  assert.equal(summarize(config, { exists: true, state: 'Ready' }, runtime, now).ready, false);
  assert.equal(summarize(config, { exists: true, state: 'Running' }, runtime, now + 30000).ready, false);
  assert.equal(summarize(config, { exists: false }, null, now).ready, false);
});
test('runner ignores stale stop requests and gracefully stops its own bridge', { timeout: 8000 }, async t => {
  const { config, status, request, dir } = fixture(t);
  atomicJson(request, { operation: 'stop', runId: 'old-instance' });
  let stopCount = 0, finish;
  const done = new Promise(resolve => { finish = resolve; });
  t.after(() => finish(0));
  const result = runInstance(config, async (args, hooks) => {
    assert.equal(args.create, undefined); assert.equal(args.session, 'default');
    assert.equal(args.hc, config.hc); hooks.onReady();
    return { done, stop: () => { stopCount++; finish(0); return done; } };
  }, { pollMs: 20 });
  await waitFor(() => state(status)?.phase === 'ready');
  await delay(80); assert.equal(stopCount, 0);
  atomicJson(request, { operation: 'stop', runId: state(status).runId });
  assert.equal(await result, 0); assert.ok(stopCount > 0);
  assert.equal(state(status).phase, 'stopped');
  assert.match(readFileSync(join(dir, 'server.log'), 'utf8'), /core\/agent processes are not stopped/);
});
test('stop handles a Disabled task whose action is still alive', { timeout: 8000 }, async t => {
  const { config, status } = fixture(t);
  let finish, disabled = false, didStop = false;
  const done = new Promise(resolve => { finish = resolve; });
  t.after(() => finish(0));
  const running = runInstance(config, async (_args, hooks) => {
    hooks.onReady();
    return { done, stop: () => { didStop = true; finish(0); return done; } };
  }, { pollMs: 20 });
  await waitFor(() => state(status)?.phase === 'ready');
  await stopManaged(config, 4000, {
    inspectState: () => ({ task: { exists: true, state: disabled ? 'Disabled' : 'Running' }, runtime: state(status) }),
    requestTask: operation => { assert.equal(operation, 'disable'); disabled = true; },
    pause: () => delay(30),
  });
  assert.equal(disabled, true); assert.equal(didStop, true); assert.equal(await running, 0);
});
test('runner failures return nonzero for bounded scheduler retries', async t => {
  const { config, status } = fixture(t);
  const code = await runInstance(config, async () => { throw new Error('port occupied'); }, { pollMs: 20 });
  assert.equal(code, 1); assert.equal(state(status).phase, 'failed');
  assert.equal(state(status).error, 'port occupied');
});
test('logs rotate with bounded backup count', t => {
  const { dir } = fixture(t), write = rotatingLogger(join(dir, 'server.log'), 100, 3);
  for (let i = 0; i < 20; i++) write(`line-${i} ${'x'.repeat(80)}`);
  assert.deepEqual(readdirSync(dir).sort(), ['server.log', 'server.log.1', 'server.log.2', 'server.log.3']);
  assert.match(readFileSync(join(dir, 'server.log'), 'utf8'), /line-19/);
});
test('autostart help is available on every OS and unsupported OS fails clearly', () => {
  const cli = join(ROOT, 'herdr-devtunnel.mjs');
  const help = spawnSync(process.execPath, [cli, 'autostart', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /DISABLES/);
  if (process.platform !== 'win32') {
    const result = spawnSync(process.execPath, [cli, 'autostart', 'install', '--name', 'example', '--tunnel', 'example.use2'], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, /Windows-only/);
  }
});

test('Windows PowerShell adapter parses without executing tasks', { skip: process.platform !== 'win32' }, () => {
  const path = join(ROOT, 'scripts', 'windows-task.ps1').replaceAll("'", "''");
  const ps = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = `$errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${path}',[ref]$null,[ref]$errors); if($errors.Count){$errors|ForEach-Object{Write-Error $_};exit 1}`;
  const result = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
});

test('opt-in Windows task registration is Limited/Interactive and never starts a process', {
  skip: process.platform !== 'win32' || process.env.HERDR_TEST_WINDOWS_TASKS !== '1', timeout: 120000,
}, t => {
  const { sid } = taskRequest('identity');
  const { config } = fixture(t, `ci-${randomBytes(6).toString('hex')}`, sid);
  // Native CI creates ONLY a unique disabled scratch task, then removes it.
  // No network access, core, agent, login or working tasks are involved.
  const registered = taskRequest('install', config);
  t.after(() => taskRequest('uninstall', config));
  assert.equal(registered.exists, true); assert.equal(registered.enabled, false);
  assert.equal(registered.logonType, 'Interactive'); assert.equal(registered.runLevel, 'Limited');
  assert.equal(registered.executionTimeLimit, 'PT0S'); assert.equal(registered.restartCount, 3);
  assert.equal(registered.restartInterval, 'PT1M'); assert.equal(registered.multipleInstances, 'IgnoreNew');
  assert.equal(taskRequest('inspect', config).exists, true);
  assert.throws(() => taskRequest('install', config), /without a matching saved configuration/);
  assert.throws(() => taskRequest('inspect', { ...config, actionArguments: 'wrong runner' }), /does not match/);
  const updated = taskRequest('install', config, config);
  assert.equal(updated.enabled, false);
});
