// Session migration.
//
// Every existing install has pre-2.0 sessions on disk: a flat `messages` array
// of {role, content} with no ids. They are read back as a single-branch tree so
// nothing is lost and no chat has to be thrown away on upgrade.
//
// Pure, and the id source is injected, so the result is deterministic in tests.

import { repairActiveLeaf } from './messageTree';
import type { ChatSession, LegacyChatSession, Message } from './types';
import type { ProviderID } from '../providers/catalog';
import type { ContextSource } from '../context/types';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function contextSources(v: unknown): ContextSource[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const sources = v.filter((source): source is ContextSource => {
    if (!isRecord(source) || typeof source.kind !== 'string') return false;
    if (source.kind === 'current-note') {
      return source.path === undefined || typeof source.path === 'string';
    }
    if (source.kind === 'entire-vault') return true;
    if (source.kind === 'current-folder') return typeof source.recursive === 'boolean';
    return (source.kind === 'file' || source.kind === 'folder')
      && typeof source.path === 'string'
      && (source.kind === 'file' || typeof source.recursive === 'boolean');
  });
  return sources;
}

/**
 * Turns whatever was on disk into a current session, or null if it is too
 * damaged to be one.
 *
 * Returning null rather than throwing keeps one corrupt file from taking the
 * rest of the history down with it -- the caller skips it, as it always has.
 */
export function migrateSession(raw: unknown, newId: () => string): ChatSession | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id === '') return null;

  const base = {
    id:            raw.id,
    createdAt:     typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    updatedAt:     typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    title:         typeof raw.title === 'string' ? raw.title : '',
    provider:      (typeof raw.provider === 'string' ? raw.provider : 'local') as ProviderID,
    model:         typeof raw.model === 'string' ? raw.model : '',
    attachedFiles: Array.isArray(raw.attachedFiles)
      ? raw.attachedFiles.filter((p): p is string => typeof p === 'string')
      : [],
  };

  // Already current: trust the tree but not the pointer into it.
  if (raw.version === 2) {
    const messages = Array.isArray(raw.messages)
      ? raw.messages.filter(isValidMessage)
      : [];
    return repairActiveLeaf({
      ...base,
      version: 2,
      pinned: raw.pinned === true,
      archived: raw.archived === true,
      endpointId: typeof raw.endpointId === 'string' ? raw.endpointId : null,
      ...(contextSources(raw.contextSources) !== undefined
        ? { contextSources: contextSources(raw.contextSources) }
        : {}),
      ...(typeof raw.systemPrompt === 'string' ? { systemPrompt: raw.systemPrompt } : {}),
      ...(typeof raw.maxTokens === 'number' && raw.maxTokens >= 0
        ? { maxTokens: raw.maxTokens }
        : {}),
      messages,
      activeLeafId: typeof raw.activeLeafId === 'string' ? raw.activeLeafId : null,
    });
  }

  return migrateLegacy({ ...base, messages: legacyMessages(raw.messages) }, newId);
}

function isValidMessage(v: unknown): v is Message {
  if (!isRecord(v)) return false;
  return typeof v.id === 'string'
    && (v.parentId === null || typeof v.parentId === 'string')
    && (v.role === 'user' || v.role === 'assistant' || v.role === 'system')
    && typeof v.content === 'string'
    && typeof v.createdAt === 'number';
}

function legacyMessages(v: unknown): LegacyChatSession['messages'] {
  if (!Array.isArray(v)) return [];
  return v.filter((m): m is LegacyChatSession['messages'][number] =>
    isRecord(m)
    && (m.role === 'user' || m.role === 'assistant')
    && typeof m.content === 'string');
}

/**
 * Chains a flat pre-2.0 transcript into one unbranched path.
 *
 * Timestamps are derived from the session's own createdAt rather than from the
 * clock, so ordering survives the migration and two messages can never collide
 * on the same instant.
 */
function migrateLegacy(
  legacy: Omit<LegacyChatSession, 'messages'> & { messages: LegacyChatSession['messages'] },
  newId: () => string,
): ChatSession {
  const messages: Message[] = [];
  let parentId: string | null = null;

  legacy.messages.forEach((m, i) => {
    const node: Message = {
      id:        newId(),
      parentId,
      role:      m.role,
      content:   m.content,
      createdAt: legacy.createdAt + i,
      status:    'complete',
      ...(legacy.model ? { model: legacy.model } : {}),
    };
    messages.push(node);
    parentId = node.id;
  });

  return {
    version:       2,
    id:            legacy.id,
    createdAt:     legacy.createdAt,
    updatedAt:     legacy.updatedAt,
    title:         legacy.title,
    provider:      legacy.provider,
    model:         legacy.model,
    endpointId:    null,
    attachedFiles: legacy.attachedFiles,
    contextSources: legacy.attachedFiles.map(path => ({ kind: 'file' as const, path })),
    pinned:        false,
    archived:      false,
    messages,
    // The last message of a linear transcript is its only leaf.
    activeLeafId:  parentId,
  };
}
