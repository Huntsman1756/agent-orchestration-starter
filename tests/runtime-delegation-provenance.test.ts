import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';

import {
  createDelegationProvenanceV4,
  verifyDelegationProvenanceV4,
} from '../src/runtime/delegation-provenance.js';
import { runCli } from '../src/cli/main.js';

const hash = (character: string) => character.repeat(64);
const sha = (character: string) => character.repeat(40);
const keyPair = generateKeyPairSync('ed25519');
const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const signer = {
  public_key_spki_der: keyPair.publicKey.export({ type: 'spki', format: 'der' }),
  sign: (payload: Uint8Array) => sign(null, payload, keyPair.privateKey),
};

test('creates self-hashed delegated evidence bound to the finalized commit and accepted worker receipts', () => {
  const evidence = createDelegationProvenanceV4({
    run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1',
    route: 'ORCHESTRATED',
    disposition: 'DELEGATED',
    contract_hash: hash('a'),
    policy_hash: hash('b'),
    profile_hash: hash('c'),
    worker_capability_hash: hash('d'),
    base_sha: sha('1'),
    commit_sha: sha('2'),
    git_tree_sha: sha('3'),
    evidence_tree_hash: hash('e'),
    diff_hash: hash('f'),
    validation_manifest_hash: hash('4'),
    review_attestation_hash: hash('5'),
    accepted_story_receipt_hashes: [hash('6')],
    frontier_decision_hashes: [hash('7')],
    exemption: null,
    created_at: '2026-08-13T12:00:00.000Z',
  }, signer);

  assert.match(evidence.provenance_hash, /^[a-f0-9]{64}$/u);
  assert.equal(verifyDelegationProvenanceV4(evidence, {
    commit_sha: sha('2'),
    git_tree_sha: sha('3'),
    policy_hash: hash('b'),
    profile_hash: hash('c'),
  }, publicKeyPem).provenance_hash, evidence.provenance_hash);
});

test('fails closed for missing, forged, stale, or semantically false delegation evidence', () => {
  const body = {
    run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1', route: 'ORCHESTRATED' as const, disposition: 'DELEGATED' as const,
    contract_hash: hash('a'), policy_hash: hash('b'), profile_hash: hash('c'), worker_capability_hash: hash('d'),
    base_sha: sha('1'), commit_sha: sha('2'), git_tree_sha: sha('3'), evidence_tree_hash: hash('e'), diff_hash: hash('f'),
    validation_manifest_hash: hash('4'), review_attestation_hash: hash('5'), accepted_story_receipt_hashes: [hash('6')],
    frontier_decision_hashes: [], exemption: null, created_at: '2026-08-13T12:00:00.000Z',
  };
  const evidence = createDelegationProvenanceV4(body, signer);
  const binding = { commit_sha: sha('2'), git_tree_sha: sha('3'), policy_hash: hash('b'), profile_hash: hash('c') };

  assert.throws(() => verifyDelegationProvenanceV4(undefined, binding, publicKeyPem), /DELEGATION_PROVENANCE_INVALID/u);
  assert.throws(() => verifyDelegationProvenanceV4({ ...evidence, diff_hash: hash('0') }, binding, publicKeyPem), /self-hash/u);
  assert.throws(() => verifyDelegationProvenanceV4(evidence, { ...binding, commit_sha: sha('9') }, publicKeyPem), /commit or tree/u);
  assert.throws(() => createDelegationProvenanceV4({ ...body, accepted_story_receipt_hashes: [] }, signer), /DELEGATION_PROVENANCE_INVALID/u);
});

test('allows frontier-only implementation only with a hash-bound machine-readable exemption', () => {
  assert.throws(() => createDelegationProvenanceV4({
    run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1', route: 'FRONTIER_EXECUTION', disposition: 'FRONTIER_ONLY_EXEMPTION',
    contract_hash: hash('a'), policy_hash: hash('b'), profile_hash: hash('c'), worker_capability_hash: null,
    base_sha: sha('1'), commit_sha: sha('2'), git_tree_sha: sha('3'), evidence_tree_hash: hash('e'), diff_hash: hash('f'),
    validation_manifest_hash: hash('4'), review_attestation_hash: hash('5'), accepted_story_receipt_hashes: [], frontier_decision_hashes: [],
    exemption: null, created_at: '2026-08-13T12:00:00.000Z',
  }, signer), /DELEGATION_PROVENANCE_INVALID/u);

  const evidence = createDelegationProvenanceV4({
    run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1', route: 'FRONTIER_EXECUTION', disposition: 'FRONTIER_ONLY_EXEMPTION',
    contract_hash: hash('a'), policy_hash: hash('b'), profile_hash: hash('c'), worker_capability_hash: null,
    base_sha: sha('1'), commit_sha: sha('2'), git_tree_sha: sha('3'), evidence_tree_hash: hash('e'), diff_hash: hash('f'),
    validation_manifest_hash: hash('4'), review_attestation_hash: hash('5'), accepted_story_receipt_hashes: [], frontier_decision_hashes: [],
    exemption: { reason_code: 'SECURITY_CRITICAL', authority_ref: 'frontier-reviewer', authority_evidence_hash: hash('8') },
    created_at: '2026-08-13T12:00:00.000Z',
  }, signer);
  assert.equal(evidence.disposition, 'FRONTIER_ONLY_EXEMPTION');
});

test('CLI verifies the exact evidence binding and fails closed for a different commit', async () => {
  const evidence = createDelegationProvenanceV4({
    run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1', route: 'ECONOMY', disposition: 'DELEGATED',
    contract_hash: hash('a'), policy_hash: hash('b'), profile_hash: hash('c'), worker_capability_hash: hash('d'),
    base_sha: sha('1'), commit_sha: sha('2'), git_tree_sha: sha('3'), evidence_tree_hash: hash('e'), diff_hash: hash('f'),
    validation_manifest_hash: hash('4'), review_attestation_hash: hash('5'), accepted_story_receipt_hashes: [hash('6')],
    frontier_decision_hashes: [], exemption: null, created_at: '2026-08-13T12:00:00.000Z',
  }, signer);
  const directory = await mkdtemp(join(tmpdir(), 'ao-delegation-evidence-'));
  const path = join(directory, 'evidence.json');
  const publicKeyPath = join(directory, 'public-key.pem');
  await writeFile(path, JSON.stringify(evidence), 'utf8');
  await writeFile(publicKeyPath, publicKeyPem, 'utf8');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const args = ['runtime', 'verify-delegation', '--evidence', path, '--public-key', publicKeyPath, '--commit-sha', sha('2'), '--git-tree-sha', sha('3'), '--policy-hash', hash('b'), '--profile-hash', hash('c')];

  assert.equal(await runCli(args, { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) }), 0);
  assert.equal(JSON.parse(stdout[0]!).verified, true);
  assert.equal(await runCli(args.map((value) => value === sha('2') ? sha('9') : value), { stdout: () => undefined, stderr: (line) => stderr.push(line) }), 2);
  assert.match(stderr.at(-1) ?? '', /commit or tree binding does not match/u);
});

test('the public JSON Schema enforces delegated and frontier-only semantic branches', async () => {
  const schema = JSON.parse(await readFile(new URL('../contracts/delegation-provenance-v4.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ strict: true, allErrors: true, validateFormats: false }).compile(schema);
  const evidence = createDelegationProvenanceV4({
    run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1', route: 'ECONOMY', disposition: 'DELEGATED', contract_hash: hash('a'),
    policy_hash: hash('b'), profile_hash: hash('c'), worker_capability_hash: hash('d'), base_sha: sha('1'), commit_sha: sha('2'),
    git_tree_sha: sha('3'), evidence_tree_hash: hash('e'), diff_hash: hash('f'), validation_manifest_hash: hash('4'),
    review_attestation_hash: hash('5'), accepted_story_receipt_hashes: [hash('6')], frontier_decision_hashes: [], exemption: null,
    created_at: '2026-08-13T12:00:00.000Z',
  }, signer);
  assert.equal(validate(evidence), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...evidence, accepted_story_receipt_hashes: [] }), false);
  assert.equal(validate({ ...evidence, disposition: 'FRONTIER_ONLY_EXEMPTION', route: 'FRONTIER_EXECUTION', worker_capability_hash: null, accepted_story_receipt_hashes: [], exemption: null }), false);
});
