export interface RequestIdentityV4 {
  request_hash: string;
  run_id: string;
}

export type RequestIndexV4 = Readonly<Record<string, RequestIdentityV4>>;

export interface RequestRegistrationV4 {
  index: RequestIndexV4;
  run_id: string;
  created: boolean;
}

function immutableIndex(index: RequestIndexV4): RequestIndexV4 {
  return Object.freeze(
    Object.fromEntries(Object.entries(index).map(([requestId, identity]) => [requestId, Object.freeze({ ...identity })])),
  );
}

export function registerRequestV4(index: RequestIndexV4, requestId: string, requestHash: string, runId: string): RequestRegistrationV4 {
  const existing = index[requestId];
  if (existing !== undefined) {
    if (existing.request_hash !== requestHash) {
      throw new Error(`INVALID_CONTRACT: request_id ${requestId} was already used for different canonical bytes`);
    }
    return Object.freeze({ index, run_id: existing.run_id, created: false });
  }
  const next = immutableIndex({ ...index, [requestId]: { request_hash: requestHash, run_id: runId } });
  return Object.freeze({ index: next, run_id: runId, created: true });
}

export function replayRequestIndexV4(records: readonly ({ request_id: string } & RequestIdentityV4)[]): RequestIndexV4 {
  let index: RequestIndexV4 = Object.freeze({});
  for (const record of records) {
    const existing = index[record.request_id];
    if (existing !== undefined && (existing.request_hash !== record.request_hash || existing.run_id !== record.run_id)) {
      throw new Error(`BROKER_STATE_CORRUPT: request_id ${record.request_id} has conflicting accepted records`);
    }
    index = registerRequestV4(index, record.request_id, record.request_hash, record.run_id).index;
  }
  return index;
}
