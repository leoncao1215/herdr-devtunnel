#!/usr/bin/env node
if (process.argv[2] !== 'connect' || process.argv[3] !== '--session') process.exit(2);
process.stderr.write('fixture core connected\n');
process.stdin.pipe(process.stdout);
