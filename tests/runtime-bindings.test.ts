import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveBinding } from '../src/runtime/bindings.js';
import type { RuntimeProfileV4 } from '../src/runtime/contracts.js';
import { validRuntimeProfile } from './runtime-contracts.test.js';

test('resolves the economy executor binding from the profile', () => {
  const profile = validRuntimeProfile();
  profile.bindings.executor.model = 'economy-coder';

  const binding = resolveBinding({ profile: profile as RuntimeProfileV4, route: 'ECONOMY', sourceSensitivity: 'PUBLIC' });

  assert.equal(binding.role, 'executor');
  assert.equal(binding.binding.model, 'economy-coder');
  assert.equal(Object.isFrozen(binding.binding.guidance), true);
  assert.equal(Object.isFrozen(binding.binding.guidance.instructions), true);
  assert.throws(() => { (binding.binding.guidance as { id: string }).id = 'mutated'; }, /read only|Cannot assign/i);
});

test('resolves the distinct economy escalation binding from the profile', () => {
  const profile = validRuntimeProfile();
  profile.bindings.executor.model = 'economy-coder';
  profile.bindings.escalationExecutor.model = 'escalation-coder';

  const binding = resolveBinding({ profile: profile as RuntimeProfileV4, route: 'ECONOMY', stage: 'ESCALATION', sourceSensitivity: 'PUBLIC' });

  assert.equal(binding.role, 'escalationExecutor');
  assert.equal(binding.binding.model, 'escalation-coder');
});

test('rejects an escalation stage on a direct frontier route', () => {
  assert.throws(
    () => resolveBinding({ profile: validRuntimeProfile() as RuntimeProfileV4, route: 'FRONTIER', stage: 'ESCALATION', sourceSensitivity: 'PUBLIC' }),
    /INVALID_CONTRACT/u,
  );
});

test('fails closed when a direct frontier route has no frontier executor binding', () => {
  const profile = validRuntimeProfile();
  delete (profile.bindings as Partial<RuntimeProfileV4['bindings']>).frontierExecutor;

  assert.throws(
    () => resolveBinding({ profile: profile as RuntimeProfileV4, route: 'FRONTIER', sourceSensitivity: 'PUBLIC' }),
    /INVALID_CONTRACT: required frontierExecutor binding is unavailable/u,
  );
});

test('rejects a route whose selected binding cannot process private source', () => {
  const profile = validRuntimeProfile();

  assert.throws(
    () => resolveBinding({ profile: profile as RuntimeProfileV4, route: 'ECONOMY', sourceSensitivity: 'PRIVATE' }),
    /SOURCE_SENSITIVITY_UNSUPPORTED/,
  );
});
