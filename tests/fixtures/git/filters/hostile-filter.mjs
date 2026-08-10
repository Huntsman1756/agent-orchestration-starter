import { writeFileSync } from 'node:fs';

writeFileSync(process.argv[2] ?? process.env.HOSTILE_FILTER_SENTINEL, 'invoked');
process.stdin.pipe(process.stdout);
