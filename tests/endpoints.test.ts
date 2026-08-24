import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEndpoint,
  deleteEndpoint,
  duplicateEndpoint,
  endpointNameFromUrl,
  endpointSecretId,
  findEndpoint,
  migrateLocalEndpoint,
  resolveActiveEndpoint,
  sanitizeHeaders,
  updateEndpoint,
  validateBaseUrl,
} from '../src/endpoints/manager';
import { DEFAULT_LOCAL_BASE_URL, LEGACY_LOCAL_ENDPOINT_ID } from '../src/endpoints/types';
import type { LegacyLocalShape } from '../src/endpoints/manager';
import type { OpenAICompatibleEndpoint } from '../src/endpoints/types';

const ep = (over: Partial<OpenAICompatibleEndpoint> = {}): OpenAICompatibleEndpoint => ({
  id: 'e1', name: 'One', baseUrl: 'http://127.0.0.1:11434', enabled: true, ...over,
});

// ── Secret ids ──────────────────────────────────────────────────────────────

test('the migrated legacy endpoint keeps the pre-2.0 secret id so the saved key survives', () => {
  assert.equal(endpointSecretId(LEGACY_LOCAL_ENDPOINT_ID), 'vaultchat-local');
});

test('other endpoints get their own secret id, and it is a legal secret id', () => {
  const id = endpointSecretId('abc123');
  assert.equal(id, 'vaultchat-endpoint-abc123');
  assert.match(id, /^[a-z0-9-]+$/);
});

test('two endpoints never share a secret id', () => {
  assert.notEqual(endpointSecretId('aaa'), endpointSecretId('bbb'));
});

// ── Naming ──────────────────────────────────────────────────────────────────

test('endpointNameFromUrl recognises the common local servers by port', () => {
  assert.equal(endpointNameFromUrl('http://127.0.0.1:11434'), 'Ollama');
  assert.equal(endpointNameFromUrl('http://127.0.0.1:1234'),  'LM Studio');
  assert.equal(endpointNameFromUrl('http://localhost:8000'),  'vLLM');
});

test('endpointNameFromUrl falls back to host:port, and never throws on junk', () => {
  assert.equal(endpointNameFromUrl('http://example.com:9999'), 'example.com:9999');
  assert.equal(endpointNameFromUrl('https://api.example.com'), 'api.example.com');
  assert.equal(endpointNameFromUrl('not a url'), 'New endpoint');
});

// ── URL validation ──────────────────────────────────────────────────────────

test('validateBaseUrl accepts http and https and strips trailing slashes', () => {
  assert.deepEqual(validateBaseUrl('http://127.0.0.1:11434/'), { ok: true, url: 'http://127.0.0.1:11434' });
  assert.deepEqual(validateBaseUrl('  https://x.dev/v1//  '),  { ok: true, url: 'https://x.dev/v1' });
});

test('validateBaseUrl rejects empty, malformed and non-http schemes', () => {
  assert.equal(validateBaseUrl('').ok, false);
  assert.equal(validateBaseUrl('   ').ok, false);
  assert.equal(validateBaseUrl('127.0.0.1:11434').ok, false);
  assert.equal(validateBaseUrl('file:///etc/passwd').ok, false);
  assert.equal(validateBaseUrl('javascript:alert(1)').ok, false);
});

test('validateBaseUrl explains why, so the message can go straight to the user', () => {
  const r = validateBaseUrl('ftp://h/x');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /ftp/);
});

// ── Header sanitising ───────────────────────────────────────────────────────

test('sanitizeHeaders passes ordinary custom headers through', () => {
  assert.deepEqual(
    sanitizeHeaders({ 'X-Org': 'acme', 'X-Trace-Id': '42' }),
    { 'X-Org': 'acme', 'X-Trace-Id': '42' },
  );
});

test('sanitizeHeaders drops headers this plugin sets itself', () => {
  const out = sanitizeHeaders({
    Authorization: 'Bearer stolen', 'content-type': 'text/plain', 'Content-Length': '0', Host: 'evil',
    'X-Keep': 'yes',
  });
  assert.deepEqual(out, { 'X-Keep': 'yes' });
});

test('sanitizeHeaders drops CRLF injection in names and values', () => {
  const out = sanitizeHeaders({
    'X-Bad\r\nInjected': 'v',
    'X-Also': 'line1\r\nX-Smuggled: 1',
    'X-Fine': 'ok',
  });
  assert.deepEqual(out, { 'X-Fine': 'ok' });
});

test('sanitizeHeaders handles an absent map', () => {
  assert.deepEqual(sanitizeHeaders(undefined), {});
});

// ── CRUD ────────────────────────────────────────────────────────────────────

test('createEndpoint appends and names from the URL when no name is given', () => {
  const list = createEndpoint([], { baseUrl: 'http://127.0.0.1:1234' }, 'n1');
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'n1');
  assert.equal(list[0].name, 'LM Studio');
  assert.equal(list[0].enabled, true);
});

test('createEndpoint keeps an explicit name and trims the URL', () => {
  const list = createEndpoint([], { name: '  Work box  ', baseUrl: 'http://h:1/' }, 'n1');
  assert.equal(list[0].name, 'Work box');
  assert.equal(list[0].baseUrl, 'http://h:1');
});

test('createEndpoint does not mutate the array it was given', () => {
  const before: OpenAICompatibleEndpoint[] = [];
  createEndpoint(before, { baseUrl: 'http://h:1' }, 'n1');
  assert.equal(before.length, 0);
});

test('updateEndpoint patches only the named endpoint and never its id', () => {
  const list = [ep({ id: 'a' }), ep({ id: 'b', name: 'Two' })];
  const out  = updateEndpoint(list, 'b', { name: 'Renamed', id: 'hijack' });
  assert.equal(out[0].name, 'One');
  assert.equal(out[1].name, 'Renamed');
  assert.equal(out[1].id, 'b');
});

test('deleteEndpoint removes just that one', () => {
  const out = deleteEndpoint([ep({ id: 'a' }), ep({ id: 'b' })], 'a');
  assert.deepEqual(out.map(e => e.id), ['b']);
});

test('duplicateEndpoint inserts the copy directly after the original', () => {
  const list = [ep({ id: 'a', name: 'A' }), ep({ id: 'b', name: 'B' })];
  const out  = duplicateEndpoint(list, 'a', 'a2');
  assert.deepEqual(out.map(e => e.id), ['a', 'a2', 'b']);
  assert.equal(out[1].name, 'A copy');
  assert.equal(out[1].baseUrl, list[0].baseUrl);
});

test('duplicateEndpoint is a no-op for an unknown id', () => {
  const list = [ep({ id: 'a' })];
  assert.deepEqual(duplicateEndpoint(list, 'nope', 'x'), list);
});

test('findEndpoint tolerates a null or missing id', () => {
  const list = [ep({ id: 'a' })];
  assert.equal(findEndpoint(list, 'a')?.id, 'a');
  assert.equal(findEndpoint(list, null), null);
  assert.equal(findEndpoint(list, 'zzz'), null);
});

// ── Active endpoint resolution ──────────────────────────────────────────────

test('resolveActiveEndpoint returns the selected endpoint when it is enabled', () => {
  const list = [ep({ id: 'a' }), ep({ id: 'b' })];
  assert.equal(resolveActiveEndpoint(list, 'b')?.id, 'b');
});

test('resolveActiveEndpoint falls back when the selection was deleted or disabled', () => {
  const list = [ep({ id: 'a' }), ep({ id: 'b', enabled: false })];
  assert.equal(resolveActiveEndpoint(list, 'b')?.id, 'a', 'disabled selection falls back');
  assert.equal(resolveActiveEndpoint(list, 'gone')?.id, 'a', 'deleted selection falls back');
});

test('resolveActiveEndpoint returns null rather than a disabled endpoint', () => {
  assert.equal(resolveActiveEndpoint([ep({ id: 'a', enabled: false })], 'a'), null);
  assert.equal(resolveActiveEndpoint([], 'a'), null);
});

// ── Migration ───────────────────────────────────────────────────────────────

test('migrateLocalEndpoint carries a pre-2.0 local server across', () => {
  const saved: LegacyLocalShape = { providers: { local: { baseUrl: 'http://127.0.0.1:1234', model: 'qwen3' } } };
  migrateLocalEndpoint(saved);
  assert.equal(saved.endpoints?.length, 1);
  assert.equal(saved.endpoints?.[0].id, LEGACY_LOCAL_ENDPOINT_ID);
  assert.equal(saved.endpoints?.[0].baseUrl, 'http://127.0.0.1:1234');
  assert.equal(saved.endpoints?.[0].defaultModel, 'qwen3');
  assert.equal(saved.endpoints?.[0].name, 'LM Studio');
  assert.equal(saved.activeEndpointId, LEGACY_LOCAL_ENDPOINT_ID);
});

test('migrateLocalEndpoint uses the default URL when the install never set one', () => {
  const saved: LegacyLocalShape = { providers: {} };
  migrateLocalEndpoint(saved);
  assert.equal(saved.endpoints?.[0].baseUrl, DEFAULT_LOCAL_BASE_URL);
  assert.equal(saved.endpoints?.[0].defaultModel, undefined);
});

test('migrateLocalEndpoint is idempotent and never resurrects deleted endpoints', () => {
  const saved: LegacyLocalShape =
    { endpoints: [], activeEndpointId: null, providers: { local: { baseUrl: 'http://h:1' } } };
  migrateLocalEndpoint(saved);
  assert.deepEqual(saved.endpoints, [], 'an empty list is a real state, not an unmigrated one');

  const once: LegacyLocalShape = { providers: { local: { baseUrl: 'http://h:1' } } };
  migrateLocalEndpoint(once);
  const first = once.endpoints;
  migrateLocalEndpoint(once);
  assert.equal(once.endpoints, first, 'second run leaves the array untouched');
});

test('migrateLocalEndpoint tolerates null saved data', () => {
  assert.doesNotThrow(() => { migrateLocalEndpoint(null); });
  assert.doesNotThrow(() => { migrateLocalEndpoint(undefined); });
});

test('the migrated endpoint resolves the same API key the old install stored', () => {
  const saved: LegacyLocalShape = { providers: { local: { baseUrl: 'http://127.0.0.1:11434' } } };
  migrateLocalEndpoint(saved);
  assert.equal(endpointSecretId(saved.endpoints?.[0].id ?? ''), 'vaultchat-local');
});
