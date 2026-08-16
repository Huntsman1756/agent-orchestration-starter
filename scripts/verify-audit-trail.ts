import { resolve } from 'node:path';

import { auditTrailDirectoryV4, verifyAuditTrailV4 } from '../src/runtime/audit-trail.js';

function stateDirectory(argv: readonly string[]): string {
  if (argv.length === 0) return resolve('.agent-orchestration');
  if (argv.length !== 2 || argv[0] !== '--state-directory' || argv[1] === undefined || argv[1].startsWith('--')) {
    throw new Error('audit:verify accepts only --state-directory <path>');
  }
  return resolve(argv[1]);
}

const report = await verifyAuditTrailV4(auditTrailDirectoryV4(stateDirectory(process.argv.slice(2))));
if (report.status === 'OK') {
  console.log(`OK: ${report.record_count} audit records`);
  process.exitCode = 0;
} else {
  console.error(`INTEGRITY_BREACH: ${report.error ?? 'audit trail verification failed'}`);
  process.exitCode = 1;
}
