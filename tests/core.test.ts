import test from 'node:test';
import assert from 'node:assert/strict';
import {
  apiBasePath,
  resolveHost,
  isSafeVaultPath,
  parseEditBlocks,
  parseDeleteBlocks,
  secretId,
  parseSseLine,
} from '../src/core';

// Faithful stand-in for Obsidian's normalizePath: backslashes to slashes,
// collapse repeated slashes, trim surrounding whitespace and slashes.
const normalize = (p: string): string =>
  p.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');

const edit = (path: string, original: string, replacement: string) =>
  '```edit:' + path + '\n<<<<<<< ORIGINAL\n' + original + '=======\n' + replacement + '\n>>>>>>> MODIFIED\n```';

test('apiBasePath accepts a base URL with or without the /v1 suffix', () => {
  assert.equal(apiBasePath(new URL('http://127.0.0.1:11434')), '');
  assert.equal(apiBasePath(new URL('http://127.0.0.1:11434/')), '');
  assert.equal(apiBasePath(new URL('http://localhost:1234/v1')), '');
  assert.equal(apiBasePath(new URL('http://localhost:20128/v1')), '');
  assert.equal(apiBasePath(new URL('http://h:1/proxy/v1')), '/proxy');
});

test('apiBasePath leaves the hosted providers alone', () => {
  assert.equal(apiBasePath(new URL('https://openrouter.ai/api')), '/api');
  assert.equal(apiBasePath(new URL('https://generativelanguage.googleapis.com/v1beta/openai')), '/v1beta/openai');
  assert.equal(apiBasePath(new URL('https://api.anthropic.com')), '');
});

test('resolveHost swaps only localhost, because it resolves to ::1 first', () => {
  assert.equal(resolveHost('localhost'), '127.0.0.1');
  assert.equal(resolveHost('127.0.0.1'), '127.0.0.1');
  assert.equal(resolveHost('api.anthropic.com'), 'api.anthropic.com');
});

test('isSafeVaultPath refuses anything that escapes the vault', () => {
  assert.equal(isSafeVaultPath('notes/ok.md', normalize), true);
  assert.equal(isSafeVaultPath('a/b/c.md', normalize), true);
  // Obsidian resolves these against the vault root rather than rejecting them.
  assert.equal(isSafeVaultPath('../escaped.md', normalize), false);
  assert.equal(isSafeVaultPath('../../../../../../tmp/x.md', normalize), false);
  assert.equal(isSafeVaultPath('notes/../../pwn.md', normalize), false);
  assert.equal(isSafeVaultPath('..\\..\\win.md', normalize), false);
  assert.equal(isSafeVaultPath('', normalize), false);
  assert.equal(isSafeVaultPath('/', normalize), false);
});

test('a leading slash is contained rather than refused', () => {
  assert.equal(isSafeVaultPath('/rooted.md', normalize), true);
  assert.equal(normalize('/rooted.md'), 'rooted.md');
});

test('parseEditBlocks parses the empty-ORIGINAL form the system prompt documents', () => {
  // This is the new-file form. The regex used to require a newline before
  // '=======', so file creation silently never worked.
  const blocks = parseEditBlocks(edit('notes/new.md', '', 'hello'), normalize);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].filePath, 'notes/new.md');
  assert.deepEqual(blocks[0].edits, [{ original: '', replacement: 'hello' }]);
});

test('parseEditBlocks handles a non-empty ORIGINAL and an empty MODIFIED', () => {
  const replace = parseEditBlocks(edit('a.md', 'old\n', 'new'), normalize);
  assert.deepEqual(replace[0].edits, [{ original: 'old', replacement: 'new' }]);

  const clear = parseEditBlocks('```edit:a.md\n<<<<<<< ORIGINAL\nbye\n=======\n>>>>>>> MODIFIED\n```', normalize);
  assert.deepEqual(clear[0].edits, [{ original: 'bye', replacement: '' }]);
});

test('parseEditBlocks drops blocks whose path escapes the vault', () => {
  assert.equal(parseEditBlocks(edit('../../../../tmp/pwn.md', '', 'x'), normalize).length, 0);
  assert.equal(parseEditBlocks(edit('..\\..\\pwn.md', '', 'x'), normalize).length, 0);
  assert.equal(parseEditBlocks(edit('notes/../../pwn.md', '', 'x'), normalize).length, 0);
  // A safe block in the same response still survives.
  const mixed = parseEditBlocks(edit('../bad.md', '', 'x') + '\n' + edit('good.md', '', 'y'), normalize);
  assert.deepEqual(mixed.map(b => b.filePath), ['good.md']);
});

test('parseEditBlocks handles several edits in one block', () => {
  const text = '```edit:a.md\n'
    + '<<<<<<< ORIGINAL\none\n=======\n1\n>>>>>>> MODIFIED\n'
    + '<<<<<<< ORIGINAL\ntwo\n=======\n2\n>>>>>>> MODIFIED\n```';
  const blocks = parseEditBlocks(text, normalize);
  assert.equal(blocks[0].edits.length, 2);
});

test('parseDeleteBlocks keeps only the safe paths', () => {
  const blocks = parseDeleteBlocks('```delete\nnotes/ok.md\n../../etc/pwn.md\n..\\..\\w.md\nother.md\n```', normalize);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].filePaths, ['notes/ok.md', 'other.md']);
});

test('parseDeleteBlocks emits nothing when every path is unsafe', () => {
  assert.equal(parseDeleteBlocks('```delete\n../a.md\n../../b.md\n```', normalize).length, 0);
});

test('secretId produces a valid Obsidian secret id', () => {
  for (const p of ['local', 'anthropic', 'openai', 'gemini', 'openrouter']) {
    const id = secretId(p);
    assert.match(id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${id} must be lowercase alphanumeric with dashes`);
  }
  assert.equal(secretId('local'), 'vaultchat-local');
});

test('parseSseLine separates the answer from the chain of thought', () => {
  const content = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] });
  const reason  = 'data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking' } }] });

  assert.deepEqual(parseSseLine(content), { done: false, content: 'Hi' });
  assert.deepEqual(parseSseLine(reason), { done: false, reasoning: true });
  assert.deepEqual(parseSseLine('data: [DONE]'), { done: true });
});

test('parseSseLine ignores comments, blanks and malformed payloads', () => {
  // OmniRoute prefixes its stream with SSE comment lines.
  assert.deepEqual(parseSseLine(': omniroute-keepalive'), { done: false });
  assert.deepEqual(parseSseLine(''), { done: false });
  assert.deepEqual(parseSseLine('data: {not json'), { done: false });
  assert.deepEqual(parseSseLine('data: {}'), { done: false });
});
