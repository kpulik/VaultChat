import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/settings/types';

test('malformed persisted safety and preset values fall back safely', () => {
  const settings = normalizeSettings({
    protectedPaths: 'Templates' as unknown as string[],
    ignoredPaths: ['.trash', 42] as unknown as string[],
    contextMaxTokens: -1,
    maxTokens: Number.NaN,
    presets: [null, { id: 'p1', name: 'Custom', systemPrompt: '' }] as unknown as never[],
  });
  assert.deepEqual(settings.protectedPaths, DEFAULT_SETTINGS.protectedPaths);
  assert.deepEqual(settings.ignoredPaths, ['.trash']);
  assert.equal(settings.contextMaxTokens, DEFAULT_SETTINGS.contextMaxTokens);
  assert.equal(settings.maxTokens, DEFAULT_SETTINGS.maxTokens);
  assert.deepEqual(settings.presets, [{ id: 'p1', name: 'Custom', systemPrompt: '' }]);
});

test('dynamic current-note context is opt-in and malformed values default off', () => {
  assert.equal(normalizeSettings(null).dynamicCurrentNote, false);
  assert.equal(normalizeSettings({ dynamicCurrentNote: true }).dynamicCurrentNote, true);
  assert.equal(normalizeSettings({ dynamicCurrentNote: 'yes' as unknown as boolean }).dynamicCurrentNote, false);
});

test('missing provider blocks are filled without losing the migrated local values', () => {
  const settings = normalizeSettings({
    providers: {
      local: { apiKey: 'legacy', model: 'gemma', baseUrl: 'http://127.0.0.1:1234' },
    } as never,
  });
  assert.equal(settings.providers.local.apiKey, 'legacy');
  assert.equal(settings.providers.local.model, 'gemma');
  assert.equal(settings.providers.anthropic.model, DEFAULT_SETTINGS.providers.anthropic.model);
  assert.equal(settings.endpoints[0].baseUrl, 'http://127.0.0.1:1234');
});
