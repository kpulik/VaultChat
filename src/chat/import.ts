import type { Message, MessageRole } from './types';

export interface ImportedConversation {
  title: string;
  messages: Message[];
}

const ROLE_HEAD = /^##\s+(User|Assistant|System)\s*$/gim;

/** Parses VaultChat's Markdown export without executing or rendering its contents. */
export function parseConversationMarkdown(
  markdown: string,
  newId: () => string,
  createdAt = Date.now(),
): ImportedConversation | null {
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || 'Imported chat';
  const headings = [...markdown.matchAll(ROLE_HEAD)];
  if (headings.length === 0) return null;

  const messages: Message[] = [];
  let parentId: string | null = null;
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const role = heading[1].toLowerCase() as MessageRole;
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[i + 1]?.index ?? markdown.length;
    const content = markdown.slice(start, end).trim();
    if (!content) continue;
    const message: Message = {
      id: newId(),
      parentId,
      role,
      content,
      createdAt: createdAt + messages.length,
      status: 'complete',
    };
    messages.push(message);
    parentId = message.id;
  }

  return messages.length > 0 ? { title, messages } : null;
}
