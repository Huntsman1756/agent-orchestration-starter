// Deterministic loader fixture only. It deliberately does not hold credentials,
// start a daemon or publish anything. A production driver must replace these
// operations with separately certified host components and native coordination.
export function createRuntimeHostDriverV4(context) {
  const componentIds = Object.freeze(Object.keys(context.components));
  return Object.freeze({
    daemon: async () => {
      throw new Error('CAPABILITY_UNVERIFIED: reference driver has no production daemon');
    },
    mcpStdio: async () => {
      throw new Error('CAPABILITY_UNVERIFIED: reference driver has no production MCP composition');
    },
    doctor: async () => Object.freeze(['reference-only host driver', `components: ${componentIds.join(',')}`]),
    status: async (runId) => Object.freeze({ run_id: runId, state: 'REFERENCE_COMPONENTS_LOADED', components: componentIds }),
  });
}
