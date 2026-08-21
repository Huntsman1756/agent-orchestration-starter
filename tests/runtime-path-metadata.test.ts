import assert from 'node:assert/strict';
import test from 'node:test';

import { parseLinuxMountIdentityV4 } from '../src/runtime/path-policy.js';

test('selects the deepest Linux mount identity including a root mount', () => {
  const mountinfo = ['36 25 0:32 / / rw,relatime - ext4 /dev/root rw', '42 36 0:32 / /repo/src rw,relatime - none /repo/src rw'].join('\n');

  assert.equal(parseLinuxMountIdentityV4('/other/file.ts', mountinfo), '36:0:32');
  assert.equal(parseLinuxMountIdentityV4('/repo/src/file.ts', mountinfo), '42:0:32');
});
