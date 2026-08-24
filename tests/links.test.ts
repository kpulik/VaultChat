import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatWikilink,
  parseMarkdownLinks,
  parseWikilinks,
  protectedRanges,
  resolveLinkTarget,
  rewriteWikilinks,
  shortestLinkTo,
  updateLinksForMove,
} from '../src/vault/links';

// ── Parsing every documented form (§19) ─────────────────────────────────────

test('parses the plain, pathed, aliased, heading and block forms', () => {
  const links = parseWikilinks(
    '[[Note]] [[Folder/Note]] [[Note|Display]] [[Note#Heading]] [[Note#^abc123]]');
  assert.deepEqual(links.map(l => l.target),
    ['Note', 'Folder/Note', 'Note', 'Note', 'Note']);
  assert.equal(links[2].alias, 'Display');
  assert.equal(links[3].heading, 'Heading');
  assert.equal(links[4].block, 'abc123');
  assert.equal(links[4].heading, undefined, 'a ^fragment is a block, not a heading');
});

test('embeds are recognised, including non-markdown attachments', () => {
  const links = parseWikilinks('![[Note]] ![[image.png]] [[Note]]');
  assert.deepEqual(links.map(l => l.embed), [true, true, false]);
  assert.equal(links[1].target, 'image.png');
});

test('a heading and an alias can appear together', () => {
  const [l] = parseWikilinks('[[Note#Section|Read this]]');
  assert.equal(l.target, 'Note');
  assert.equal(l.heading, 'Section');
  assert.equal(l.alias, 'Read this');
});

test('a heading containing a slash is not mistaken for a path', () => {
  const [l] = parseWikilinks('[[Networking#TCP/IP]]');
  assert.equal(l.target, 'Networking');
  assert.equal(l.heading, 'TCP/IP');
});

test('a same-note link has no target', () => {
  const [l] = parseWikilinks('[[#Heading]]');
  assert.equal(l.target, '');
  assert.equal(l.heading, 'Heading');
});

test('markdown links parse, and embeds among them', () => {
  const links = parseMarkdownLinks('[Name](path/to/file.md) ![alt](img.png)');
  assert.equal(links[0].href, 'path/to/file.md');
  assert.equal(links[1].embed, true);
});

// ── Code is not a reference ─────────────────────────────────────────────────

test('protectedRanges covers fenced blocks and inline code', () => {
  const text = 'a `[[X]]` b\n```\n[[Y]]\n```\n[[Z]]';
  const ranges = protectedRanges(text);
  assert.ok(ranges.length >= 2);
  assert.deepEqual(parseWikilinks(text).map(l => l.target), ['Z'],
    'only the link outside code is a real reference');
});

test('a rename does not rewrite an example inside a code fence', () => {
  const text = 'See [[Old]].\n\n```md\n[[Old]]\n```\n';
  const out = rewriteWikilinks(text, t => (t === 'Old' ? 'New' : null));
  assert.equal(out.changed, 1);
  assert.match(out.text, /See \[\[New\]\]/);
  assert.match(out.text, /```md\n\[\[Old\]\]\n```/, 'the documented example is untouched');
});

// ── Rewriting preserves what it was not asked to change (§21) ───────────────

test('formatWikilink round-trips every part', () => {
  assert.equal(formatWikilink({ target: 'A', embed: false }), '[[A]]');
  assert.equal(formatWikilink({ target: 'A', embed: true }), '![[A]]');
  assert.equal(formatWikilink({ target: 'A', embed: false, alias: 'B' }), '[[A|B]]');
  assert.equal(formatWikilink({ target: 'A', embed: false, heading: 'H' }), '[[A#H]]');
  assert.equal(formatWikilink({ target: 'A', embed: false, block: 'b1' }), '[[A#^b1]]');
});

test('rewriting keeps the alias, the fragment and the embed marker', () => {
  const text = '[[Old|My notes]] ![[Old]] [[Old#Intro]] [[Old#^b1]]';
  const out = rewriteWikilinks(text, t => (t === 'Old' ? 'New' : null));
  assert.equal(out.text, '[[New|My notes]] ![[New]] [[New#Intro]] [[New#^b1]]');
  assert.equal(out.changed, 4);
});

test('links the resolver declines are left byte-identical', () => {
  const text = '[[Keep]] and [[Old]]';
  const out = rewriteWikilinks(text, t => (t === 'Old' ? 'New' : null));
  assert.equal(out.text, '[[Keep]] and [[New]]');
  assert.equal(out.changed, 1);
});

test('rewriting several links in one line does not corrupt later offsets', () => {
  const text = '[[Old]] [[Old]] [[Old]]';
  const out = rewriteWikilinks(text, t => (t === 'Old' ? 'Much Longer Name' : null));
  assert.equal(out.text, '[[Much Longer Name]] [[Much Longer Name]] [[Much Longer Name]]');
});

test('a same-note link is never repointed', () => {
  const out = rewriteWikilinks('[[#Section]]', () => 'Whatever');
  assert.equal(out.changed, 0);
});

// ── Resolution ──────────────────────────────────────────────────────────────

const VAULT = ['School/Networking.md', 'School/CS/TCP.md', 'Archive/TCP.md', 'img.png'];

test('resolveLinkTarget accepts a bare basename, a partial path and a full path', () => {
  assert.equal(resolveLinkTarget('Networking', VAULT), 'School/Networking.md');
  assert.equal(resolveLinkTarget('School/Networking', VAULT), 'School/Networking.md');
  assert.equal(resolveLinkTarget('School/Networking.md', VAULT), 'School/Networking.md');
});

test('resolveLinkTarget breaks a basename tie by shortest path, as Obsidian does', () => {
  assert.equal(resolveLinkTarget('TCP', VAULT), 'Archive/TCP.md');
});

test('resolveLinkTarget handles attachments and misses', () => {
  assert.equal(resolveLinkTarget('img.png', VAULT), 'img.png');
  assert.equal(resolveLinkTarget('Nope', VAULT), null);
  assert.equal(resolveLinkTarget('  ', VAULT), null);
});

test('shortestLinkTo uses the basename, but the full path when it would be ambiguous', () => {
  assert.equal(shortestLinkTo('School/Networking.md', VAULT), 'Networking');
  assert.equal(shortestLinkTo('Archive/TCP.md', VAULT), 'Archive/TCP',
    'two notes are called TCP, so the bare name would point at the wrong one');
});

// ── Move / rename (§21) ─────────────────────────────────────────────────────

test('a move that leaves the basename resolving rewrites nothing at all', () => {
  // [[TCP]] still finds the note at its new home, so touching the file would be
  // a pointless edit -- and would show up as a bogus "1 note affected".
  const after = ['School/Networking/TCP.md', 'notes.md'];
  const out = updateLinksForMove(
    [{ path: 'notes.md', content: 'see [[TCP]] and [[TCP|the note]]' }],
    'Old/TCP.md', 'School/Networking/TCP.md', after);
  assert.deepEqual(out, [], 'no file is reported as changed');
});

test('a move to a folder with a name clash writes the full path instead', () => {
  const after = ['School/TCP.md', 'Archive/TCP.md', 'notes.md'];
  const out = updateLinksForMove(
    [{ path: 'notes.md', content: 'see [[Old/TCP|the note]]' }],
    'Old/TCP.md', 'School/TCP.md', after);
  assert.equal(out[0].content, 'see [[School/TCP|the note]]');
  assert.equal(out[0].changed, 1);
});

test('only files that actually changed are returned, so counts are real', () => {
  const after = ['School/A.md', 'x.md', 'y.md'];
  const out = updateLinksForMove([
    { path: 'x.md', content: 'links [[Old/A]]' },
    { path: 'y.md', content: 'links nothing' },
  ], 'Old/A.md', 'School/A.md', after);
  assert.deepEqual(out.map(u => u.path), ['x.md']);
});

test('markdown-style links are updated too, and external URLs are left alone', () => {
  const after = ['School/A.md', 'x.md'];
  const out = updateLinksForMove(
    [{ path: 'x.md', content: '[A](Old/A.md) and [site](https://example.com/Old/A.md)' }],
    'Old/A.md', 'School/A.md', after);
  assert.match(out[0].content, /\[A\]\(School\/A\.md\)/);
  assert.match(out[0].content, /https:\/\/example\.com\/Old\/A\.md/, 'external URL untouched');
});

test('a move rewrites embeds and leaves unrelated block references alone', () => {
  // A second img.png exists after the move, so the bare name is ambiguous and
  // the embed has to be written as a full path.
  const after = ['Media/img.png', 'Other/img.png', 'Refs/N.md', 'x.md'];
  const out = updateLinksForMove(
    [{ path: 'x.md', content: '![[img.png]] plus [[N#^b1]]' }],
    'Old/img.png', 'Media/img.png', after);
  assert.equal(out.length, 1);
  assert.match(out[0].content, /!\[\[Media\/img\.png\]\]/, 'embed marker survives');
  assert.match(out[0].content, /\[\[N#\^b1\]\]/, 'the unrelated block ref is untouched');
});
