#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
if (process.argv[2] !== 'connect') process.exit(2);
writeFileSync(process.env.TEST_PID_FILE, String(process.pid));
console.log(`SSH: Forwarding from 127.0.0.1:${process.env.TEST_LOCAL_PORT} to host port 43821.`);
console.log(`SSH: PortForwardingService listening on 127.0.0.1:${process.env.TEST_LOCAL_PORT}.`);
setInterval(() => {}, 1000);
process.on('SIGTERM', () => { writeFileSync(process.env.TEST_STOP_FILE, 'stopped'); process.exit(0); });
