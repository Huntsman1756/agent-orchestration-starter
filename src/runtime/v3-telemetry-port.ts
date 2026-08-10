import type { RuntimeEventV4 } from './telemetry.js';

export type V3TelemetryExportResultV4 = Readonly<{ status: 'UNAVAILABLE'; reason: 'V3_RUNTIME_NOT_INSTALLED' }> | Readonly<{ status: 'EXPORTED'; exported_events: number }>;
export interface V3TelemetryPortV4 { available(): Promise<boolean>; export(events: readonly RuntimeEventV4[]): Promise<V3TelemetryExportResultV4>; }

export function createUnavailableV3TelemetryPortV4(): V3TelemetryPortV4 {
  return Object.freeze({ available: async () => false, export: async () => Object.freeze({ status: 'UNAVAILABLE', reason: 'V3_RUNTIME_NOT_INSTALLED' }) });
}
