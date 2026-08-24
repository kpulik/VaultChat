import type { ChatSession } from './chat/types';
import type { VaultIndex } from './vault/VaultIndex';
import type { OperationHistory } from './agent/history';
import type { PlanExecutor } from './agent/PlanExecutor';
import type { ProviderID } from './providers/catalog';
import type { VaultchatSettings } from './settings/types';

/**
 * What the views need from the plugin.
 *
 * Declaring it as an interface rather than importing the plugin class keeps the
 * dependency pointing one way -- main.ts knows about the views, the views do not
 * know about main.ts -- so neither file has to be loaded to reason about the other.
 */
export interface VaultChatHost {
  settings: VaultchatSettings;
  /** Kept current by the plugin; the agent's read tools resolve against it. */
  index: VaultIndex;
  /** Applied changes and their undo stacks, shared across views. */
  history: OperationHistory;
  /** Owned by the plugin so undo works from the activity view as well as the chat. */
  planExecutor: PlanExecutor;
  saveSettings(): Promise<void>;
  getApiKey(id: ProviderID): string;
  setApiKey(id: ProviderID, key: string): Promise<void>;
  /** Per-endpoint keys live in SecretStorage under their own id. */
  getEndpointApiKey(endpointId: string): string;
  setEndpointApiKey(endpointId: string, key: string): Promise<void>;
  loadAllSessions(): Promise<ChatSession[]>;
  saveSession(session: ChatSession): Promise<void>;
  deleteSession(id: string): Promise<void>;
}
