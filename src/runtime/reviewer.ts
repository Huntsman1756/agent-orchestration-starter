import type { ResolvedBindingV4 } from './bindings.js';
import { assertFreshCapability, type CapabilityIdentityV4, type CapabilityRecordV4 } from './capabilities.js';
import { canonicalJsonV4, hashCanonicalV4 } from './canonical.js';
import type { ReviewAttestationV4 } from './contracts.js';
import { validateCredentialLeaseV4, type CredentialAdapterV4 } from './credential-adapter.js';
import { verifyReviewAttestation } from './review-attestation.js';
import type { ReviewCapsuleInputV4, ReviewCapsuleV4, ReviewContextV4 } from './review-capsule.js';
import { buildReviewCapsule } from './review-capsule.js';
import type { ReviewEnvelopeV4 } from './review-envelope.js';
import type { ProcessSandboxBackendV4 } from './process-sandbox.js';
import type { ExecutorAttemptResultV4 } from './opencode-runner.js';

export interface ReviewInputV4 {
  readonly execution_id: string;
  readonly binding: ResolvedBindingV4;
  readonly capability: CapabilityRecordV4;
  readonly envelope: ReviewEnvelopeV4;
  readonly capsule_parent: string;
  readonly forbidden_roots: readonly string[];
  readonly expected_sandbox_policy_hash: string;
  readonly prior_session_ids: readonly string[];
}
export type ReviewOutcomeV4 = ReviewAttestationV4;
export interface ReviewerV4 { review(input: ReviewInputV4): Promise<ReviewOutcomeV4>; }
export interface ReviewerDependenciesV4 {
  readonly sandbox: ProcessSandboxBackendV4;
  readonly credentials: CredentialAdapterV4;
  readonly harness_argv: readonly string[];
  readonly capability_identity_for: (binding: ResolvedBindingV4) => CapabilityIdentityV4;
  readonly now?: () => string;
  readonly build_capsule?: (input: ReviewCapsuleInputV4) => Promise<ReviewCapsuleV4>;
  readonly resolve_context?: (requestHash: string) => Promise<ReviewContextV4>;
  readonly persist_attestation: (attestation: ReviewAttestationV4) => Promise<void>;
}

function invalid(message: string): never { throw new Error(`REVIEW_ATTESTATION_INVALID: ${message}`); }
function parse(stdout: string): { session: string; attestation: unknown } {
  if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) invalid('review output exceeds policy');
  const events = stdout.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return invalid('review emitted non-JSON'); } });
  const allowed = new Set(['thread.started', 'turn.started', 'item.started', 'item.updated', 'item.completed', 'turn.completed']);
  const threads = events.filter((event) => event.type === 'thread.started');
  const terminals = events.filter((event) => event.type === 'turn.completed');
  if (events.length < 3 || events.length > 1024 || events.some((event) => !allowed.has(String(event.type)))
    || threads.length !== 1 || threads[0] !== events[0] || terminals.length !== 1 || terminals[0] !== events.at(-1)) invalid('review event sequence is malformed');
  const session = events[0]?.thread_id;
  const messages = events.filter((event) => event.type === 'item.completed' && (event.item as Record<string, unknown> | undefined)?.type === 'agent_message');
  const text = (messages.at(-1)?.item as Record<string, unknown> | undefined)?.text;
  if (typeof session !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(session) || typeof text !== 'string' || text.length > 64 * 1024) invalid('review session or final message is missing');
  try { return { session, attestation: JSON.parse(text) }; } catch { return invalid('review final message is not JSON'); }
}

export function createReviewer(deps: ReviewerDependenciesV4): ReviewerV4 {
  if (deps.harness_argv.length < 1) invalid('review harness argv is empty');
  return Object.freeze({
    review: async (input: ReviewInputV4): Promise<ReviewOutcomeV4> => {
      const expectedKeys = ['binding', 'capability', 'capsule_parent', 'envelope', 'execution_id', 'expected_sandbox_policy_hash', 'forbidden_roots', 'prior_session_ids'];
      const suppliedKeys = Object.keys(input).sort();
      const { envelope_hash: suppliedEnvelopeHash, ...envelopeBody } = input.envelope;
      if (suppliedKeys.length !== expectedKeys.length || suppliedKeys.some((key, index) => key !== expectedKeys[index])
        || suppliedEnvelopeHash !== hashCanonicalV4(envelopeBody)
        || new Set(input.prior_session_ids).size !== input.prior_session_ids.length) invalid('review input is forged or contains caller-owned execution fields');
      if (input.binding.role !== 'reviewer' || input.binding.binding.harness !== 'codex' || input.binding.binding.permissions !== 'read-only') invalid('review binding is incompatible');
      const now = (deps.now ?? (() => new Date().toISOString()))();
      assertFreshCapability(input.capability, deps.capability_identity_for(input.binding), now);
      const probe = await deps.sandbox.probe('REVIEW_CAPSULE');
      if (probe.status !== 'SUPPORTED' || probe.policy_hash !== input.expected_sandbox_policy_hash || Date.parse(probe.expires_at) <= Date.parse(now)) throw new Error('REVIEW_SANDBOX_UNAVAILABLE: review sandbox is unavailable');
      const lease = validateCredentialLeaseV4(await deps.credentials.lease(input.binding), now);
      const sessions = [...input.prior_session_ids];
      let context: ReviewContextV4[] = [];
      try {
        for (let round = 0; round < 2; round += 1) {
          const capsule = await (deps.build_capsule ?? buildReviewCapsule)({ capsule_parent: input.capsule_parent, envelope: input.envelope, forbidden_roots: input.forbidden_roots, approved_context: context });
          const run = await deps.sandbox.run({ execution_id: round === 0 ? input.execution_id : `${input.execution_id.slice(0, 88)}_context`, profile: 'REVIEW_CAPSULE', argv: [...deps.harness_argv, 'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only', '--skip-git-repo-check', '--output-schema', '/capsule/review-attestation-v4.schema.json', '--json', '--cd', '/capsule', '--model', input.binding.binding.model, `Review only the evidence in envelope.json. Do not infer missing context. Return the strict attestation.\n${canonicalJsonV4({ envelope_hash: input.envelope.envelope_hash, capsule_manifest_hash: capsule.manifest_hash })}`], working_directory: '/capsule', environment: Object.freeze({ ...lease.environment, HOME: '/capsule/home', TMPDIR: '/capsule/tmp', NO_COLOR: '1' }), mounts: [{ source: capsule.root, target: '/capsule', access: 'READ_ONLY' }], network: { mode: 'INTERNAL', name: lease.internal_network }, timeout_ms: 300_000, max_output_bytes: 2 * 1024 * 1024 });
          if (run.exit_code !== 0 || run.timed_out || run.stdout_truncated || run.stderr_truncated) invalid('review harness failed');
          const parsed = parse(run.stdout);
          const verified = verifyReviewAttestation({ attestation: parsed.attestation, current: { contract_hash: input.envelope.contract.contract_hash, base_sha: input.envelope.base_sha, tree_hash: input.envelope.tree_hash, diff_hash: input.envelope.diff_hash, validation_manifest_hash: input.envelope.validation_manifest_hash, allowed_session_id: parsed.session, prior_session_ids: sessions } });
          if (verified.reviewer_binding_ref !== input.binding.binding_hash || verified.run_id !== input.envelope.contract.run_id) invalid('reviewer or run identity is mismatched');
          sessions.push(parsed.session);
          if (verified.decision !== 'REQUEST_CONTEXT') { await deps.persist_attestation(verified); return verified; }
          if (round !== 0 || deps.resolve_context === undefined || verified.requested_context_hashes.length === 0) invalid('context request is unavailable or exceeded its single round');
          context = await Promise.all(verified.requested_context_hashes.map(async (requestHash) => {
            const item = await deps.resolve_context!(requestHash);
            if (hashCanonicalV4({ path: item.path, content_hash: item.content_hash }) !== requestHash) invalid('resolved context does not match the request');
            return item;
          }));
        }
      } finally { await deps.credentials.revoke(lease.lease_id); }
      return invalid('review did not reach a terminal decision');
    },
  });
}

export type EconomySequenceStateV4 =
  | 'ECONOMY_EXECUTION_1' | 'VALIDATION_1' | 'REVIEW_1'
  | 'ECONOMY_REPAIR' | 'VALIDATION_2' | 'REVIEW_2'
  | 'FRONTIER_ESCALATION' | 'VALIDATION_3' | 'FINAL_REVIEW'
  | 'ACCEPTED' | 'TERMINAL_REJECTED';

export interface EconomyReviewSequenceDependenciesV4 {
  readonly execute_economy: (attempt: 1 | 2, findingHashes: readonly string[]) => Promise<ExecutorAttemptResultV4>;
  readonly execute_frontier: (authority: { review_rejection_hashes: readonly [string, string]; escalation_decision_hash: string }) => Promise<ExecutorAttemptResultV4>;
  readonly validate: (attempt: ExecutorAttemptResultV4, ordinal: 1 | 2 | 3) => Promise<boolean>;
  readonly review: (attempt: ExecutorAttemptResultV4, ordinal: 1 | 2 | 3) => Promise<ReviewAttestationV4>;
  readonly on_state?: (state: EconomySequenceStateV4) => void;
}

export interface EconomyReviewSequenceV4 { run(): Promise<ExecutorAttemptResultV4>; }

export function createEconomyReviewSequence(deps: EconomyReviewSequenceDependenciesV4): EconomyReviewSequenceV4 {
  const state = (value: EconomySequenceStateV4): void => { deps.on_state?.(value); };
  const rejected = (message: string): never => { state('TERMINAL_REJECTED'); throw new Error(`REVIEW_REJECTED: ${message}`); };
  const validated = async (attempt: ExecutorAttemptResultV4, ordinal: 1 | 2 | 3): Promise<void> => {
    state(`VALIDATION_${ordinal}` as EconomySequenceStateV4);
    if (!await deps.validate(attempt, ordinal)) rejected('deterministic validation failed');
  };
  return Object.freeze({
    run: async (): Promise<ExecutorAttemptResultV4> => {
      state('ECONOMY_EXECUTION_1');
      let attempt = await deps.execute_economy(1, []);
      await validated(attempt, 1);
      state('REVIEW_1');
      const first = await deps.review(attempt, 1);
      if (first.decision === 'ACCEPT') { state('ACCEPTED'); return attempt; }
      if (first.decision !== 'REJECT') rejected('context request escaped the bounded reviewer');

      const unresolved = new Set(first.unresolved_finding_ids);
      const findingHashes = Object.freeze(first.findings.filter((finding) => unresolved.has(finding.id)).map((finding) => hashCanonicalV4(finding)));
      if (findingHashes.length === 0 || !/^[a-f0-9]{64}$/.test(first.attestation_hash)) rejected('first rejection lacks persisted finding evidence');
      state('ECONOMY_REPAIR');
      attempt = await deps.execute_economy(2, findingHashes);
      await validated(attempt, 2);
      state('REVIEW_2');
      const second = await deps.review(attempt, 2);
      if (second.decision === 'ACCEPT') { state('ACCEPTED'); return attempt; }
      if (second.decision !== 'REJECT') rejected('context request escaped the bounded reviewer');
      if (!/^[a-f0-9]{64}$/.test(second.attestation_hash)) rejected('second rejection lacks persisted evidence');

      const rejectionHashes = [first.attestation_hash, second.attestation_hash] as const;
      const escalationDecisionHash = hashCanonicalV4({ route: 'FRONTIER', review_rejection_hashes: rejectionHashes });
      state('FRONTIER_ESCALATION');
      attempt = await deps.execute_frontier({ review_rejection_hashes: rejectionHashes, escalation_decision_hash: escalationDecisionHash });
      await validated(attempt, 3);
      state('FINAL_REVIEW');
      const final = await deps.review(attempt, 3);
      if (final.decision !== 'ACCEPT') rejected('final frontier review rejected the result');
      state('ACCEPTED');
      return attempt;
    },
  });
}
