import test from 'node:test';
import assert from 'node:assert/strict';
import { formatToolResults, hasToolCalls, parseToolCalls } from '../src/agent/protocol';
import { TOOLS, describeTools, isAutoRunnable, toolRisk, validateCall } from '../src/agent/registry';
import type { ToolCall, ToolResult } from '../src/agent/types';

const ids = () => { let n = 0; return () => `c${++n}`; };
const normalize = (p: string): string =>
  p.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');

const call = (tool: string, args: Record<string, unknown> = {}): ToolCall =>
  ({ id: 'c1', tool, args, raw: '' });

const fence = (body: string) => '```tool\n' + body + '\n```';

// ── Protocol ────────────────────────────────────────────────────────────────

test('a single tool block parses', () => {
  const calls = parseToolCalls(fence('{"tool":"read_file","args":{"path":"a.md"}}'), ids());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'read_file');
  assert.deepEqual(calls[0].args, { path: 'a.md' });
});

test('several blocks in one reply all parse, in order', () => {
  const text = `first\n${fence('{"tool":"read_file","args":{"path":"a.md"}}')}\n`
             + `then\n${fence('{"tool":"get_backlinks","args":{"path":"b.md"}}')}`;
  assert.deepEqual(parseToolCalls(text, ids()).map(c => c.tool), ['read_file', 'get_backlinks']);
});

test('an array of calls in one block parses', () => {
  const calls = parseToolCalls(
    fence('[{"tool":"read_file","args":{"path":"a.md"}},{"tool":"read_file","args":{"path":"b.md"}}]'), ids());
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].id, calls[1].id, 'each call gets its own id');
});

test('the OpenAI-style name/arguments spelling is accepted too', () => {
  const calls = parseToolCalls(fence('{"name":"read_file","arguments":{"path":"a.md"}}'), ids());
  assert.equal(calls[0].tool, 'read_file');
  assert.deepEqual(calls[0].args, { path: 'a.md' });
});

test('a malformed block is skipped without losing the good ones', () => {
  // A model that truncates one block should still get its other work done.
  const text = fence('{"tool":"read_file", BROKEN')
             + '\n' + fence('{"tool":"get_links","args":{"path":"b.md"}}');
  assert.deepEqual(parseToolCalls(text, ids()).map(c => c.tool), ['get_links']);
});

test('blocks with no tool name are ignored', () => {
  assert.deepEqual(parseToolCalls(fence('{"args":{"path":"a.md"}}'), ids()), []);
  assert.deepEqual(parseToolCalls(fence('{"tool":"","args":{}}'), ids()), []);
});

test('missing args default to empty rather than crashing the parse', () => {
  const calls = parseToolCalls(fence('{"tool":"search_vault"}'), ids());
  assert.deepEqual(calls[0].args, {});
});

test('hasToolCalls detects work without parsing it', () => {
  assert.equal(hasToolCalls('plain prose'), false);
  assert.equal(hasToolCalls(fence('{"tool":"x"}')), true);
});

test('hasToolCalls is not confused by being called twice', () => {
  const text = fence('{"tool":"x"}');
  assert.equal(hasToolCalls(text), true);
  assert.equal(hasToolCalls(text), true, 'a sticky regex must not skip on the second call');
});

test('Gemma textual tool calls from LM Studio parse', () => {
  const text = '<|tool_call>call:search_vault{"query": "plain-text note-taking"}';
  const calls = parseToolCalls(text, ids());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'search_vault');
  assert.deepEqual(calls[0].args, { query: 'plain-text note-taking' });
  assert.equal(hasToolCalls(text), true);
});

test('Gemma textual tool calls accept the unquoted keys emitted by LM Studio', () => {
  const text = '<|tool_call>call:search_vault{query: "plain-text note-taking"}';
  const calls = parseToolCalls(text, ids());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'search_vault');
  assert.deepEqual(calls[0].args, { query: 'plain-text note-taking' });
});

test('a bare Gemma tool object parses only when it is the complete response', () => {
  const text = '{ "tool" : "search_vault" , "args" : { "query" : "plain-text note-taking" } }';
  const calls = parseToolCalls(text, ids());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'search_vault');
  assert.deepEqual(calls[0].args, { query: 'plain-text note-taking' });
  assert.equal(hasToolCalls(text), true);
  assert.equal(hasToolCalls(`Example tool object: ${text}`), false);
});

test('a complete JSON fence from Gemma is treated as a tool object', () => {
  const text = '```json\n{"tool":"search_vault","args":{"query":"plain-text note-taking"}}\n```';
  const calls = parseToolCalls(text, ids());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'search_vault');
  assert.equal(hasToolCalls(text), true);
  assert.equal(hasToolCalls(`Here is an example:\n${text}`), false);
});

test('Gemma textual tool calls preserve nested JSON arguments', () => {
  const text = '<|tool_call|>call:edit_file{"path":"a.md","replacement":{"old":"x","new":"y"}}';
  const calls = parseToolCalls(text, ids());
  assert.deepEqual(calls[0].args, {
    path: 'a.md',
    replacement: { old: 'x', new: 'y' },
  });
});

// ── Result formatting ───────────────────────────────────────────────────────

test('results come back as JSON the model can read', () => {
  const out = formatToolResults([{ ok: true, id: 'c1', tool: 'read_file', data: { path: 'a.md' } }]);
  assert.match(out, /<tool_results>/);
  assert.match(out, /\[read_file\]/);
  assert.match(out, /"path": "a.md"/);
});

test('errors report their kind, so the model can tell them apart', () => {
  const out = formatToolResults([
    { ok: false, id: 'c1', tool: 'read_file', error: { kind: 'not_found', message: 'no such note' } },
  ]);
  assert.match(out, /ERROR not_found: no such note/);
});

test('an ambiguous result lists the candidates to choose between', () => {
  const out = formatToolResults([
    { ok: false, id: 'c1', tool: 'find_file', error: {
      kind: 'ambiguous', message: 'two matches',
      candidates: [{ path: 'A.md', reason: 'exact filename' }, { path: 'B.md', reason: 'alias' }],
    } },
  ]);
  assert.match(out, /A\.md \(exact filename\)/);
  assert.match(out, /B\.md \(alias\)/);
});

test('an oversized result is truncated and says so', () => {
  const big: ToolResult = { ok: true, id: 'c1', tool: 'read_file', data: 'x'.repeat(9000) };
  const out = formatToolResults([big], 500);
  assert.ok(out.length < 2000);
  assert.match(out, /truncated/);
});

// ── Registry and risk ───────────────────────────────────────────────────────

test('reads run on their own; writes and deletes do not', () => {
  assert.equal(isAutoRunnable('read_file'), true);
  assert.equal(isAutoRunnable('search_vault'), true);
  assert.equal(isAutoRunnable('edit_file'), false);
  assert.equal(isAutoRunnable('delete_file'), false);
});

test('every deletion and every batch is classified destructive', () => {
  for (const name of ['delete_file', 'batch_delete', 'batch_move']) {
    assert.equal(toolRisk(name), 'destructive', `${name} must never auto-run`);
  }
});

test('no tool is left without a risk level', () => {
  for (const [name, def] of Object.entries(TOOLS)) {
    assert.ok(['read', 'write', 'destructive'].includes(def.risk), `${name} has no valid risk`);
    assert.equal(def.name, name, 'the key and the definition must agree');
  }
});

test('an unknown tool is refused and the real ones are listed', () => {
  const v = validateCall(call('teleport_file', {}), normalize);
  assert.equal(v.ok, false);
  if (!v.ok) {
    assert.equal(v.error.kind, 'unknown_tool');
    assert.match(v.error.message, /read_file/);
  }
});

test('a missing required argument is refused with the parameter description', () => {
  const v = validateCall(call('read_file', {}), normalize);
  assert.equal(v.ok, false);
  if (!v.ok) {
    assert.equal(v.error.kind, 'invalid_args');
    assert.match(v.error.message, /path/);
  }
});

test('an argument of the wrong type is refused', () => {
  const v = validateCall(call('read_file', { path: 42 }), normalize);
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.error.message, /must be string/);
});

test('optional arguments may be omitted', () => {
  const v = validateCall(call('create_file', { path: 'a.md' }), normalize);
  assert.equal(v.ok, true);
  if (v.ok) assert.equal(v.args.content, undefined);
});

// ── The path guarantee ──────────────────────────────────────────────────────

test('a path escaping the vault is refused, however it is written', () => {
  for (const bad of ['../outside.md', 'a/../../b.md', '../../etc/passwd']) {
    const v = validateCall(call('read_file', { path: bad }), normalize);
    assert.equal(v.ok, false, `${bad} must be refused`);
    if (!v.ok) assert.equal(v.error.kind, 'invalid_args');
  }
});

test('paths are normalised before use, so a tool never sees a raw model string', () => {
  const v = validateCall(call('read_file', { path: '  School//Networking.md  ' }), normalize);
  assert.equal(v.ok, true);
  if (v.ok) assert.equal(v.args.path, 'School/Networking.md');
});

test('every path in a batch is checked, not just the first', () => {
  const v = validateCall(call('batch_delete', { paths: ['ok.md', '../escape.md'] }), normalize);
  assert.equal(v.ok, false, 'one bad path poisons the whole batch');
});

test('a valid batch is normalised element by element', () => {
  const v = validateCall(call('batch_move', { paths: ['/a.md', 'b//c.md'], destFolder: 'Dest' }), normalize);
  assert.equal(v.ok, true);
  if (v.ok) assert.deepEqual(v.args.paths, ['a.md', 'b/c.md']);
});

test('the vault root is a legal folder argument', () => {
  const v = validateCall(call('list_folder', { path: '' }), normalize);
  assert.equal(v.ok, true);
  if (v.ok) assert.equal(v.args.path, '');
});

test('describeTools lists every tool with its risk, for the system prompt', () => {
  const desc = describeTools();
  for (const name of Object.keys(TOOLS)) assert.match(desc, new RegExp(name));
  assert.match(desc, /\[destructive\]/);
});
