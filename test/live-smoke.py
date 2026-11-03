#!/usr/bin/env python3
"""Opt-in live test: creates ONE private 1h tunnel, uses scratch hc sessions,
then deletes only that tunnel and scratch cores. Requires logged-in devtunnel.
Run: python3 test/live-smoke.py
"""
import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which('node')
HC = shutil.which('hc')
DT = shutil.which('devtunnel')
SCRIPT = str(ROOT / 'herdr-devtunnel.mjs')
assert NODE and HC and DT, 'node, hc and devtunnel must be installed'
# macOS Unix socket paths have a very small limit; /var/folders is too long.
scratch = tempfile.mkdtemp(prefix='hdt-', dir='/tmp')
env = os.environ.copy()
for var, sub in [('XDG_CONFIG_HOME', 'c'), ('XDG_DATA_HOME', 'd'), ('XDG_STATE_HOME', 's'), ('XDG_RUNTIME_DIR', 'r')]:
    env[var] = os.path.join(scratch, sub)
    os.makedirs(env[var], mode=0o700)
env['HC_SESSION'] = 'client'
tunnel = 'herdr-smoke-' + uuid.uuid4().hex[:8]
created = False
server = None


def run(cmd, timeout=60, target_env=None):
    result = subprocess.run(cmd, env=target_env or env, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'{cmd[:4]} exited {result.returncode}\n{result.stdout}\n{result.stderr}')
    return result.stdout


def wait_connected():
    deadline = time.time() + 60
    while time.time() < deadline:
        data = json.loads(run([HC, 'machine', 'ls', '--json']))
        if data['machines'] and data['machines'][0]['state'] == 'connected':
            return
        time.sleep(1)
    raise RuntimeError('remote core did not reconnect')


def start_server(port):
    ready = threading.Event()
    p = subprocess.Popen([NODE, SCRIPT, 'serve', '--tunnel', tunnel, '--port', str(port), '--session', 'remote', '--hc', HC],
                         env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    def output():
        for line in p.stderr:
            print('SERVER', line.rstrip(), flush=True)
            if 'Ready to accept connections' in line:
                ready.set()
    threading.Thread(target=output, daemon=True).start()
    if not ready.wait(50):
        p.terminate()
        p.wait(timeout=10)
        raise RuntimeError('server did not become ready')
    return p


try:
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
    sock.close()
    run([DT, 'create', tunnel, '--expiration', '1h', '--json'])
    created = True
    run([DT, 'port', 'create', tunnel, '-p', str(port), '--json'])
    server = start_server(port)
    print(run([NODE, SCRIPT, 'add', '--name', 'loopback', '--tunnel', tunnel, '--port', str(port), '--session', 'remote', '--hc', HC]))
    wait_connected()
    output = run([HC, 'run', '--on', 'loopback', '--timeout', '15', '--', NODE, '-e', 'console.log("LIVE_TUNNEL_OK")'])
    assert 'LIVE_TUNNEL_OK' in output, output
    print('LIVE EXEC/OUTPUT PASSED')
    # Keep a process running while the network bridge goes down and comes back.
    run([HC, 'run', '--on', 'loopback', '--bg', '--name', 'ticker', '--', NODE, '-e',
         'console.log("START",process.pid);setInterval(()=>console.log("TICK",process.pid),1000)'])
    before = json.loads(run([HC, 'get', 'loopback/ticker', '--json']))
    server.terminate()
    server.wait(timeout=10)
    time.sleep(3)
    server = start_server(port)
    wait_connected()
    after = json.loads(run([HC, 'get', 'loopback/ticker', '--json']))
    assert before['address'] == after['address'], (before, after)
    assert before['pid'] and before['pid'] == after['pid'], (before, after)
    assert 'TICK' in run([HC, 'read', 'loopback/ticker', '--lines', '20'])
    print('RECONNECT / SAME TERMINAL AND PID PASSED')
    run([HC, 'kill', 'loopback/ticker'])
    print('ALL LIVE TESTS PASSED')
finally:
    # A running scratch terminal must not survive the test on failure.
    remote_env = dict(env, HC_SESSION='remote')
    subprocess.run([HC, 'kill', 'ticker'], env=remote_env, capture_output=True, timeout=10)
    for session in ['client', 'remote']:
        subprocess.run([HC, 'server', 'stop'], env=dict(env, HC_SESSION=session), capture_output=True, timeout=10)
    if server and server.poll() is None:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait()
    if created:
        try:
            run([DT, 'delete', tunnel, '--force'])
            print('Deleted private test tunnel:', tunnel)
        except Exception as exc:
            print('CLEANUP REQUIRED:', tunnel, exc)
    shutil.rmtree(scratch)
