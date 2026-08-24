import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_PRESETS,
  allPresets,
  createPreset,
  deletePreset,
  findPreset,
  isBuiltin,
  presetEffect,
  updatePreset,
} from '../src/settings/presets';
import type { Preset } from '../src/settings/presets';

const custom: Preset[] = [{ id: 'c1', name: 'Mine', systemPrompt: 'be terse' }];

test('built-ins come first, then the user\'s own', () => {
  const all = allPresets(custom);
  assert.equal(all[0].id, BUILTIN_PRESETS[0].id);
  assert.equal(all[all.length - 1].id, 'c1');
});

test('every built-in has a name and a system prompt', () => {
  for (const p of BUILTIN_PRESETS) {
    assert.ok(p.name.length > 0);
    assert.ok((p.systemPrompt ?? '').length > 0, `${p.id} has nothing to apply`);
  }
});

test('built-ins are recognised so they cannot be edited away', () => {
  assert.equal(isBuiltin(BUILTIN_PRESETS[0].id), true);
  assert.equal(isBuiltin('c1'), false);
});

test('a preset changes only what it names', () => {
  // Picking "Summarize" must not silently move the user off their model.
  const effect = presetEffect({ id: 'x', name: 'X', systemPrompt: 'hello' });
  assert.equal(effect.systemPrompt, 'hello');
  assert.equal('model' in effect, false);
  assert.equal('provider' in effect, false);
  assert.equal(effect.includeCurrentNote, false);
});

test('a preset that pins a provider and model reports both', () => {
  const effect = presetEffect({ id: 'x', name: 'X', provider: 'anthropic', model: 'claude-opus-5' });
  assert.equal(effect.provider, 'anthropic');
  assert.equal(effect.model, 'claude-opus-5');
});

test('includeCurrentNote is always present, so the caller never guesses', () => {
  assert.equal(presetEffect({ id: 'x', name: 'X' }).includeCurrentNote, false);
  assert.equal(presetEffect({ id: 'x', name: 'X', includeCurrentNote: true }).includeCurrentNote, true);
});

test('creating a preset defaults the name and does not mutate the list', () => {
  const before: Preset[] = [];
  const after = createPreset(before, {}, 'n1');
  assert.equal(before.length, 0);
  assert.equal(after[0].name, 'New preset');
});

test('creating a preset preserves every optional field used by the editor', () => {
  const [preset] = createPreset([], {
    name: 'Editor',
    systemPrompt: '',
    provider: 'local',
    endpointId: 'ep1',
    model: 'gemma',
    maxTokens: 512,
    includeCurrentNote: false,
  }, 'p1');
  assert.deepEqual(preset, {
    id: 'p1',
    name: 'Editor',
    systemPrompt: '',
    provider: 'local',
    endpointId: 'ep1',
    model: 'gemma',
    maxTokens: 512,
    includeCurrentNote: false,
  });
});

test('updating patches only the named preset and never its id', () => {
  const out = updatePreset(custom, 'c1', { name: 'Renamed', id: 'hijack' });
  assert.equal(out[0].name, 'Renamed');
  assert.equal(out[0].id, 'c1');
});

test('deleting removes just that one, and findPreset tolerates a missing id', () => {
  assert.deepEqual(deletePreset(custom, 'c1'), []);
  assert.equal(findPreset(custom, 'c1')?.name, 'Mine');
  assert.equal(findPreset(custom, null), null);
  assert.equal(findPreset(custom, 'nope'), null);
});
