import type { ProviderID } from '../providers/catalog';
import type { ContextSource } from '../context/types';

export type MessageRole = 'user' | 'assistant' | 'system';

export type MessageStatus = 'pending' | 'streaming' | 'complete' | 'error' | 'cancelled';

/**
 * A node in the conversation tree.
 *
 * Messages are stored flat and linked by `parentId` rather than as a list, so
 * editing or regenerating adds a sibling instead of overwriting what was there.
 * The branch on screen is the path from a root down to the session's active leaf.
 */
export interface Message {
  id:         string;
  parentId:   string | null;
  role:       MessageRole;
  content:    string;
  createdAt:  number;

  endpointId?: string;
  model?:      string;
  status?:     MessageStatus;
  metadata?:   Record<string, unknown>;
}

/** Current persisted session shape. */
export interface ChatSession {
  version:       2;
  id:            string;
  createdAt:     number;
  updatedAt:     number;
  title:         string;
  provider:      ProviderID;
  model:         string;
  endpointId?:   string | null;
  attachedFiles: string[];
  /** The composable sources shown in the context bar for this conversation. */
  contextSources?: ContextSource[];
  /** Per-chat generation defaults captured when the conversation starts. */
  systemPrompt?:  string;
  maxTokens?:     number;
  /** Pinned sessions sort above the date groups. */
  pinned?:       boolean;
  /** Archived sessions stay persisted but are separated from active history. */
  archived?:     boolean;
  messages:      Message[];
  /** Which branch tip is on screen. Null only while the session is empty. */
  activeLeafId:  string | null;
}

// ── Pre-2.0 shapes, still on disk in every existing install ────────────────

export interface LegacyMessage {
  role:    'user' | 'assistant';
  content: string;
}

export interface LegacyChatSession {
  id:            string;
  createdAt:     number;
  updatedAt:     number;
  title:         string;
  provider:      ProviderID;
  model:         string;
  attachedFiles: string[];
  messages:      LegacyMessage[];
}
