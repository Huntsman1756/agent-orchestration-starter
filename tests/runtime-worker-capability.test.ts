import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';

import { hashCanonicalV4 } from '../src/runtime/canonical.js';
import { createNormalizedFailureSignatureV4, loadRepairPacketV4 } from '../src/runtime/repair-packet.js';
import { createWorkerCapabilityV4, loadWorkerCapabilityV4 } from '../src/runtime/worker-capability.js';

const hash = (character: string) => character.repeat(64);

function body() {
  return {
    schema_version: 4 as const,
    binding_ref: 'economy-binding-v1',
    deployment: {
      provider_ref: 'provider-a',
      model_ref: 'model-family-a',
      model_revision: 'model-family-a-2026-08-10-r1',
      model_artifact_hash: hash('a'),
      endpoint_revision: 'endpoint-2026-08-10-r1',
      harness_ref: 'portable-harness',
      harness_revision: 'harness-1.2.3',
      tool_protocol: 'native-json-tools',
      tool_parser_revision: 'parser-2.1.0',
      tool_bundle_hash: hash('b'),
      instruction_bundle_hash: hash('d'),
      qualification_evidence_hash: hash('c'),
    },
    capabilities: ['patch_application', 'repository_search', 'structured_repair_feedback'],
    limits: {
      max_story_files: 3,
      max_story_changed_lines: 180,
      max_story_context_bytes: 65_536,
      max_acceptance_criteria: 5,
      max_dependency_depth: 4,
      max_steps_per_attempt: 32,
      max_attempts: 2,
      no_progress_repeat_limit: 2,
    },
  };
}

test('worker capability binds exact deployment, tools, qualification, and story limits', () => {
  const capability = createWorkerCapabilityV4(body());
  const reordered = createWorkerCapabilityV4({ ...body(), capabilities: [...body().capabilities].reverse() });
  assert.match(capability.worker_capability_hash, /^[a-f0-9]{64}$/u);
  assert.equal(reordered.worker_capability_hash, capability.worker_capability_hash);
  assert.deepEqual(loadWorkerCapabilityV4(structuredClone(capability)), capability);
  assert.equal(Object.isFrozen(capability.deployment), true);
  assert.equal(Object.isFrozen(capability.capabilities), true);
  assert.notEqual(createWorkerCapabilityV4({
    ...body(),
    deployment: { ...body().deployment, model_ref: 'replaceable-model-b' },
  }).worker_capability_hash, capability.worker_capability_hash);
  assert.notEqual(createWorkerCapabilityV4({
    ...body(),
    deployment: { ...body().deployment, instruction_bundle_hash: hash('e') },
  }).worker_capability_hash, capability.worker_capability_hash);

  assert.throws(() => createWorkerCapabilityV4({
    ...body(),
    deployment: { ...body().deployment, model_revision: 'latest' },
  }), /exact immutable revision/u);
  assert.throws(() => loadWorkerCapabilityV4({ ...capability, worker_capability_hash: hash('0') }), /hash is invalid/u);
});

test('publishes strict schemas for worker capabilities and sanitized repair packets', async () => {
  const ajv = new Ajv2020({ strict: true });
  const workerSchema = JSON.parse(await readFile(new URL('../contracts/runtime-worker-capability-v4.schema.json', import.meta.url), 'utf8'));
  const repairSchema = JSON.parse(await readFile(new URL('../contracts/runtime-repair-packet-v4.schema.json', import.meta.url), 'utf8'));
  const validateWorker = ajv.compile(workerSchema);
  const validateRepair = ajv.compile(repairSchema);
  const capability = createWorkerCapabilityV4(body());
  const packetBody = {
    schema_version: 4 as const,
    story_id: 'story_alpha',
    failed_attempt: 1,
    findings: [{ finding_id: 'finding-1', source: 'REVIEW' as const, category_code: 'acceptance_mismatch', path: 'src/a.ts', line: 7, instruction: 'Implement the missing accepted behavior.', evidence_hash: hash('f') }],
  };
  const packet = loadRepairPacketV4({ ...packetBody, packet_hash: hashCanonicalV4(packetBody) });

  assert.equal(validateWorker(capability), true, JSON.stringify(validateWorker.errors));
  assert.equal(validateRepair(packet), true, JSON.stringify(validateRepair.errors));
  assert.equal(
    createNormalizedFailureSignatureV4(packet.findings),
    createNormalizedFailureSignatureV4([{ ...packet.findings[0]!, finding_id: 'renamed', line: 99, instruction: 'Different wording.', evidence_hash: hash('9') }]),
  );
  assert.notEqual(
    createNormalizedFailureSignatureV4(packet.findings),
    createNormalizedFailureSignatureV4([{ ...packet.findings[0]!, category_code: 'different_category' }]),
  );
  assert.equal(validateWorker({ ...capability, deployment: { ...capability.deployment, model_revision: 'LATEST' } }), false);
  assert.equal(validateRepair({ ...packet, findings: [{ ...packet.findings[0], path: null, line: 7 }] }), false);
  assert.throws(() => loadRepairPacketV4({ ...packet, packet_hash: hash('0') }), /hash is invalid/u);
});
