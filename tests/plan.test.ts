import test from 'node:test';
import assert from 'node:assert/strict';
import {
  affectedFiles,
  contentNeededBefore,
  guardPlan,
  inverseOf,
  isPlanUndoable,
  operationPaths,
  planRisk,
  operationsFromCall,
  previewPlan,
  pruneNoOps,
} from '../src/agent/plan';
import { DEFAULT_PROTECTED_PATHS } from '../src/vault/protected';
import type { VaultOperation, VaultPlan } from '../src/agent/plan';

const plan = (operations: VaultOperation[]): VaultPlan =>
  ({ id: 'p1', createdAt: 0, description: 'test', operations });

const edit = (path: string): VaultOperation =>
  ({ kind: 'edit_file', path, original: 'a', replacement: 'b' });

// ── Paths ───────────────────────────────────────────────────────────────────

test('a move counts its destination as an affected path', () => {
  // A move INTO a protected folder is as much a write to that folder as a
  // delete inside it, so the destination cannot be ignored.
  assert.deepEqual(
    operationPaths({ kind: 'move_file', path: 'a.md', newPath: 'Dest/a.md' }),
    ['a.md', 'Dest/a.md']);
});

test('affectedFiles is de-duplicated and sorted', () => {
  const p = plan([edit('b.md'), edit('a.md'), edit('b.md')]);
  assert.deepEqual(affectedFiles(p), ['a.md', 'b.md']);
});

// ── Risk (§25) ──────────────────────────────────────────────────────────────

test('any deletion makes a plan high risk, however small', () => {
  assert.equal(planRisk(plan([{ kind: 'delete_file', path: 'a.md' }])), 'high');
});

test('a single edit is moderate, and a large batch is high', () => {
  assert.equal(planRisk(plan([edit('a.md')])), 'moderate');
  const many = Array.from({ length: 6 }, (_, i) => edit(`f${i}.md`));
  assert.equal(planRisk(plan(many)), 'high', 'reviewing six changes one notice at a time is not review');
});

test('link updates alone do not push a plan into a higher tier', () => {
  const links: VaultOperation[] = Array.from({ length: 20 }, (_, i) =>
    ({ kind: 'update_links', path: `n${i}.md`, content: 'x', changed: 1 }));
  assert.equal(planRisk(plan(links)), 'low');
});

test('an empty plan is low risk', () => {
  assert.equal(planRisk(plan([])), 'low');
});

// ── Protected paths (§27) ───────────────────────────────────────────────────

test('a plan touching a protected folder is split, not rejected wholesale', () => {
  const g = guardPlan(plan([
    edit('Notes/a.md'),
    edit('Templates/daily.md'),
    edit('Notes/b.md'),
  ]), DEFAULT_PROTECTED_PATHS);
  assert.equal(g.allowed.length, 2, 'the other work is still offered');
  assert.equal(g.blocked.length, 1);
  assert.equal(g.blocked[0].pattern, 'Templates');
});

test('a move whose destination is protected is blocked', () => {
  const g = guardPlan(plan([
    { kind: 'move_file', path: 'a.md', newPath: 'Templates/a.md' },
  ]), DEFAULT_PROTECTED_PATHS);
  assert.equal(g.allowed.length, 0);
  assert.equal(g.blocked.length, 1);
});

// ── Preview (§24) ───────────────────────────────────────────────────────────

test('the preview groups operations by kind with counts', () => {
  const out = previewPlan(plan([
    { kind: 'create_folder', path: 'School/Networking' },
    { kind: 'move_file', path: 'Old/TCP.md', newPath: 'School/Networking/TCP.md' },
    { kind: 'move_file', path: 'Old/IP.md',  newPath: 'School/Networking/IP.md' },
  ]));
  assert.match(out, /CREATE FOLDER\n {2}School\/Networking/);
  assert.match(out, /MOVE 2 files/);
  assert.match(out, /Old\/TCP\.md → School\/Networking\/TCP\.md/);
});

test('a long non-destructive group is summarised', () => {
  const many = Array.from({ length: 30 }, (_, i) => edit(`f${i}.md`));
  const out = previewPlan(plan(many));
  assert.match(out, /EDIT 30 files/);
  assert.match(out, /… and 20 more/);
});

test('every deletion is named however long the list', () => {
  // The one thing a user must never expand a summary to discover is what is
  // about to be destroyed.
  const many: VaultOperation[] = Array.from({ length: 30 }, (_, i) =>
    ({ kind: 'delete_file', path: `doomed${i}.md` }));
  const out = previewPlan(plan(many));
  assert.doesNotMatch(out, /and \d+ more/);
  for (let i = 0; i < 30; i++) assert.match(out, new RegExp(`doomed${i}\\.md`));
});

test('link updates report how many links changed', () => {
  const out = previewPlan(plan([{ kind: 'update_links', path: 'n.md', content: 'x', changed: 3 }]));
  assert.match(out, /UPDATE LINKS\n {2}n\.md \(3 links\)/);
});

// ── Undo (§26) ──────────────────────────────────────────────────────────────

test('an edit needs its previous contents captured before it runs', () => {
  assert.equal(contentNeededBefore(edit('a.md')), 'a.md');
  assert.equal(contentNeededBefore({ kind: 'delete_file', path: 'a.md' }), 'a.md');
  assert.equal(contentNeededBefore({ kind: 'create_file', path: 'a.md', content: '' }), null);
});

test('a create is undone by deleting what it created', () => {
  assert.deepEqual(inverseOf({ kind: 'create_file', path: 'a.md', content: 'x' }, null),
    { kind: 'delete_created', path: 'a.md' });
});

test('a move is undone by moving it back', () => {
  assert.deepEqual(inverseOf({ kind: 'move_file', path: 'a.md', newPath: 'D/a.md' }, null),
    { kind: 'move_back', from: 'D/a.md', to: 'a.md' });
});

test('a copy is undone by removing the copy, never the original', () => {
  assert.deepEqual(inverseOf({ kind: 'copy_file', path: 'a.md', newPath: 'b.md' }, null),
    { kind: 'delete_created', path: 'b.md' });
});

test('an edit is undoable only when the old contents were actually read', () => {
  assert.deepEqual(inverseOf(edit('a.md'), 'before'),
    { kind: 'restore_content', path: 'a.md', content: 'before' });
  assert.equal(inverseOf(edit('a.md'), null), null,
    'claiming undo without the contents would be a lie');
});

test('a delete is undoable only when the contents were captured', () => {
  assert.deepEqual(inverseOf({ kind: 'delete_file', path: 'a.md' }, 'saved'),
    { kind: 'recreate', path: 'a.md', content: 'saved' });
  assert.equal(inverseOf({ kind: 'delete_file', path: 'a.md' }, null), null);
});

test('a plan is undoable only if every operation in it is', () => {
  assert.equal(isPlanUndoable([{ kind: 'delete_created', path: 'a.md' }]), true);
  assert.equal(isPlanUndoable([{ kind: 'delete_created', path: 'a.md' }, null]), false);
  assert.equal(isPlanUndoable([]), false, 'nothing to undo is not "undoable"');
});

// ── Building plans from tool calls ──────────────────────────────────────────

test('a move places the note in the destination folder, keeping its name', () => {
  const ops = operationsFromCall('move_file', { path: 'Old/TCP.md', destFolder: 'School/Net' });
  assert.deepEqual(ops, [{ kind: 'move_file', path: 'Old/TCP.md', newPath: 'School/Net/TCP.md' }]);
});

test('a move to the vault root does not produce a leading slash', () => {
  const ops = operationsFromCall('move_file', { path: 'Old/TCP.md', destFolder: '' });
  assert.equal(ops?.[0].kind === 'move_file' && ops[0].newPath, 'TCP.md');
});

test('a rename keeps the note in its folder', () => {
  const ops = operationsFromCall('rename_file', { path: 'School/Old.md', newName: 'New.md' });
  assert.deepEqual(ops, [{ kind: 'rename_file', path: 'School/Old.md', newPath: 'School/New.md' }]);
});

test('a rename cannot smuggle a path in through the new name', () => {
  // Only the basename is taken, so "../../escape.md" cannot relocate the note.
  const ops = operationsFromCall('rename_file', { path: 'School/Old.md', newName: '../../escape.md' });
  assert.equal(ops?.[0].kind === 'rename_file' && ops[0].newPath, 'School/escape.md');
});

test('a batch expands into one operation per file, not one opaque step', () => {
  const ops = operationsFromCall('batch_move', { paths: ['a.md', 'sub/b.md'], destFolder: 'D' });
  assert.deepEqual(ops?.map(o => o.kind === 'move_file' && o.newPath), ['D/a.md', 'D/b.md']);
});

test('batch_delete expands to one delete per path', () => {
  const ops = operationsFromCall('batch_delete', { paths: ['a.md', 'b.md'] });
  assert.equal(ops?.length, 2);
  assert.ok(ops?.every(o => o.kind === 'delete_file'));
});

test('a read tool yields no operations, which is how reads and writes are told apart', () => {
  assert.equal(operationsFromCall('read_file', { path: 'a.md' }), null);
  assert.equal(operationsFromCall('search_vault', { query: 'x' }), null);
});

test('moving a file to where it already is produces nothing to do', () => {
  const ops = operationsFromCall('move_file', { path: 'D/a.md', destFolder: 'D' }) ?? [];
  assert.deepEqual(pruneNoOps(ops), [], 'a no-op move must not appear in a preview');
});

test('pruneNoOps leaves real work alone', () => {
  const ops: VaultOperation[] = [
    { kind: 'move_file', path: 'a.md', newPath: 'D/a.md' },
    { kind: 'delete_file', path: 'b.md' },
  ];
  assert.deepEqual(pruneNoOps(ops), ops);
});

// ── batch_rename / batch_edit (§37) ─────────────────────────────────────────

test('batch_rename replaces a literal piece of each filename', () => {
  const ops = operationsFromCall('batch_rename', {
    paths: ['L/lec1 - networking.md', 'L/lec2 - networking.md'],
    find: 'lec', replace: 'Lecture ',
  });
  assert.deepEqual(ops?.map(o => o.kind === 'rename_file' && o.newPath),
    ['L/Lecture 1 - networking.md', 'L/Lecture 2 - networking.md']);
});

test('batch_rename treats the search string literally, never as a pattern', () => {
  // As a regex, "." would match every character and destroy the name.
  const ops = operationsFromCall('batch_rename', {
    paths: ['a.b.md'], find: '.', replace: '-',
  });
  assert.equal(ops?.[0].kind === 'rename_file' && ops[0].newPath, 'a-b-md');
});

test('batch_rename skips files the replacement would not change', () => {
  const ops = operationsFromCall('batch_rename', {
    paths: ['keep.md', 'lec1.md'], find: 'lec', replace: 'Lecture ',
  });
  assert.equal(ops?.length, 1, 'an unchanged name is not a rename');
});

test('batch_rename cannot relocate a note through the replacement', () => {
  const ops = operationsFromCall('batch_rename', {
    paths: ['School/a.md'], find: 'a', replace: '../../escaped',
  });
  assert.equal(ops?.[0].kind === 'rename_file' && ops[0].newPath, 'School/escaped.md');
});

test('batch_rename with an empty search does nothing', () => {
  assert.deepEqual(operationsFromCall('batch_rename', { paths: ['a.md'], find: '', replace: 'x' }), []);
});

test('batch_rename that would empty a filename skips it', () => {
  assert.deepEqual(
    operationsFromCall('batch_rename', { paths: ['abc.md'], find: 'abc.md', replace: '' }), []);
});

test('batch_edit applies the same replacement to every named note', () => {
  const ops = operationsFromCall('batch_edit', {
    paths: ['a.md', 'b.md'], original: '#old', replacement: '#new',
  });
  assert.equal(ops?.length, 2);
  assert.ok(ops?.every(o => o.kind === 'edit_file' && o.original === '#old'));
});

test('batch_edit with no original text does nothing', () => {
  assert.deepEqual(operationsFromCall('batch_edit', { paths: ['a.md'], original: '' }), []);
});

test('a batch_edit is destructive, so it is never applied without confirmation', () => {
  const ops = operationsFromCall('batch_edit', {
    paths: ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md'], original: 'x', replacement: 'y',
  }) ?? [];
  assert.equal(planRisk(plan(ops)), 'high');
});
