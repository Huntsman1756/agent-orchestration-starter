import { createHash } from 'node:crypto';

import { hashCanonicalV4 } from './canonical.js';
import type { SandboxProfileV4 } from './process-sandbox.js';

export const REQUIRED_SANDBOX_EFFECTS_V4 = Object.freeze([
  'outside_sentinel_blocked',
  'host_home_blocked',
  'credential_environment_blocked',
  'credential_argv_blocked',
  'credential_files_blocked',
  'descendant_state_blocked',
  'outside_write_blocked',
  'pid_limit_enforced',
  'timeout_tree_killed',
  'docker_socket_blocked',
  'loopback_blocked',
  'gateway_allowlisted_success',
  'gateway_non_allowlisted_blocked',
  'direct_ip_blocked',
  'gateway_credential_separated',
  'gateway_no_repository_mount',
  'metadata_only_logs',
] as const);

export type SandboxHostileEffectV4 = (typeof REQUIRED_SANDBOX_EFFECTS_V4)[number];

export type SandboxCertificationArtifactKindV4 =
  'DOCKER_IDENTITY_RESULT' | 'HOSTILE_PROCESS_RESULT' | 'TIMEOUT_TREE_RESULT' | 'GATEWAY_NETWORK_RESULT';

export interface SandboxCertificationIdentityV4 {
  readonly backend_id: 'docker-engine-linux-v4';
  readonly docker_server_id: string;
  readonly docker_server_version: string;
  readonly docker_server_os: 'linux';
  readonly docker_server_architecture: string;
  readonly image_id: `sha256:${string}`;
  readonly image_os: 'linux';
  readonly image_architecture: string;
  readonly profile: SandboxProfileV4;
  readonly policy_hash: `sha256:${string}`;
  readonly broker_version: string;
}

export interface SandboxCertificationArtifactV4 {
  readonly artifact_id: string;
  readonly execution_id: string;
  readonly kind: SandboxCertificationArtifactKindV4;
  readonly started_at: string;
  readonly completed_at: string;
  readonly content_base64: string;
  readonly content_hash: `sha256:${string}`;
}

export interface SandboxCertificationObservationV4 {
  readonly effect: SandboxHostileEffectV4;
  readonly passed: true;
  readonly artifact_ids: readonly string[];
}

export interface SandboxCertificationTranscriptV4 {
  readonly run_id: string;
  readonly identity: SandboxCertificationIdentityV4;
  readonly started_at: string;
  readonly completed_at: string;
  readonly artifacts: readonly SandboxCertificationArtifactV4[];
  readonly observations: readonly SandboxCertificationObservationV4[];
}

export interface ValidatedSandboxCertificationEvidenceV4 {
  readonly evidence_hash: `sha256:${string}`;
  readonly certified_at: string;
  readonly expires_at: string;
}

function unavailable(): never {
  throw new Error('PROCESS_SANDBOX_UNAVAILABLE: process sandbox is unavailable');
}

const transcriptKeys = ['artifacts', 'completed_at', 'identity', 'observations', 'run_id', 'started_at'] as const;
const artifactKeys = ['artifact_id', 'completed_at', 'content_base64', 'content_hash', 'execution_id', 'kind', 'started_at'] as const;
const observationKeys = ['artifact_ids', 'effect', 'passed'] as const;
const artifactKinds = new Set<SandboxCertificationArtifactKindV4>([
  'DOCKER_IDENTITY_RESULT',
  'HOSTILE_PROCESS_RESULT',
  'TIMEOUT_TREE_RESULT',
  'GATEWAY_NETWORK_RESULT',
]);
const gatewayEffects = new Set<SandboxHostileEffectV4>([
  'gateway_allowlisted_success',
  'gateway_non_allowlisted_blocked',
  'direct_ip_blocked',
  'gateway_credential_separated',
  'gateway_no_repository_mount',
  'metadata_only_logs',
]);

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function exactIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function artifactKindForEffect(effect: SandboxHostileEffectV4): SandboxCertificationArtifactKindV4 {
  if (effect === 'timeout_tree_killed') return 'TIMEOUT_TREE_RESULT';
  if (gatewayEffects.has(effect)) return 'GATEWAY_NETWORK_RESULT';
  return 'HOSTILE_PROCESS_RESULT';
}

export function validateSandboxCertificationTranscriptV4(
  candidate: unknown,
  identity: SandboxCertificationIdentityV4,
  ttlSeconds: number,
  checkedAt: string,
): ValidatedSandboxCertificationEvidenceV4 {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 900) unavailable();
  if (
    !exactIsoTimestamp(checkedAt) ||
    typeof candidate !== 'object' ||
    candidate === null ||
    Array.isArray(candidate) ||
    !exactKeys(candidate, transcriptKeys)
  )
    unavailable();
  const transcript = candidate as Partial<SandboxCertificationTranscriptV4>;
  if (
    typeof transcript.run_id !== 'string' ||
    !/^cert_run_[a-z0-9_-]{4,96}$/.test(transcript.run_id) ||
    !exactIsoTimestamp(transcript.started_at) ||
    !exactIsoTimestamp(transcript.completed_at) ||
    hashCanonicalV4(transcript.identity) !== hashCanonicalV4(identity) ||
    !Array.isArray(transcript.artifacts) ||
    !Array.isArray(transcript.observations)
  )
    unavailable();
  const started = new Date(transcript.started_at).getTime();
  const completed = new Date(transcript.completed_at).getTime();
  const checked = new Date(checkedAt).getTime();
  if (completed < started || completed - started > 10 * 60_000 || completed > checked) unavailable();
  if (transcript.artifacts.length !== artifactKinds.size) unavailable();

  const artifacts = new Map<string, SandboxCertificationArtifactV4>();
  const seenKinds = new Set<SandboxCertificationArtifactKindV4>();
  let decodedBytes = 0;
  for (const candidateArtifact of transcript.artifacts) {
    if (
      typeof candidateArtifact !== 'object' ||
      candidateArtifact === null ||
      Array.isArray(candidateArtifact) ||
      !exactKeys(candidateArtifact, artifactKeys)
    )
      unavailable();
    const artifact = candidateArtifact as SandboxCertificationArtifactV4;
    if (
      !/^artifact_[a-z0-9_-]{4,96}$/.test(artifact.artifact_id) ||
      artifacts.has(artifact.artifact_id) ||
      !/^exec_[a-z0-9_-]{8,96}$/.test(artifact.execution_id) ||
      !artifactKinds.has(artifact.kind) ||
      !exactIsoTimestamp(artifact.started_at) ||
      !exactIsoTimestamp(artifact.completed_at) ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(artifact.content_base64) ||
      !/^sha256:[a-f0-9]{64}$/.test(artifact.content_hash) ||
      seenKinds.has(artifact.kind)
    )
      unavailable();
    const artifactStarted = new Date(artifact.started_at).getTime();
    const artifactCompleted = new Date(artifact.completed_at).getTime();
    if (artifactStarted < started || artifactCompleted > completed || artifactCompleted < artifactStarted) unavailable();
    const content = Buffer.from(artifact.content_base64, 'base64');
    if (
      content.length === 0 ||
      content.length > 256 * 1024 ||
      content.toString('base64') !== artifact.content_base64 ||
      artifact.content_hash !== `sha256:${createHash('sha256').update(content).digest('hex')}`
    )
      unavailable();
    decodedBytes += content.length;
    if (decodedBytes > 1024 * 1024) unavailable();
    artifacts.set(artifact.artifact_id, artifact);
    seenKinds.add(artifact.kind);
  }
  if (seenKinds.size !== artifactKinds.size) unavailable();
  const identityArtifacts = [...artifacts.values()].filter((artifact) => artifact.kind === 'DOCKER_IDENTITY_RESULT');
  if (identityArtifacts.length !== 1) unavailable();
  try {
    const encodedIdentity = JSON.parse(Buffer.from(identityArtifacts[0]!.content_base64, 'base64').toString('utf8')) as unknown;
    if (hashCanonicalV4(encodedIdentity) !== hashCanonicalV4(identity)) unavailable();
  } catch {
    unavailable();
  }

  if (transcript.observations.length !== REQUIRED_SANDBOX_EFFECTS_V4.length) unavailable();
  const effects = new Set<SandboxHostileEffectV4>();
  const referencedArtifacts = new Set<string>();
  for (const candidateObservation of transcript.observations) {
    if (
      typeof candidateObservation !== 'object' ||
      candidateObservation === null ||
      Array.isArray(candidateObservation) ||
      !exactKeys(candidateObservation, observationKeys)
    )
      unavailable();
    const observation = candidateObservation as SandboxCertificationObservationV4;
    if (
      !REQUIRED_SANDBOX_EFFECTS_V4.includes(observation.effect) ||
      effects.has(observation.effect) ||
      observation.passed !== true ||
      !Array.isArray(observation.artifact_ids) ||
      observation.artifact_ids.length === 0 ||
      observation.artifact_ids.length > 4
    )
      unavailable();
    const requiredKind = artifactKindForEffect(observation.effect);
    if (observation.artifact_ids.some((artifactId) => artifacts.get(artifactId)?.kind !== requiredKind)) unavailable();
    for (const artifactId of observation.artifact_ids) referencedArtifacts.add(artifactId);
    effects.add(observation.effect);
  }
  if (REQUIRED_SANDBOX_EFFECTS_V4.some((effect) => !effects.has(effect))) unavailable();
  if (
    [...artifacts.values()].some((artifact) => artifact.kind !== 'DOCKER_IDENTITY_RESULT' && !referencedArtifacts.has(artifact.artifact_id))
  )
    unavailable();
  const expiresAt = new Date(completed + ttlSeconds * 1_000).toISOString();
  return Object.freeze({
    evidence_hash: `sha256:${hashCanonicalV4(transcript)}`,
    certified_at: transcript.completed_at,
    expires_at: expiresAt,
  });
}
