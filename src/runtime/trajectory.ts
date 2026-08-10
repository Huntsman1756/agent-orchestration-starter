import { hashCanonicalV4 } from './canonical.js';
import type { RuntimeWorkContractV4 } from './contracts.js';
import { inspectIterativeTrajectoryV4, loadIterativeStoryPlanV4, type IterativeStoryPlanV4, type StoryIterationEventV4 } from './iterative-executor.js';
import { appendRuntimeEventV4, loadRuntimeEventV4, type RuntimeEventV4 } from './telemetry.js';

export interface RuntimeGraphNodeV4 { readonly node_id: string; readonly story_hash: string; readonly status: 'PENDING' | 'RETRY' | 'ACCEPTED' | 'ESCALATED'; readonly attempts: number; }
export interface RuntimeGraphEdgeV4 { readonly from: string; readonly to: string; readonly kind: 'DEPENDS_ON'; }
export interface RuntimeExecutionGraphV4 { readonly schema_version: 4; readonly run_id: string; readonly plan_hash: string; readonly status: 'COMPLETE' | 'ESCALATE' | 'IN_PROGRESS'; readonly nodes: readonly RuntimeGraphNodeV4[]; readonly edges: readonly RuntimeGraphEdgeV4[]; readonly graph_hash: string; }

export interface RuntimeTraceSpanV4 {
  readonly trace_id: string;
  readonly span_id: string;
  readonly parent_span_id: string | null;
  readonly name: string;
  readonly recorded_at: string;
  readonly duration_ms: number | null;
  readonly status: 'OK' | 'ERROR';
  readonly attributes: Readonly<Record<string, string | number>>;
  readonly evidence_hashes: readonly string[];
}
export interface RuntimeTraceExportV4 { readonly schema_version: 4; readonly run_id: string; readonly contract_hash: string; readonly spans: readonly RuntimeTraceSpanV4[]; readonly trace_hash: string; }
export interface TrajectoryRuleResultV4 { readonly rule_id: 'TELEMETRY_CHAIN' | 'TERMINAL_LAST' | 'EXECUTION_BALANCED' | 'VALIDATION_BEFORE_REVIEW' | 'ITERATION_GRAPH'; readonly outcome: 'PASS' | 'FAIL'; readonly evidence_hashes: readonly string[]; }
export interface RuntimeTrajectoryEvaluationV4 { readonly schema_version: 4; readonly run_id: string; readonly outcome: 'PASS' | 'FAIL'; readonly rules: readonly TrajectoryRuleResultV4[]; readonly graph_hash: string | null; readonly trace_hash: string | null; readonly evaluation_hash: string; }

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function buildRuntimeExecutionGraphV4(input: { contract: RuntimeWorkContractV4; plan: IterativeStoryPlanV4; initial_tree_hash: string; events: readonly StoryIterationEventV4[] }): RuntimeExecutionGraphV4 {
  const plan = loadIterativeStoryPlanV4(input.plan, input.contract);
  const snapshot = inspectIterativeTrajectoryV4(input);
  const accepted = new Set(snapshot.accepted_story_ids);
  const lastOutcome = new Map<string, StoryIterationEventV4['outcome']>();
  for (const event of snapshot.events) lastOutcome.set(event.story_id, event.outcome);
  const nodes = plan.stories.map((story): RuntimeGraphNodeV4 => Object.freeze({
    node_id: story.story_id,
    story_hash: story.story_hash,
    status: accepted.has(story.story_id) ? 'ACCEPTED' : lastOutcome.get(story.story_id) === 'ESCALATE' ? 'ESCALATED' : lastOutcome.get(story.story_id) === 'RETRY' ? 'RETRY' : 'PENDING',
    attempts: snapshot.attempts_by_story[story.story_id] ?? 0,
  }));
  const edges = plan.stories.flatMap((story) => story.depends_on.map((dependency): RuntimeGraphEdgeV4 => Object.freeze({ from: dependency, to: story.story_id, kind: 'DEPENDS_ON' })));
  if (nodes.length > 64 || edges.length > 2_048) throw new Error('INVALID_CONTRACT: runtime graph exceeds bounded size');
  const body = { schema_version: 4 as const, run_id: plan.run_id, plan_hash: plan.plan_hash, status: snapshot.status, nodes, edges };
  return freeze({ ...body, graph_hash: hashCanonicalV4(body) });
}

export function exportRuntimeTraceV4(supplied: readonly RuntimeEventV4[]): RuntimeTraceExportV4 {
  if (supplied.length < 1 || supplied.length > 1_024) throw new Error('INVALID_CONTRACT: runtime trace event count is invalid');
  let verified: readonly RuntimeEventV4[] = Object.freeze([]);
  let previousTime = -Infinity;
  for (const event of supplied) {
    const loaded = loadRuntimeEventV4(event);
    const recordedAt = Date.parse(loaded.recorded_at);
    if (recordedAt < previousTime) throw new Error('INVALID_CONTRACT: runtime trace timestamps are not monotonic');
    previousTime = recordedAt;
    verified = appendRuntimeEventV4(verified, loaded);
  }
  const first = verified[0]!;
  const traceId = hashCanonicalV4({ run_id: first.run_id, contract_hash: first.contract_hash }).slice(0, 32);
  const spans = verified.map((event, index): RuntimeTraceSpanV4 => {
    const severities = { low: 0, medium: 0, high: 0, critical: 0 };
    for (const finding of event.findings ?? []) severities[finding.severity] += 1;
    const attributes: Record<string, string | number> = { sequence: event.sequence, evidence_count: event.evidence_hashes.length, ...event.counters };
    if (event.binding_ref !== undefined) attributes.binding_ref = event.binding_ref;
    if (event.sandbox_certification_hash !== undefined) attributes.sandbox_certification_hash = event.sandbox_certification_hash;
    for (const [severity, count] of Object.entries(severities)) if (count > 0) attributes[`finding_${severity}_count`] = count;
    return freeze({ trace_id: traceId, span_id: event.event_hash.slice(0, 16), parent_span_id: index === 0 ? null : verified[index - 1]!.event_hash.slice(0, 16), name: event.type, recorded_at: event.recorded_at, duration_ms: event.duration_ms ?? null, status: event.type === 'RUN_FAILED' || event.type === 'RUN_ABORTED' ? 'ERROR' : 'OK', attributes, evidence_hashes: [...event.evidence_hashes] });
  });
  const body = { schema_version: 4 as const, run_id: first.run_id, contract_hash: first.contract_hash, spans };
  return freeze({ ...body, trace_hash: hashCanonicalV4(body) });
}

export function evaluateRuntimeTrajectoryV4(input: { contract: RuntimeWorkContractV4; plan: IterativeStoryPlanV4; initial_tree_hash: string; story_events: readonly StoryIterationEventV4[]; runtime_events: readonly RuntimeEventV4[] }): RuntimeTrajectoryEvaluationV4 {
  const rules: TrajectoryRuleResultV4[] = [];
  let trace: RuntimeTraceExportV4 | null = null;
  try { trace = exportRuntimeTraceV4(input.runtime_events); rules.push({ rule_id: 'TELEMETRY_CHAIN', outcome: 'PASS', evidence_hashes: [trace.trace_hash] }); }
  catch { rules.push({ rule_id: 'TELEMETRY_CHAIN', outcome: 'FAIL', evidence_hashes: [] }); }
  const types = trace === null ? [] : input.runtime_events.map((event) => event.type);
  const terminal = new Set(['RUN_MERGED', 'PUBLICATION_SKIPPED', 'RUN_FAILED', 'RUN_ABORTED']);
  const terminalIndexes = types.flatMap((type, index) => terminal.has(type) ? [index] : []);
  const terminalPass = terminalIndexes.length <= 1 && (terminalIndexes.length === 0 || terminalIndexes[0] === types.length - 1);
  rules.push({ rule_id: 'TERMINAL_LAST', outcome: terminalPass ? 'PASS' : 'FAIL', evidence_hashes: terminalPass && trace !== null ? [trace.trace_hash] : [] });
  let activeExecutions = 0;
  let balanced = true;
  for (const type of types) { if (type === 'EXECUTION_STARTED') activeExecutions += 1; if (type === 'EXECUTION_COMPLETED') activeExecutions -= 1; if (activeExecutions < 0 || activeExecutions > 1) balanced = false; }
  if (activeExecutions !== 0) balanced = false;
  rules.push({ rule_id: 'EXECUTION_BALANCED', outcome: balanced ? 'PASS' : 'FAIL', evidence_hashes: balanced && trace !== null ? [trace.trace_hash] : [] });
  let lastValidation = -1;
  let lastReview = -1;
  let reviewOrder = true;
  let reviewActive = false;
  for (const [index, type] of types.entries()) {
    if (type === 'VALIDATION_RECORDED') lastValidation = index;
    if (type === 'REVIEW_STARTED') { if (reviewActive) reviewOrder = false; reviewActive = true; }
    if (type === 'REVIEW_COMPLETED') { if (!reviewActive || lastValidation <= lastReview) reviewOrder = false; reviewActive = false; lastReview = index; }
  }
  if (reviewActive) reviewOrder = false;
  rules.push({ rule_id: 'VALIDATION_BEFORE_REVIEW', outcome: reviewOrder ? 'PASS' : 'FAIL', evidence_hashes: reviewOrder && trace !== null ? [trace.trace_hash] : [] });
  let graph: RuntimeExecutionGraphV4 | null = null;
  try { graph = buildRuntimeExecutionGraphV4({ contract: input.contract, plan: input.plan, initial_tree_hash: input.initial_tree_hash, events: input.story_events }); rules.push({ rule_id: 'ITERATION_GRAPH', outcome: 'PASS', evidence_hashes: [graph.graph_hash] }); }
  catch { rules.push({ rule_id: 'ITERATION_GRAPH', outcome: 'FAIL', evidence_hashes: [] }); }
  const body = { schema_version: 4 as const, run_id: input.contract.run_id, outcome: rules.every((rule) => rule.outcome === 'PASS') ? 'PASS' as const : 'FAIL' as const, rules, graph_hash: graph?.graph_hash ?? null, trace_hash: trace?.trace_hash ?? null };
  return freeze({ ...body, evaluation_hash: hashCanonicalV4(body) });
}
