#!/usr/bin/env node
// User-local installer. No network downloads, dependency installation or login.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, unlinkSync, chmodSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const SOURCE = dirname(fileURLToPath(import.meta.url));
const APP = 'herdr-devtunnel';
const MARKER = '.herdr-devtunnel-install.json';
const FILES = ['herdr-devtunnel.mjs', 'install.mjs', 'package.json', 'README.md', 'README.zh-CN.md', 'SERVER-SETUP.md', 'AGENTS.md', 'SECURITY.md', 'LICENSE', 'docs/AGENT-INSTALL.md'];
const HELP = `Install the same client/server package under the current user (Node >=22).

  node install.mjs --role client|server|both [--check]

Options:
  --dir PATH       Installation directory
  --bin-dir PATH   Launcher directory (must be on PATH, or use absolute launcher)
  --check          Run dependency/login doctor after installation
  --adopt          Explicitly adopt a recognized manually installed PoC directory
  --dry-run        Print planned locations without writing anything
  --json           Machine-readable result (includes doctor with --check)

No sudo/admin, dependency downloads, PATH edits, login, tunnel creation, machine
registration, process restart, autostart or credential storage. Re-running updates
owned installation files only; it preserves logs and other user files.
`;

export function installPaths({ platform = process.platform, home = homedir(), env = process.env, dir, binDir } = {}) {
  const root = resolve(dir ?? (platform === 'win32' ? join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), APP) : join(env.XDG_DATA_HOME || join(home, '.local', 'share'), APP)));
  return { root, bin: resolve(binDir ?? (platform === 'win32' ? join(root, 'bin') : join(home, '.local', 'bin'))) };
}
function quoteSh(value) { return `'${value.replaceAll("'", "'\\''")}'`; }
export function launcherText(platform, node, script) {
  if ([node, script].some(s => /[\r\n\0]/.test(s))) throw new Error('Unsupported launcher path');
  if (platform === 'win32') {
    if ([node, script].some(s => s.includes('"'))) throw new Error('Unsupported quote in Windows path');
    const quote = value => `"${value.replaceAll('%', '%%')}"`;
    return `@echo off\r\nrem Managed by herdr-devtunnel installer.\r\nsetlocal DisableDelayedExpansion\r\n${quote(node)} ${quote(script)} %*\r\nexit /b %errorlevel%\r\n`;
  }
  return `#!/bin/sh\n# Managed by herdr-devtunnel installer.\nexec ${quoteSh(node)} ${quoteSh(script)} "$@"\n`;
}
function argsOf(argv) {
  const args = { role: 'both' };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (['--check', '--adopt', '--dry-run', '--json', '--help'].includes(key)) args[key.slice(2)] = true;
    else if (['--role', '--dir', '--bin-dir'].includes(key) && argv[i + 1] && !argv[i + 1].startsWith('--')) args[key.slice(2)] = argv[++i];
    else throw new Error(`Unknown option or missing value: ${key}`);
  }
  if (!['client', 'server', 'both'].includes(args.role)) throw new Error('role must be client, server or both');
  return args;
}
function readJson(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }
function atomicWrite(path, contents, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.install-${process.pid}`;
  try { writeFileSync(temp, contents, { flag: 'wx', mode }); renameSync(temp, path); chmodSync(path, mode); }
  finally { if (existsSync(temp)) unlinkSync(temp); }
}

export function install(argv = process.argv.slice(2)) {
  const args = argsOf(argv);
  if (args.help) { process.stdout.write(HELP); return; }
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js >=22 is required');
  const { root, bin } = installPaths({ dir: args.dir, binDir: args['bin-dir'] });
  if (root === SOURCE || (existsSync(root) && realpathSync(root) === realpathSync(SOURCE))) throw new Error('Install into a separate directory, not the source checkout');
  const launcher = join(bin, process.platform === 'win32' ? `${APP}.cmd` : APP);
  const node = realpathSync(process.execPath);
  const pkg = readJson(join(SOURCE, 'package.json'));
  if (pkg?.name !== APP) throw new Error('Invalid source package');
  const marker = readJson(join(root, MARKER));
  if (existsSync(root) && readdirSync(root).length && marker?.app !== APP) {
    const old = readJson(join(root, 'package.json'));
    if (!args.adopt || ![APP, 'herdr-devtunnel-poc'].includes(old?.name)) {
      throw new Error(`Refusing to overwrite unowned directory: ${root}. For a recognized manual PoC install, review it and use --adopt.`);
    }
  }
  if (existsSync(launcher)) {
    const old = readFileSync(launcher, 'utf8');
    const managed = old.includes('Managed by herdr-devtunnel installer.');
    const legacy = args.adopt && old.includes('# herdr-devtunnel PoC client;');
    if (!managed && !legacy) throw new Error(`Refusing to overwrite an unrelated launcher: ${launcher}`);
  }
  // Read every asset before changing the installation.
  const assets = FILES.map(name => ({ name, bytes: readFileSync(join(SOURCE, name)) }));
  const result = { app: APP, version: pkg.version, role: args.role, root, launcher, node, dryRun: !!args['dry-run'] };
  if (!args['dry-run']) {
    mkdirSync(root, { recursive: true }); mkdirSync(bin, { recursive: true });
    const hashes = {};
    for (const { name, bytes } of assets) {
      atomicWrite(join(root, name), bytes);
      hashes[name] = createHash('sha256').update(bytes).digest('hex');
    }
    atomicWrite(launcher, launcherText(process.platform, node, join(root, 'herdr-devtunnel.mjs')), 0o755);
    atomicWrite(join(root, MARKER), JSON.stringify({ ...result, installedAt: new Date().toISOString(), hashes }, null, 2) + '\n');
    if (args.check) {
      const checked = spawnSync(node, [join(root, 'herdr-devtunnel.mjs'), 'doctor', '--role', args.role, '--json'], { encoding: 'utf8', timeout: 180000, windowsHide: true });
      try { result.doctor = JSON.parse(checked.stdout); }
      catch { result.doctor = { ok: false, error: checked.error?.message ?? checked.stderr ?? 'doctor failed' }; }
      if (checked.status !== 0 || !result.doctor.ok) process.exitCode = 1;
    }
  }
  if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else {
    process.stdout.write(`${args['dry-run'] ? 'Would install' : 'Installed'} ${APP} ${pkg.version} (${args.role})\nDirectory: ${root}\nLauncher: ${launcher}\n`);
    process.stdout.write(`If needed, add this directory to your user PATH: ${bin}\n`);
    if (result.doctor) process.stdout.write(JSON.stringify(result.doctor, null, 2) + '\n');
    if (result.doctor && !result.doctor.ok) process.stdout.write('Files installed, but preflight failed. Fix the reported prerequisites before connecting.\n');
    process.stdout.write('Next: read docs/AGENT-INSTALL.md. No tunnel, machine or service was created.\n');
  }
  return result;
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  try { install(); } catch (error) { console.error(`[installer] ${error.message}`); process.exitCode = 1; }
}
