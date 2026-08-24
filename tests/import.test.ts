import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConversationMarkdown } from '../src/chat/import';

const ids = () => {
  let n = 0;
  return () => `m${++n}`;
};

test('Markdown export imports as a linked conversation tree', () => {
  const result = parseConversationMarkdown(
    '# A chat\n\n## User\n\nHello\n\n## Assistant\n\n**Hi**\n',
    ids(),
    100,
  );
  assert.ok(result);
  assert.equal(result.title, 'A chat');
  assert.deepEqual(result.messages.map(message => ({
    id: message.id,
    parentId: message.parentId,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
  })), [
    { id: 'm1', parentId: null, role: 'user', content: 'Hello', createdAt: 100 },
    { id: 'm2', parentId: 'm1', role: 'assistant', content: '**Hi**', createdAt: 101 },
  ]);
});

test('empty role sections are ignored without breaking parent links', () => {
  const result = parseConversationMarkdown(
    '# Chat\n\n## User\n\n\n## Assistant\n\nAnswer\n\n## User\n\nFollow-up\n',
    ids(),
    10,
  );
  assert.deepEqual(result?.messages.map(message => [message.role, message.parentId]), [
    ['assistant', null],
    ['user', 'm1'],
  ]);
});

test('non-export Markdown is rejected', () => {
  assert.equal(parseConversationMarkdown('# Note\n\nJust a note.', ids()), null);
});
