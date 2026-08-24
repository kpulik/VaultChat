import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBudget,
  estimateTokens,
  filesInFolder,
  isInFolder,
  parentFolder,
  renderContextBlocks,
  resolveSources,
} from '../src/context/resolve';
import type { ContextSource } from '../src/context/types';

const VAULT = [
  'School/CS/Networks/tcp.md',
  'School/CS/Networks/ip.md',
  'School/CS/algo.md',
  'School/history.md',
  'root.md',
  'Projects/VaultChat/notes.md',
];

// ── Folder maths ────────────────────────────────────────────────────────────

test('parentFolder returns the containing folder, and empty for a root file', () => {
  assert.equal(parentFolder('School/CS/Networks/tcp.md'), 'School/CS/Networks');
  assert.equal(parentFolder('root.md'), '');
});

test('isInFolder compares whole segments, not string prefixes', () => {
  // The bug this guards: 'Notes-old/x.md'.startsWith('Notes') is true.
  assert.equal(isInFolder('Notes-old/x.md', 'Notes', true), false);
  assert.equal(isInFolder('Notes/x.md', 'Notes', true), true);
});

test('isInFolder distinguishes direct children from descendants', () => {
  assert.equal(isInFolder('School/CS/algo.md', 'School', false), false);
  assert.equal(isInFolder('School/CS/algo.md', 'School', true), true);
  assert.equal(isInFolder('School/history.md', 'School', false), true);
});

test('the vault root behaves like a folder', () => {
  assert.equal(isInFolder('root.md', '', false), true);
  assert.equal(isInFolder('School/history.md', '', false), false, 'not a direct child of root');
  assert.equal(isInFolder('School/history.md', '', true), true);
});

test('filesInFolder can take a whole subtree or just the top level', () => {
  assert.deepEqual(filesInFolder(VAULT, 'School/CS/Networks', true),
    ['School/CS/Networks/tcp.md', 'School/CS/Networks/ip.md']);
  assert.deepEqual(filesInFolder(VAULT, 'School', false), ['School/history.md']);
  assert.equal(filesInFolder(VAULT, 'School', true).length, 4);
});

// ── Source resolution ───────────────────────────────────────────────────────

test('sources compose rather than replacing each other', () => {
  const sources: ContextSource[] = [
    { kind: 'current-note' },
    { kind: 'folder', path: 'Projects/VaultChat', recursive: true },
    { kind: 'file', path: 'root.md' },
  ];
  const out = resolveSources(sources, VAULT, 'School/history.md');
  assert.deepEqual(out.map(f => f.path),
    ['School/history.md', 'Projects/VaultChat/notes.md', 'root.md']);
});

test('entire-vault enables retrieval without adding every note to context', () => {
  const out = resolveSources([{ kind: 'entire-vault' }], VAULT, 'root.md');
  assert.deepEqual(out, []);
});

test('current-folder resolves against whatever note is open', () => {
  const out = resolveSources(
    [{ kind: 'current-folder', recursive: true }], VAULT, 'School/CS/Networks/tcp.md');
  assert.deepEqual(out.map(f => f.path),
    ['School/CS/Networks/tcp.md', 'School/CS/Networks/ip.md']);
  assert.match(out[0].reason, /School\/CS\/Networks/);
});

test('a file reachable twice is included once, with the first reason', () => {
  const out = resolveSources([
    { kind: 'current-note' },
    { kind: 'folder', path: 'School', recursive: true },
  ], VAULT, 'School/history.md');
  assert.equal(out.filter(f => f.path === 'School/history.md').length, 1);
  assert.equal(out[0].reason, 'Current note');
});

test('every included file carries a human-readable reason for the inspector', () => {
  const out = resolveSources([
    { kind: 'folder', path: 'School/CS', recursive: false },
  ], VAULT, null);
  assert.ok(out.length > 0);
  assert.ok(out.every(f => f.reason.length > 0));
});

test('current-note and current-folder contribute nothing when no note is open', () => {
  const out = resolveSources(
    [{ kind: 'current-note' }, { kind: 'current-folder', recursive: true }], VAULT, null);
  assert.deepEqual(out, []);
});

test('a current-note source can keep a selected path after the active note changes', () => {
  const files = resolveSources(
    [{ kind: 'current-note', path: 'Notes/selected.md' }],
    ['Notes/selected.md', 'Notes/other.md'],
    'Notes/other.md',
  );
  assert.deepEqual(files.map(file => file.path), ['Notes/selected.md']);
});

test('an attached file that has since been deleted is dropped, not sent as a path', () => {
  const out = resolveSources([{ kind: 'file', path: 'gone.md' }], VAULT, null);
  assert.deepEqual(out, []);
});

// ── Budget ──────────────────────────────────────────────────────────────────

test('estimateTokens grows with length and never returns a fraction', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2, 'rounds up');
});

test('applyBudget stops before the ceiling and reports what it dropped', () => {
  const files = [
    { path: 'a.md', content: 'x'.repeat(400), reason: 'r' },  // ~100
    { path: 'b.md', content: 'x'.repeat(400), reason: 'r' },  // ~100
    { path: 'c.md', content: 'x'.repeat(400), reason: 'r' },  // ~100
  ];
  const out = applyBudget(files, 250);
  assert.deepEqual(out.included.map(f => f.path), ['a.md', 'b.md']);
  assert.deepEqual(out.skipped, [{ path: 'c.md', reason: 'context budget full' }]);
  assert.equal(out.estimatedTokens, 200);
});

test('a file too big for the whole budget says so, rather than "budget full"', () => {
  const out = applyBudget([{ path: 'huge.md', content: 'x'.repeat(4000), reason: 'r' }], 100);
  assert.equal(out.included.length, 0);
  assert.match(out.skipped[0].reason, /too large on its own/);
});

test('one oversized file does not block the smaller ones behind it', () => {
  const out = applyBudget([
    { path: 'huge.md',  content: 'x'.repeat(4000), reason: 'r' },
    { path: 'small.md', content: 'x'.repeat(40),   reason: 'r' },
  ], 100);
  assert.deepEqual(out.included.map(f => f.path), ['small.md']);
});

test('nothing is silently truncated: every file is either included or skipped', () => {
  const files = Array.from({ length: 20 }, (_, i) =>
    ({ path: `f${i}.md`, content: 'x'.repeat(400), reason: 'r' }));
  const out = applyBudget(files, 500);
  assert.equal(out.included.length + out.skipped.length, 20);
});

test('renderContextBlocks emits the file wrapper the prompt expects', () => {
  const md = renderContextBlocks([{ path: 'a.md', content: 'hello' }]);
  assert.equal(md, '<file path="a.md">\nhello\n</file>\n\n');
});
