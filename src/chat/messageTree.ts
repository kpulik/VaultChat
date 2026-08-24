// Conversation tree operations.
//
// Pure: no Obsidian imports and no clock or id source of its own, so every rule
// here is unit testable. Callers pass ids and timestamps in.
//
// Sessions are read from JSON on disk, which can be hand-edited, truncated or
// corrupted. Every traversal below is therefore written to terminate on a
// malformed parent chain rather than trusting the file to be a tree.

import type { ChatSession, Message, MessageRole } from './types';

/** Direct children of a node, oldest first. `null` gives the roots. */
export function childrenOf(messages: Message[], parentId: string | null): Message[] {
  return messages
    .filter(m => m.parentId === parentId)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/**
 * Root-to-node path. Returns [] when the id is unknown.
 *
 * A cycle in `parentId` would otherwise loop forever, so visited ids stop the
 * walk and the partial path is returned.
 */
export function pathToRoot(messages: Message[], id: string | null): Message[] {
  if (!id) return [];
  const byId = new Map(messages.map(m => [m.id, m]));
  const out: Message[] = [];
  const seen = new Set<string>();
  let cursor: string | null = id;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node: Message | undefined = byId.get(cursor);
    if (!node) break;
    out.push(node);
    cursor = node.parentId;
  }
  return out.reverse();
}

/**
 * Descends from a node to a branch tip, always taking the newest child.
 *
 * Switching to a sibling should land on a complete conversation rather than on
 * the single message that was clicked, so the caller gets the leaf below it.
 */
export function deepestLeaf(messages: Message[], fromId: string): string {
  const seen = new Set<string>();
  let cursor = fromId;
  for (;;) {
    if (seen.has(cursor)) return cursor;
    seen.add(cursor);
    const kids = childrenOf(messages, cursor);
    if (kids.length === 0) return cursor;
    cursor = kids[kids.length - 1].id;
  }
}

/** The branch currently on screen. */
export function activePath(session: ChatSession): Message[] {
  return pathToRoot(session.messages, session.activeLeafId);
}

/** Every message sharing a parent with this one, oldest first, itself included. */
export function siblingsOf(messages: Message[], id: string): Message[] {
  const node = messages.find(m => m.id === id);
  if (!node) return [];
  return childrenOf(messages, node.parentId);
}

/**
 * Where a message sits among its siblings, for a "2 / 3" branch control.
 * `count` is 1 when nothing has been branched, which the UI reads as "no
 * alternatives, show nothing".
 */
export function branchPosition(messages: Message[], id: string): { index: number; count: number } {
  const sibs = siblingsOf(messages, id);
  const at = sibs.findIndex(m => m.id === id);
  return { index: at < 0 ? 0 : at, count: sibs.length };
}

export function descendantIds(messages: Message[], id: string): Set<string> {
  const out = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) continue;
    for (const child of childrenOf(messages, current)) {
      if (out.has(child.id)) continue;
      out.add(child.id);
      queue.push(child.id);
    }
  }
  return out;
}

// ── Mutations ───────────────────────────────────────────────────────────────
//
// Each returns a new array. Sessions are persisted, and mutating the saved
// array in place made it impossible to tell what had been written yet.

export interface NewMessage {
  id:          string;
  parentId:    string | null;
  role:        MessageRole;
  content:     string;
  createdAt:   number;
  endpointId?: string;
  model?:      string;
  status?:     Message['status'];
}

export function appendMessage(messages: Message[], msg: NewMessage): Message[] {
  return [...messages, { ...msg }];
}

export function updateMessage(
  messages: Message[],
  id: string,
  patch: Partial<Omit<Message, 'id' | 'parentId'>>,
): Message[] {
  return messages.map(m => (m.id === id ? { ...m, ...patch, id: m.id, parentId: m.parentId } : m));
}

/** Removes a message and everything below it. */
export function deleteSubtree(messages: Message[], id: string): Message[] {
  const doomed = descendantIds(messages, id);
  doomed.add(id);
  return messages.filter(m => !doomed.has(m.id));
}

/**
 * Adds an alternative to `id` under the same parent -- the shape both "edit this
 * user message" and "regenerate this reply" take.
 *
 * The original is left exactly where it was. That is the whole point: §6 of the
 * spec requires that branching never silently destroys what it branched from.
 */
export function branchFrom(
  messages: Message[],
  id: string,
  fields: Omit<NewMessage, 'parentId'>,
): { messages: Message[]; created: Message | null } {
  const node = messages.find(m => m.id === id);
  if (!node) return { messages, created: null };
  const created: Message = { ...fields, parentId: node.parentId };
  return { messages: [...messages, created], created };
}

/**
 * Points the session at another branch.
 *
 * Descends to that branch's tip so the user sees a whole conversation, not a
 * transcript that stops at the message they clicked.
 */
export function switchToBranch(session: ChatSession, targetId: string): ChatSession {
  if (!session.messages.some(m => m.id === targetId)) return session;
  return { ...session, activeLeafId: deepestLeaf(session.messages, targetId) };
}

/**
 * Repairs a session whose active leaf is missing.
 *
 * A deleted subtree or a truncated file can leave `activeLeafId` pointing at
 * nothing, which would render an empty chat over a session that still has
 * messages. Falls back to the newest reachable leaf.
 */
export function repairActiveLeaf(session: ChatSession): ChatSession {
  const { messages, activeLeafId } = session;
  if (messages.length === 0) {
    return activeLeafId === null ? session : { ...session, activeLeafId: null };
  }
  if (activeLeafId && messages.some(m => m.id === activeLeafId)) return session;
  const newest = [...messages].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).pop();
  return { ...session, activeLeafId: newest ? deepestLeaf(messages, newest.id) : null };
}

// ── Wire format ─────────────────────────────────────────────────────────────

export interface WireMessage {
  role:    'user' | 'assistant';
  content: string;
}

/**
 * Strips the tree bookkeeping before a request goes out.
 *
 * Sending `id`, `parentId` and `createdAt` to a provider is at best ignored and
 * at worst a 400 from an API that rejects unknown message fields, so the wire
 * shape is built explicitly rather than by passing nodes through.
 */
export function toWireMessages(path: Message[]): WireMessage[] {
  const out: WireMessage[] = [];
  for (const m of path) {
    // System prompts travel in their own field for both API shapes.
    if (m.role === 'system') continue;
    if (m.status === 'error' || m.status === 'cancelled') continue;
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

// ── Export ──────────────────────────────────────────────────────────────────

const ROLE_HEADING: Record<MessageRole, string> = {
  user:      'User',
  assistant: 'Assistant',
  system:    'System',
};

/** The visible branch as Markdown, for copy-conversation and export. */
export function conversationToMarkdown(session: ChatSession): string {
  const lines: string[] = [`# ${session.title || 'Untitled chat'}`, ''];
  for (const m of activePath(session)) {
    lines.push(`## ${ROLE_HEADING[m.role]}`, '', m.content, '');
  }
  return lines.join('\n').trimEnd() + '\n';
}
