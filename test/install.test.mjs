import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { installPaths, launcherText } from '../install.mjs';

const installer = fileURLToPath(new URL('../install.mjs', import.meta.url));
const source = fileURLToPath(new URL('../herdr-devtunnel.mjs', import.meta.url));
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
function scratch(t) {
  const base = mkdtempSync(join(tmpdir(), 'hdt-install-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, root: join(base, "runtime with 'quote'"), bin: join(base, 'bin with spaces') };
}
function run(paths, args = [], env = process.env) {
  return spawnSync(process.execPath, [installer, '--dir', paths.root, '--bin-dir', paths.bin, '--json', ...args], { encoding: 'utf8', env, timeout: 20000 });
}

test('installer selects user-local paths for each platform', t => {
  const { base } = scratch(t);
  assert.equal(installPaths({ platform: 'linux', home: base, env: {} }).root, resolve(base, '.local', 'share', 'herdr-devtunnel'));
  assert.equal(installPaths({ platform: 'darwin', home: base, env: { XDG_DATA_HOME: join(base, 'data') } }).root, resolve(base, 'data', 'herdr-devtunnel'));
  const paths = installPaths({ platform: 'win32', home: base, env: { LOCALAPPDATA: join(base, 'local') } });
  assert.equal(paths.root, resolve(base, 'local', 'herdr-devtunnel'));
  assert.equal(paths.bin, join(paths.root, 'bin'));
});
test('launchers quote paths and preserve caller arguments', () => {
  const unix = launcherText('linux', "/path with 'quote'/node", '/app/bridge.mjs');
  assert.ok(unix.includes("'\\''")); assert.ok(unix.includes('"$@"'));
  const win = launcherText('win32', 'C:\\Program Files\\Node\\node.exe', 'C:\\Users\\a%b!\\app.mjs');
  assert.ok(win.includes('DisableDelayedExpansion'));
  assert.ok(win.includes('a%%b!'));
  assert.ok(win.includes(' %*\r\n'));
  assert.throws(() => launcherText('linux', '/node\nmalicious', '/app'));
});
test('fresh install works outside checkout; repeated install preserves user data', t => {
  const paths = scratch(t);
  let result = run(paths, ['--role', 'client']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.role, 'client'); assert.equal(report.version, version);
  assert.deepEqual(readFileSync(join(paths.root, 'herdr-devtunnel.mjs')), readFileSync(source));
  assert.ok(existsSync(join(paths.root, 'docs', 'AGENT-INSTALL.md')));
  assert.ok(existsSync(join(paths.root, 'autostart.mjs')));
  assert.ok(existsSync(join(paths.root, 'scripts', 'windows-task.ps1')));
  assert.ok(existsSync(join(paths.root, 'docs', 'WINDOWS-AUTOSTART.md')));
  let cli = spawnSync(process.execPath, [join(paths.root, 'herdr-devtunnel.mjs'), '--version'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(cli.stdout.trim(), `herdr-devtunnel ${version}`);
  if (process.platform !== 'win32') {
    cli = spawnSync(report.launcher, ['--version'], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr); assert.equal(cli.stdout.trim(), `herdr-devtunnel ${version}`);
  }
  writeFileSync(join(paths.root, 'operator-notes.txt'), 'keep me');
  result = run(paths, ['--role', 'server']); assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(paths.root, 'operator-notes.txt'), 'utf8'), 'keep me');
  assert.equal(JSON.parse(readFileSync(join(paths.root, '.herdr-devtunnel-install.json'))).role, 'server');
});
test('dry run does not create an installation', t => {
  const paths = scratch(t), result = run(paths, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).dryRun, true);
  assert.equal(existsSync(paths.root), false); assert.equal(existsSync(paths.bin), false);
});
test('installer refuses unowned directories and unrelated launchers', t => {
  const paths = scratch(t); mkdirSync(paths.root); writeFileSync(join(paths.root, 'important'), 'untouched');
  let result = run(paths); assert.notEqual(result.status, 0); assert.match(result.stderr, /unowned directory/);
  assert.equal(readFileSync(join(paths.root, 'important'), 'utf8'), 'untouched');
  rmSync(paths.root, { recursive: true }); mkdirSync(paths.bin);
  const launcher = join(paths.bin, process.platform === 'win32' ? 'herdr-devtunnel.cmd' : 'herdr-devtunnel');
  writeFileSync(launcher, 'unrelated command');
  result = run(paths); assert.notEqual(result.status, 0); assert.match(result.stderr, /unrelated launcher/);
  assert.equal(existsSync(paths.root), false);
});
test('manual PoC adoption must be explicit and recognized', t => {
  const paths = scratch(t); mkdirSync(paths.root);
  writeFileSync(join(paths.root, 'package.json'), JSON.stringify({ name: 'herdr-devtunnel-poc', version: '0.1.0' }));
  writeFileSync(join(paths.root, 'server.stderr.log'), 'existing log');
  assert.notEqual(run(paths).status, 0);
  const result = run(paths, ['--adopt']); assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(paths.root, 'server.stderr.log'), 'utf8'), 'existing log');
});
test('check reports missing dependencies after successful file installation', t => {
  const paths = scratch(t);
  const result = run(paths, ['--check', '--role', 'server'], { ...process.env, PATH: '', Path: '' });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout); assert.equal(report.doctor.ok, false);
  assert.ok(report.doctor.checks.some(c => c.name === 'hc' && !c.ok));
  assert.ok(existsSync(join(paths.root, 'herdr-devtunnel.mjs')));
});
