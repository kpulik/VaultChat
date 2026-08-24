import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_IGNORED_PATHS,
  DEFAULT_PROTECTED_PATHS,
  guardPaths,
  isProtectedPath,
  pathMatches,
  withConfigDir,
} from '../src/vault/protected';
import {
  CONFIDENCE,
  findFile,
  queryTerms,
  scoreEntry,
  searchIndex,
} from '../src/vault/search';
import type { NoteIndexEntry } from '../src/vault/search';

// ── Protected paths (§27) ───────────────────────────────────────────────────

test('pathMatches covers the folder itself and everything under it', () => {
  assert.equal(pathMatches('Templates', 'Templates'), true);
  assert.equal(pathMatches('Templates/daily.md', 'Templates'), true);
  assert.equal(pathMatches('Templates/sub/x.md', 'Templates'), true);
});

test('pathMatches compares segments, so a similarly named folder is not caught', () => {
  assert.equal(pathMatches('Templates-old/x.md', 'Templates'), false);
  assert.equal(pathMatches('MyTemplates/x.md', 'Templates'), false);
});

test('a trailing /* protects the contents but not the folder', () => {
  assert.equal(pathMatches('Attachments', 'Attachments/*'), false);
  assert.equal(pathMatches('Attachments/img.png', 'Attachments/*'), true);
});

test('pathMatches tolerates stray slashes and ignores an empty pattern', () => {
  assert.equal(pathMatches('Templates/x.md', '/Templates/'), true);
  assert.equal(pathMatches('anything.md', ''), false);
  assert.equal(pathMatches('anything.md', '/'), false);
});

test('the config folder is protected under whatever name the vault uses', () => {
  // The folder is not always named `.obsidian`; withConfigDir supplies the real
  // one, so a renamed config folder is protected just the same.
  const guarded = withConfigDir(DEFAULT_PROTECTED_PATHS, '.my-config');
  assert.equal(isProtectedPath('.my-config/plugins/vaultchat/data.json', guarded), true);
  assert.equal(isProtectedPath('.obsidian/workspace.json', guarded), false,
    'the default name is not special-cased');
  assert.equal(isProtectedPath('Notes/idea.md', guarded), false);
});

test('withConfigDir is idempotent and ignores an empty config dir', () => {
  const once = withConfigDir(DEFAULT_IGNORED_PATHS, '.obsidian');
  assert.deepEqual(withConfigDir(once, '.obsidian'), once, 'not added twice');
  assert.deepEqual(withConfigDir(DEFAULT_IGNORED_PATHS, ''), DEFAULT_IGNORED_PATHS);
  assert.deepEqual(withConfigDir(DEFAULT_IGNORED_PATHS, '/.obsidian/'), ['.obsidian', '.trash']);
});

test('guardPaths reports every blocked path at once, not just the first', () => {
  const out = guardPaths(
    ['Notes/a.md', '.trash/old.md', 'Templates/t.md', 'Notes/b.md'],
    DEFAULT_PROTECTED_PATHS,
  );
  assert.deepEqual(out.allowed, ['Notes/a.md', 'Notes/b.md']);
  assert.deepEqual(out.blocked.map(b => b.path), ['.trash/old.md', 'Templates/t.md']);
});

test('guardPaths names the pattern that blocked each path, so the message can explain', () => {
  const out = guardPaths(['Templates/t.md'], DEFAULT_PROTECTED_PATHS);
  assert.equal(out.blocked[0].pattern, 'Templates');
});

test('guardPaths lets everything through when nothing is protected', () => {
  const out = guardPaths(['a.md', 'b.md'], []);
  assert.deepEqual(out.allowed, ['a.md', 'b.md']);
  assert.deepEqual(out.blocked, []);
});

// ── File matching (§16) ─────────────────────────────────────────────────────

const entry = (over: Partial<NoteIndexEntry> & { path: string }): NoteIndexEntry => ({
  basename: over.path.split('/').pop()!.replace(/\.md$/, ''),
  aliases: [], tags: [], headings: [], mtime: 0, ...over,
});

const INDEX: NoteIndexEntry[] = [
  entry({ path: 'School/Networking.md', aliases: ['Networks'], tags: ['school'] }),
  entry({ path: 'Projects/Networking.md' }),
  entry({ path: 'School/CS/TCP-IP.md', headings: ['Three-way handshake'] }),
  entry({ path: 'Archive/old ideas.md', tags: ['#archive'] }),
];

test('queryTerms strips punctuation and a trailing .md', () => {
  assert.deepEqual(queryTerms('  My Networking Notes.md '), ['my', 'networking', 'notes']);
  assert.deepEqual(queryTerms('!!!'), []);
});

test('an exact path scores above everything else', () => {
  const m = scoreEntry(INDEX[0], 'School/Networking.md');
  assert.equal(m?.confidence, 1);
  assert.equal(m?.reason, 'exact path');
});

test('an exact filename outranks a filename that merely contains the terms', () => {
  const exact   = scoreEntry(entry({ path: 'Networking.md' }), 'networking');
  const partial = scoreEntry(entry({ path: 'Networking notes from last term.md' }), 'networking');
  assert.ok(exact && partial);
  assert.ok(exact.confidence > partial.confidence,
    'otherwise the longer note wins and the obvious one loses');
});

test('aliases resolve a reference the filename does not contain', () => {
  const m = scoreEntry(INDEX[0], 'Networks');
  assert.match(m?.reason ?? '', /alias/);
  assert.ok((m?.confidence ?? 0) >= CONFIDENCE.HIGH);
});

test('headings and tags match, but below filename evidence', () => {
  const heading = scoreEntry(INDEX[2], 'Three-way handshake');
  const tag     = scoreEntry(INDEX[3], 'archive');
  assert.ok(heading && tag);
  assert.ok(heading.confidence > tag.confidence);
  assert.ok(tag.confidence < CONFIDENCE.HIGH, 'a tag alone is never enough to act on');
});

test('note content is searchable but never strong enough to act without confirmation', () => {
  const contentOnly = entry({ path: 'Research/Qwen notes.md', content: 'A completely different title' });
  const match = scoreEntry(contentOnly, 'different title');
  assert.equal(match?.reason, 'note content contains every term');
  assert.equal(match?.confidence, CONFIDENCE.MEDIUM);
  assert.equal(findFile([contentOnly], 'different title').kind, 'ambiguous');
});

test('a note matching nothing scores nothing', () => {
  assert.equal(scoreEntry(INDEX[0], 'quantum chromodynamics'), null);
  assert.equal(scoreEntry(INDEX[0], '   '), null);
});

test('searchIndex ranks best first and is stable for equal scores', () => {
  const out = searchIndex(INDEX, 'Networking');
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(m => m.path), ['Projects/Networking.md', 'School/Networking.md']);
});

// ── The guarantee: ambiguity stops, it does not guess ───────────────────────

test('two equally good candidates are ambiguous, not a silent pick', () => {
  const v = findFile(INDEX, 'Networking');
  assert.equal(v.kind, 'ambiguous');
  if (v.kind === 'ambiguous') {
    assert.deepEqual(v.candidates.map(c => c.path).sort(),
      ['Projects/Networking.md', 'School/Networking.md']);
  }
});

test('an exact path is acted on even when similarly named notes exist', () => {
  const v = findFile(INDEX, 'School/Networking.md');
  assert.equal(v.kind, 'match');
  if (v.kind === 'match') assert.equal(v.match.path, 'School/Networking.md');
});

test('a unique confident match is returned', () => {
  const v = findFile(INDEX, 'TCP-IP');
  assert.equal(v.kind, 'match');
  if (v.kind === 'match') assert.equal(v.match.path, 'School/CS/TCP-IP.md');
});

test('a merely plausible match is surfaced for confirmation, never acted on', () => {
  const v = findFile([INDEX[3]], 'archive');
  assert.equal(v.kind, 'ambiguous', 'below the high bar, so it has to be confirmed');
});

test('no match at all is reported as none, not as a low-confidence guess', () => {
  assert.equal(findFile(INDEX, 'quantum chromodynamics').kind, 'none');
  assert.equal(findFile([], 'anything').kind, 'none');
});

test('every ambiguous verdict carries the reasons, so the user can choose', () => {
  const v = findFile(INDEX, 'Networking');
  if (v.kind !== 'ambiguous') throw new Error('expected ambiguous');
  assert.ok(v.candidates.every(c => c.reason.length > 0));
});
