import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseEmptyResponse } from '../src/providers/diagnose';
import type { StreamSummary } from '../src/providers/stream';

const summary = (over: Partial<StreamSummary> = {}): StreamSummary =>
  ({ finishReason: null, reasoningText: '', ...over });

test('a user-cancelled run says so and blames nothing', () => {
  const d = diagnoseEmptyResponse('m', summary(), true);
  assert.equal(d.kind, 'stopped');
  assert.doesNotMatch(d.message, /try a different/);
});

test('reasoning-only output is surfaced rather than reported as empty', () => {
  // The bug this fixes: a model that emits only chain of thought produced real
  // output, and telling the user to switch models is wrong advice.
  const d = diagnoseEmptyResponse('gemma', summary({ reasoningText: '  thinking hard  ' }), false);
  assert.equal(d.kind, 'reasoning-only');
  if (d.kind === 'reasoning-only') assert.equal(d.reasoning, 'thinking hard');
});

test('hitting the token limit points at the setting that caused it', () => {
  for (const reason of ['length', 'max_tokens']) {
    const d = diagnoseEmptyResponse('m', summary({ finishReason: reason }), false);
    assert.match(d.message, /Max tokens/);
    assert.doesNotMatch(d.message, /dead upstream/);
  }
});

test('a content filter is named as a refusal, not as a broken route', () => {
  const d = diagnoseEmptyResponse('m', summary({ finishReason: 'content_filter' }), false);
  assert.match(d.message, /content filter/);
});

test('an unrecognised stop reason is quoted rather than swallowed', () => {
  const d = diagnoseEmptyResponse('m', summary({ finishReason: 'tool_calls' }), false);
  assert.match(d.message, /"tool_calls"/);
});

test('only a truly silent run suggests changing model or endpoint', () => {
  const d = diagnoseEmptyResponse('google/gemma-4-e4b', summary(), false);
  assert.match(d.message, /google\/gemma-4-e4b/);
  assert.match(d.message, /different model or endpoint/);
});

test('reasoning outranks a stop reason, because it is actual output', () => {
  const d = diagnoseEmptyResponse('m', summary({ finishReason: 'length', reasoningText: 'partial' }), false);
  assert.equal(d.kind, 'reasoning-only');
});

test('whitespace-only reasoning is not mistaken for output', () => {
  const d = diagnoseEmptyResponse('m', summary({ reasoningText: '   \n  ' }), false);
  assert.equal(d.kind, 'explained');
});
