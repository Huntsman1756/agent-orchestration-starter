import assert from 'node:assert/strict';
import test from 'node:test';
import { createUnavailableV3TelemetryPortV4 } from '../src/runtime/v3-telemetry-port.js';

test('V3 absence is explicit and cannot alter committed V4 state', async () => {
  const port = createUnavailableV3TelemetryPortV4();
  const runState = { state: 'COMMITTED' };
  assert.equal(await port.available(), false);
  assert.deepEqual(await port.export([]), { status: 'UNAVAILABLE', reason: 'V3_RUNTIME_NOT_INSTALLED' });
  assert.equal(runState.state, 'COMMITTED');
});
