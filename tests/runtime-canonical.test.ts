import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJsonV4, hashCanonicalV4 } from '../src/runtime/canonical.js';

test('serializes object keys in a stable canonical order', () => {
  assert.equal(canonicalJsonV4({ z: [2, { b: true, a: null }], a: 'first' }), '{"a":"first","z":[2,{"a":null,"b":true}]}');
  assert.equal(hashCanonicalV4({ a: 'first', z: [2, { a: null, b: true }] }), hashCanonicalV4({ z: [2, { b: true, a: null }], a: 'first' }));
});
