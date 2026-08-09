import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse } from 'yaml';

import { loadPilotEventV3, loadPilotManifestV3, loadPilotRoutingGateV3 } from '../src/pilot/load.js';
import { verifyManifest } from '../src/pilot/manifest.js';

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`../examples/${name}`, import.meta.url), 'utf8');
}

async function jsonSchema(name: string) {
  return JSON.parse(await readFile(new URL(`../contracts/${name}`, import.meta.url), 'utf8')) as object;
}

test('routing gate example is manifest-bound and valid in Zod and JSON Schema', async () => {
  const manifest = loadPilotManifestV3(parse(await fixture('pilot-manifest-v3.yaml')));
  assert.equal(verifyManifest(manifest).ok, true);
  const rawGate = parse(await fixture('pilot-routing-gate-v3.yaml'));
  const gate = loadPilotRoutingGateV3(rawGate);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  assert.equal(ajv.compile(await jsonSchema('pilot-routing-gate-v3.schema.json'))(rawGate), true);
  assert.deepEqual([gate.pilot_id, gate.manifest_hash], [manifest.pilot_id, manifest.manifest_hash]);
  assert.equal(gate.thresholds.interval_algorithm_version, manifest.stage_thresholds.interval_algorithm_version);
  assert.deepEqual(gate.strata_policy.map(value => value.matching_stratum),
    [...new Set(manifest.blocks.map(block => block.matching_stratum))].sort());
});

test('event JSONL example contains independently schema-valid provider-neutral events', async () => {
  const manifest = loadPilotManifestV3(parse(await fixture('pilot-manifest-v3.yaml')));
  const lines = (await fixture('pilot-events-v3.jsonl')).split(/\r?\n/u).filter(line => line.trim().length > 0);
  assert.ok(lines.length > 0);
  const schema = await jsonSchema('pilot-event-v3.schema.json');
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  for (const line of lines) {
    const raw = JSON.parse(line) as unknown;
    const event = loadPilotEventV3(raw);
    assert.equal(validate(raw), true, JSON.stringify(validate.errors));
    assert.deepEqual([event.pilot_id, event.manifest_hash], [manifest.pilot_id, manifest.manifest_hash]);
  }
  const serialized = lines.join('\n');
  assert.doesNotMatch(serialized, /(?:provider|model|openai|anthropic|arli|gpt|claude)/iu);
});
