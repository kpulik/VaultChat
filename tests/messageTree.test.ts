import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activePath,
  appendMessage,
  branchFrom,
  branchPosition,
  childrenOf,
  conversationToMarkdown,
  deepestLeaf,
  deleteSubtree,
  descendantIds,
  pathToRoot,
  repairActiveLeaf,
  siblingsOf,
  switchToBranch,
  toWireMessages,
  updateMessage,
} from '../src/chat/messageTree';
import { migrateSession } from '../src/chat/migrate';
import type { ChatSession, Message } from '../src/chat/types';

// Deterministic id source, so a migration produces the same tree every run.
const ids = () => { let n = 0; return () => `m${++n}`; };

const msg = (over: Partial<Message> & { id: string }): Message => ({
  parentId: null, role: 'user', content: '', createdAt: 0, ...over,
});

/**
 *   u1 ── a1 ── u2 ── a2
 *    └──── a1b (regenerated reply)
 */
const forked = (): Message[] => [
  msg({ id: 'u1',  parentId: null, role: 'user',      content: 'hello',   createdAt: 1 }),
  msg({ id: 'a1',  parentId: 'u1', role: 'assistant', content: 'first',   createdAt: 2 }),
  msg({ id: 'a1b', parentId: 'u1', role: 'assistant', content: 'second',  createdAt: 3 }),
  msg({ id: 'u2',  parentId: 'a1', role: 'user',      content: 'more',    createdAt: 4 }),
  msg({ id: 'a2',  parentId: 'u2', role: 'assistant', content: 'reply 2', createdAt: 5 }),
];

const session = (messages: Message[], activeLeafId: string | null): ChatSession => ({
  version: 2, id: 's1', createdAt: 0, updatedAt: 0, title: 'T',
  provider: 'local', model: 'm', attachedFiles: [], messages, activeLeafId,
});

// ── Traversal ───────────────────────────────────────────────────────────────

test('childrenOf returns direct children oldest first, and roots for null', () => {
  const t = forked();
  assert.deepEqual(childrenOf(t, 'u1').map(m => m.id), ['a1', 'a1b']);
  assert.deepEqual(childrenOf(t, null).map(m => m.id), ['u1']);
  assert.deepEqual(childrenOf(t, 'a2'), []);
});

test('pathToRoot walks root-to-node', () => {
  assert.deepEqual(pathToRoot(forked(), 'a2').map(m => m.id), ['u1', 'a1', 'u2', 'a2']);
});

test('pathToRoot returns nothing for an unknown or null id', () => {
  assert.deepEqual(pathToRoot(forked(), 'nope'), []);
  assert.deepEqual(pathToRoot(forked(), null), []);
});

test('pathToRoot terminates on a corrupt parent cycle instead of hanging', () => {
  // A hand-edited or truncated session file can link two messages to each other.
  const cyclic = [
    msg({ id: 'x', parentId: 'y', createdAt: 1 }),
    msg({ id: 'y', parentId: 'x', createdAt: 2 }),
  ];
  const path = pathToRoot(cyclic, 'x');
  assert.equal(path.length, 2, 'each node is visited once');
});

test('deepestLeaf descends to a branch tip, taking the newest child', () => {
  assert.equal(deepestLeaf(forked(), 'u1'), 'a1b', 'a1b is newer than a1');
  assert.equal(deepestLeaf(forked(), 'a1'), 'a2');
  assert.equal(deepestLeaf(forked(), 'a2'), 'a2', 'a leaf is its own tip');
});

test('descendantIds collects the whole subtree and excludes the node itself', () => {
  assert.deepEqual([...descendantIds(forked(), 'a1')].sort(), ['a2', 'u2']);
  assert.deepEqual([...descendantIds(forked(), 'a2')], []);
});

test('activePath renders only the branch that is on screen', () => {
  assert.deepEqual(activePath(session(forked(), 'a2')).map(m => m.id), ['u1', 'a1', 'u2', 'a2']);
  assert.deepEqual(activePath(session(forked(), 'a1b')).map(m => m.id), ['u1', 'a1b']);
  assert.deepEqual(activePath(session(forked(), null)), []);
});

// ── Siblings and branch counters ────────────────────────────────────────────

test('siblingsOf includes the message itself', () => {
  assert.deepEqual(siblingsOf(forked(), 'a1').map(m => m.id), ['a1', 'a1b']);
});

test('branchPosition reports which alternative is showing', () => {
  assert.deepEqual(branchPosition(forked(), 'a1'),  { index: 0, count: 2 });
  assert.deepEqual(branchPosition(forked(), 'a1b'), { index: 1, count: 2 });
});

test('branchPosition reports a single branch when nothing was forked', () => {
  assert.deepEqual(branchPosition(forked(), 'u2'), { index: 0, count: 1 });
});

// ── Mutation ────────────────────────────────────────────────────────────────

test('appendMessage does not mutate the array it was given', () => {
  const before = forked();
  const after = appendMessage(before, {
    id: 'n1', parentId: 'a2', role: 'user', content: 'next', createdAt: 6,
  });
  assert.equal(before.length, 5);
  assert.equal(after.length, 6);
});

test('updateMessage patches content but never id or parentId', () => {
  const out = updateMessage(forked(), 'a1', {
    content: 'edited', status: 'complete', id: 'hijack', parentId: 'hijack',
  } as Partial<Message>);
  const a1 = out.find(m => m.id === 'a1');
  assert.equal(a1?.content, 'edited');
  assert.equal(a1?.parentId, 'u1');
});

// ── Branching: the guarantee that nothing is destroyed ──────────────────────

test('regenerating a reply adds a sibling and keeps the original', () => {
  const t = forked();
  const { messages, created } = branchFrom(t, 'a1', {
    id: 'a1c', role: 'assistant', content: 'third', createdAt: 6,
  });
  assert.equal(created?.parentId, 'u1', 'the alternative hangs off the same parent');
  assert.ok(messages.find(m => m.id === 'a1'), 'the original reply is still there');
  assert.deepEqual(branchPosition(messages, 'a1c'), { index: 2, count: 3 });
});

test('editing a user message branches rather than overwriting', () => {
  const t = forked();
  const { messages, created } = branchFrom(t, 'u2', {
    id: 'u2b', role: 'user', content: 'asked differently', createdAt: 7,
  });
  assert.equal(created?.parentId, 'a1');
  const original = messages.find(m => m.id === 'u2');
  assert.equal(original?.content, 'more', 'the original wording survives');
  assert.deepEqual(descendantIds(messages, 'u2'), new Set(['a2']),
    'and so does the reply underneath it');
});

test('branchFrom is a no-op for an unknown id', () => {
  const t = forked();
  const { messages, created } = branchFrom(t, 'ghost', {
    id: 'x', role: 'user', content: '', createdAt: 9,
  });
  assert.equal(created, null);
  assert.equal(messages, t);
});

// ── Branch switching ────────────────────────────────────────────────────────

test('switchToBranch lands on that branch tip, not on the clicked message', () => {
  const s = session(forked(), 'a1b');
  assert.equal(switchToBranch(s, 'a1').activeLeafId, 'a2');
});

test('switchToBranch ignores an id that is not in the session', () => {
  const s = session(forked(), 'a2');
  assert.equal(switchToBranch(s, 'ghost'), s);
});

// ── Deletion ────────────────────────────────────────────────────────────────

test('deleteSubtree removes the message and everything below it', () => {
  const out = deleteSubtree(forked(), 'a1');
  assert.deepEqual(out.map(m => m.id).sort(), ['a1b', 'u1']);
});

test('deleteSubtree leaves other branches alone', () => {
  const out = deleteSubtree(forked(), 'a1b');
  assert.deepEqual(out.map(m => m.id).sort(), ['a1', 'a2', 'u1', 'u2']);
});

test('repairActiveLeaf rescues a session whose active leaf was deleted', () => {
  const messages = deleteSubtree(forked(), 'a1');
  const fixed = repairActiveLeaf(session(messages, 'a2'));
  assert.equal(fixed.activeLeafId, 'a1b', 'falls back to a leaf that still exists');
  assert.ok(activePath(fixed).length > 0, 'and the chat is not left blank');
});

test('repairActiveLeaf leaves a valid pointer untouched', () => {
  const s = session(forked(), 'a2');
  assert.equal(repairActiveLeaf(s), s);
});

test('repairActiveLeaf nulls the pointer for an empty session', () => {
  assert.equal(repairActiveLeaf(session([], 'stale')).activeLeafId, null);
});

// ── Wire format ─────────────────────────────────────────────────────────────

test('toWireMessages sends only role and content', () => {
  const wire = toWireMessages(activePath(session(forked(), 'a1b')));
  assert.deepEqual(wire, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'second' },
  ]);
  assert.deepEqual(Object.keys(wire[0]), ['role', 'content'],
    'no id, parentId or createdAt reaches the provider');
});

test('toWireMessages omits failed and cancelled turns', () => {
  const path: Message[] = [
    msg({ id: 'u', role: 'user', content: 'hi', createdAt: 1 }),
    msg({ id: 'e', role: 'assistant', content: '⚠ API 500', createdAt: 2, status: 'error' }),
    msg({ id: 'c', role: 'assistant', content: 'half a th', createdAt: 3, status: 'cancelled' }),
  ];
  assert.deepEqual(toWireMessages(path), [{ role: 'user', content: 'hi' }]);
});

test('toWireMessages drops system turns, which travel in their own field', () => {
  const path = [msg({ id: 's', role: 'system', content: 'be terse', createdAt: 1 })];
  assert.deepEqual(toWireMessages(path), []);
});

// ── Markdown export ─────────────────────────────────────────────────────────

test('conversationToMarkdown exports the visible branch only', () => {
  const md = conversationToMarkdown(session(forked(), 'a1b'));
  assert.match(md, /^# T\n/);
  assert.match(md, /## User\n\nhello/);
  assert.match(md, /## Assistant\n\nsecond/);
  assert.doesNotMatch(md, /first/, 'the branch that is not showing is not exported');
});

// ── Migration ───────────────────────────────────────────────────────────────

const legacy = {
  id: 'old1', createdAt: 1000, updatedAt: 2000, title: 'Old chat',
  provider: 'local', model: 'qwen3', attachedFiles: ['a.md'],
  messages: [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
  ],
};

test('a pre-2.0 session becomes one unbranched path with nothing lost', () => {
  const s = migrateSession(legacy, ids());
  assert.ok(s);
  assert.equal(s.version, 2);
  assert.equal(s.messages.length, 3);
  assert.deepEqual(activePath(s).map(m => m.content), ['q1', 'a1', 'q2'],
    'order and content survive');
  assert.equal(s.messages[0].parentId, null);
  assert.equal(s.messages[1].parentId, s.messages[0].id);
  assert.equal(s.activeLeafId, s.messages[2].id);
});

test('migration keeps the session metadata a user can see', () => {
  const s = migrateSession(legacy, ids());
  assert.equal(s?.title, 'Old chat');
  assert.equal(s?.model, 'qwen3');
  assert.deepEqual(s?.attachedFiles, ['a.md']);
  assert.equal(s?.createdAt, 1000);
  assert.deepEqual(s?.contextSources, [{ kind: 'file', path: 'a.md' }]);
});

test('v2 migration preserves valid per-chat context and generation settings', () => {
  const current = {
    ...migrateSession(legacy, ids())!,
    contextSources: [
      { kind: 'current-note' },
      { kind: 'folder', path: 'Guides', recursive: true },
      { kind: 'file', path: 42 },
    ],
    systemPrompt: 'Per-chat prompt',
    maxTokens: 900,
  };
  const restored = migrateSession(current, ids());
  assert.deepEqual(restored?.contextSources, [
    { kind: 'current-note' },
    { kind: 'folder', path: 'Guides', recursive: true },
  ]);
  assert.equal(restored?.systemPrompt, 'Per-chat prompt');
  assert.equal(restored?.maxTokens, 900);
});

test('v2 migration preserves archive state without treating arbitrary values as true', () => {
  const migrated = migrateSession({ ...legacy, version: 2, messages: [], activeLeafId: null,
    archived: true }, ids());
  assert.equal(migrated?.archived, true);
  const normalized = migrateSession({ ...legacy, version: 2, messages: [], activeLeafId: null,
    archived: 'yes' }, ids());
  assert.equal(normalized?.archived, false);
});

test('migrated messages get distinct increasing timestamps so ordering is stable', () => {
  const s = migrateSession(legacy, ids());
  const times = s?.messages.map(m => m.createdAt) ?? [];
  assert.deepEqual(times, [1000, 1001, 1002]);
  assert.equal(new Set(times).size, times.length, 'no two collide');
});

test('an already-migrated session is passed through, not migrated twice', () => {
  const once = migrateSession(legacy, ids());
  const twice = migrateSession(JSON.parse(JSON.stringify(once)) as unknown, ids());
  assert.deepEqual(twice?.messages.map(m => m.id), once?.messages.map(m => m.id),
    'ids are stable across reloads');
});

test('migration repairs a v2 session with a dangling active leaf', () => {
  const broken = { ...migrateSession(legacy, ids())!, activeLeafId: 'does-not-exist' };
  const fixed = migrateSession(broken, ids());
  assert.ok(fixed?.activeLeafId);
  assert.ok(fixed.messages.some(m => m.id === fixed.activeLeafId));
});

test('migration rejects junk rather than throwing', () => {
  assert.equal(migrateSession(null, ids()), null);
  assert.equal(migrateSession('nope', ids()), null);
  assert.equal(migrateSession({}, ids()), null, 'no id is not a session');
  assert.equal(migrateSession(42, ids()), null);
});

test('migration survives a session whose messages array is damaged', () => {
  const s = migrateSession({ ...legacy, messages: [
    { role: 'user', content: 'kept' },
    { role: 'wat', content: 'bad role' },
    { content: 'no role' },
    null,
  ] }, ids());
  assert.deepEqual(s?.messages.map(m => m.content), ['kept']);
});

test('migration fills in defaults for a session missing optional fields', () => {
  const s = migrateSession({ id: 'bare' }, ids());
  assert.ok(s);
  assert.equal(s.messages.length, 0);
  assert.equal(s.activeLeafId, null);
  assert.deepEqual(s.attachedFiles, []);
});
