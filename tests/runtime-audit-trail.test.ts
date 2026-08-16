import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCli } from '../src/cli/main.js';
import { auditTrailDirectoryV4, createAuditTrailV4, verifyAuditTrailV4 } from '../src/runtime/audit-trail.js';
import { canonicalJsonV4, hashCanonicalV4 } from '../src/runtime/canonical.js';

const runId = 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1';
const hash = (value: string): string => hashCanonicalV4({ value });

async function directory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'runner-v4-audit-'));
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    event_id: 'execution-1',
    event_type: 'MODEL_EXECUTION_RECORDED',
    story_id: 'story-1',
    run_id: runId,
    started_at: '2026-08-16T08:00:00.000Z',
    finished_at: '2026-08-16T08:01:00.000Z',
    contract_hash: hash('contract'),
    capability_snapshot_hash: hash('snapshot'),
    prompt: 'Use API_KEY=sk-test-12345678901234567890 and Bearer eyJheader.payload.signature',
    raw_completion: 'postgresql://alice:password@example.invalid/db?sslmode=require',
    diff: { changed_files: ['src/example.ts'], token: 'ghp_123456789012345678901234' },
    validation_results: [{ validation_id: 'test', exit_code: 0, result_hash: hash('gate'), output: 'passed' }],
    status: 'EXECUTION_COMPLETED',
    ...overrides,
  };
}

test('redacts API keys, bearer tokens, connection strings and nested diff values before serialization', async () => {
  const stateDirectory = await directory();
  const trail = await createAuditTrailV4(auditTrailDirectoryV4(stateDirectory));
  await trail.append(entry());
  await trail.close();

  const bytes = await readFile(join(auditTrailDirectoryV4(stateDirectory), 'audit-trail.v4.ndjson'), 'utf8');
  assert.doesNotMatch(bytes, /sk-test-12345678901234567890/u);
  assert.doesNotMatch(bytes, /eyJheader\.payload\.signature/u);
  assert.doesNotMatch(bytes, /postgresql:\/\/alice:password/u);
  assert.doesNotMatch(bytes, /ghp_123456789012345678901234/u);
  assert.match(bytes, /\[REDACTED\]/u);
  assert.equal((await verifyAuditTrailV4(auditTrailDirectoryV4(stateDirectory))).status, 'OK');
});

test('chains entries and reports an integrity breach after historical tampering', async () => {
  const stateDirectory = await directory();
  const trail = await createAuditTrailV4(auditTrailDirectoryV4(stateDirectory));
  await trail.append(entry());
  await trail.append(entry({ event_id: 'execution-2', status: 'REJECTED' }));
  await trail.close();

  const path = join(auditTrailDirectoryV4(stateDirectory), 'audit-trail.v4.ndjson');
  const records = (await readFile(path, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  const first = records[0]!;
  const firstEntry = first.entry as Record<string, unknown>;
  firstEntry.status = 'TAMPERED';
  await writeFile(path, `${canonicalJsonV4(first)}\n${canonicalJsonV4(records[1])}\n`);

  const report = await verifyAuditTrailV4(auditTrailDirectoryV4(stateDirectory));
  assert.equal(report.status, 'INTEGRITY_BREACH');
  assert.match(report.error ?? '', /record hash|chain/u);
});

test('CLI audit verification returns a deterministic OK report for an empty ledger', async () => {
  const stateDirectory = await directory();
  const output: string[] = [];
  const exitCode = await runCli(['runtime', 'audit-verify', '--state-directory', stateDirectory], { stdout: (line) => output.push(line) });
  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(output[0]!), { status: 'OK', record_count: 0, last_hash: null });
});
