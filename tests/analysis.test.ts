import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyseLinkHealth,
  contentFingerprint,
  findDuplicateNames,
  findIdenticalContent,
  findNearDuplicates,
  similarity,
  wordSet,
} from '../src/vault/analysis';

// ── Duplicate names (§38) ───────────────────────────────────────────────────

test('notes sharing a filename across folders are grouped', () => {
  const groups = findDuplicateNames(['A/Notes.md', 'B/Notes.md', 'C/Other.md']);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].paths, ['A/Notes.md', 'B/Notes.md']);
  assert.equal(groups[0].reason, 'same name');
});

test('duplicate names are matched case-insensitively', () => {
  assert.equal(findDuplicateNames(['A/notes.md', 'B/NOTES.md']).length, 1);
});

test('a unique set of names produces no findings', () => {
  assert.deepEqual(findDuplicateNames(['a.md', 'b.md']), []);
});

// ── Identical content ───────────────────────────────────────────────────────

test('the fingerprint ignores frontmatter, case and whitespace', () => {
  const a = '---\ncreated: 2024-01-01\n---\n# Title\n\nSome   text.\n';
  const b = '---\ncreated: 2025-06-06\n---\n# TITLE\n\nSome text.';
  // Two real copies routinely differ only by their dates, so those must not
  // stop them matching.
  assert.equal(contentFingerprint(a), contentFingerprint(b));
});

test('identical notes are grouped by content, whatever they are called', () => {
  const groups = findIdenticalContent([
    { path: 'a.md', content: 'same body' },
    { path: 'deep/b.md', content: 'SAME   body' },
    { path: 'c.md', content: 'different' },
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].paths, ['a.md', 'deep/b.md']);
});

test('empty notes are not reported as duplicates of each other', () => {
  const groups = findIdenticalContent([
    { path: 'a.md', content: '' },
    { path: 'b.md', content: '   \n  ' },
    { path: 'c.md', content: '---\nx: 1\n---\n' },
  ]);
  assert.deepEqual(groups, [], 'otherwise every stub in the vault is one finding');
});

// ── Near duplicates ─────────────────────────────────────────────────────────

test('wordSet drops short words as noise', () => {
  assert.deepEqual([...wordSet('the cat sat on a networking mat')], ['networking']);
});

test('similarity is 1 for the same text and 0 when nothing overlaps', () => {
  assert.equal(similarity('networking protocols routing', 'networking protocols routing'), 1);
  assert.equal(similarity('networking protocols', 'photosynthesis chloroplast'), 0);
});

test('similarity of an empty note against anything is zero, not one', () => {
  assert.equal(similarity('', 'networking protocols'), 0);
  assert.equal(similarity('', ''), 0);
});

test('near duplicates are found and exact copies are excluded', () => {
  const notes = [
    { path: 'a.md', content: 'networking protocols routing switching addressing' },
    { path: 'b.md', content: 'networking protocols routing switching subnetting' },
    { path: 'c.md', content: 'networking protocols routing switching addressing' },
    { path: 'd.md', content: 'baking sourdough hydration fermentation' },
  ];
  const pairs = findNearDuplicates(notes, 0.5);
  const key = pairs.map(p => `${p.a}|${p.b}`);
  assert.ok(key.includes('a.md|b.md'), 'near copies are reported');
  assert.ok(!key.includes('a.md|c.md'), 'exact copies belong to findIdenticalContent');
  assert.ok(!key.some(k => k.includes('d.md')), 'unrelated notes are not paired');
});

test('near duplicates come back strongest first', () => {
  const pairs = findNearDuplicates([
    { path: 'a.md', content: 'alpha bravo charlie delta echo' },
    { path: 'b.md', content: 'alpha bravo charlie delta foxtrot' },
    { path: 'c.md', content: 'alpha bravo golf hotel india' },
  ], 0.1);
  assert.ok(pairs[0].similarity >= pairs[pairs.length - 1].similarity);
});

// ── Link health (§39) ───────────────────────────────────────────────────────

test('orphans and broken links are reported separately', () => {
  const backlinks: Record<string, string[]> = { 'linked.md': ['other.md'], 'orphan.md': [] };
  const unresolved: Record<string, string[]> = { 'linked.md': ['Ghost'], 'orphan.md': [] };
  const health = analyseLinkHealth(
    ['linked.md', 'orphan.md'],
    p => backlinks[p] ?? [],
    p => unresolved[p] ?? []);

  assert.deepEqual(health.orphans, ['orphan.md']);
  assert.deepEqual(health.brokenBy, [{ path: 'linked.md', unresolved: ['Ghost'] }]);
  assert.equal(health.totalBroken, 1);
});

test('a healthy vault reports nothing broken', () => {
  const health = analyseLinkHealth(['a.md'], () => ['b.md'], () => []);
  assert.deepEqual(health.orphans, []);
  assert.deepEqual(health.brokenBy, []);
  assert.equal(health.totalBroken, 0);
});

test('broken links are counted across notes, not just per note', () => {
  const health = analyseLinkHealth(
    ['a.md', 'b.md'], () => ['x.md'], () => ['Ghost', 'Phantom']);
  assert.equal(health.totalBroken, 4);
});
