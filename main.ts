import { Notice, Plugin } from 'obsidian';
import { secretId } from './src/core';
import { VIEW_TYPE_CHAT } from './src/constants';
import { SessionStore } from './src/chat/storage';
import { endpointSecretId } from './src/endpoints/manager';
import { VaultIndex } from './src/vault/VaultIndex';
import { OperationHistory } from './src/agent/history';
import { PlanExecutor } from './src/agent/PlanExecutor';
import { VaultSearchModal } from './src/ui/VaultSearchModal';
import { ActivityModal } from './src/ui/ActivityModal';
import { MarkdownView } from 'obsidian';
import { PROVIDERS } from './src/providers/catalog';
import { secureStore } from './src/secrets';
import { normalizeSettings } from './src/settings/types';
import { VaultchatView } from './src/ui/ChatView';
import { VaultchatSettingsTab } from './src/ui/SettingsTab';
import type { ChatSession } from './src/chat/types';
import type { VaultChatHost } from './src/host';
import type { ProviderID } from './src/providers/catalog';
import type { VaultchatSettings } from './src/settings/types';

export default class VaultchatPlugin extends Plugin implements VaultChatHost {
  settings!: VaultchatSettings;

  private sessions!: SessionStore;
  index!: VaultIndex;
  history!: OperationHistory;
  planExecutor!: PlanExecutor;

  async onload() {
    this.sessions = new SessionStore(this.app);
    this.history = new OperationHistory(this.app);
    this.planExecutor = new PlanExecutor(this.app);
    await this.loadSettings();

    this.index = new VaultIndex(this.app, () => this.settings.ignoredPaths);
    // Built after the metadata cache has finished its own first pass, so the
    // index is not populated from caches Obsidian has not filled in yet.
    this.app.workspace.onLayoutReady(() => {
      for (const ref of this.index.start()) this.registerEvent(ref);
    });

    this.registerView(VIEW_TYPE_CHAT, leaf => new VaultchatView(leaf, this));
    this.addRibbonIcon('bot', 'Open chat', () => { void this.activateView(); });
    this.addCommand({ id: 'open-chat', name: 'Open chat', callback: () => { void this.activateView(); } });
    this.addCommand({
      id: 'search-vault',
      name: 'Search vault',
      callback: () => { new VaultSearchModal(this.app, this.index).open(); },
    });
    this.registerChatCommands();
    this.addCommand({
      id: 'show-activity',
      name: 'Show activity and undo changes',
      callback: () => { new ActivityModal(this.app, this.history, this.planExecutor).open(); },
    });
    this.addSettingTab(new VaultchatSettingsTab(this.app, this));
  }

  /**
   * Commands that need the chat open (§34).
   *
   * Each one reveals the view, seeds a prompt and stops. None of them sends:
   * a command that fires a request on invocation leaves no room to adjust the
   * question before it goes out.
   */
  private registerChatCommands(): void {
    const withView = (fn: (view: VaultchatView) => void) => {
      void (async () => {
        await this.activateView();
        const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
        const view = leaf?.view;
        if (view instanceof VaultchatView) fn(view);
      })();
    };

    this.addCommand({
      id: 'new-chat',
      name: 'New chat',
      callback: () => { withView(v => { v.newChat(); }); },
    });

    this.addCommand({
      id: 'add-current-note',
      name: 'Add current note to context',
      checkCallback: (checking) => {
        if (!this.app.workspace.getActiveFile()) return false;
        if (!checking) withView(v => { v.addContext({ kind: 'current-note' }); });
        return true;
      },
    });

    this.addCommand({
      id: 'ask-about-note',
      name: 'Ask about current note',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) withView(v => { v.seedPrompt('', [{ kind: 'current-note' }]); });
        return true;
      },
    });

    this.addCommand({
      id: 'summarize-note',
      name: 'Summarize current note',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) {
          withView(v => {
            v.seedPrompt(`Summarize "${file.basename}" in a few bullet points.`,
              [{ kind: 'current-note' }]);
          });
        }
        return true;
      },
    });

    this.addCommand({
      id: 'organize-current-folder',
      name: 'Organize current folder',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) {
          const folder = file.parent?.path ?? '';
          withView(v => {
            v.seedPrompt(
              `Look at the notes in "${folder || 'the vault root'}" and propose how to organize them. `
              + 'Show me the plan before changing anything.',
              [{ kind: 'current-folder', recursive: true }]);
          });
        }
        return true;
      },
    });

    // Selection-aware (§35): the selected text travels as the question itself,
    // so it works even when the selection is not the whole note.
    const withSelection = (
      id: string,
      name: string,
      prompt: (selection: string) => string,
    ) => {
      this.addCommand({
        id,
        name,
        editorCheckCallback: (checking, editor, ctx) => {
          if (!(ctx instanceof MarkdownView)) return false;
          const selection = editor.getSelection().trim();
          if (selection === '') return false;
          if (!checking) withView(v => { v.seedPrompt(prompt(selection)); });
          return true;
        },
      });
    };

    withSelection('explain-selection', 'Explain selection',
      sel => `Explain this:\n\n${sel}`);
    withSelection('rewrite-selection', 'Rewrite selection',
      sel => `Rewrite this more clearly, keeping the meaning:\n\n${sel}`);
    withSelection('note-from-selection', 'Create note from selection',
      sel => `Turn this into a well-structured note. Propose a filename and folder, `
           + `and show me the plan before creating anything.\n\n${sel}`);
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  // ── Settings ────────────────────────────────────────────────────────────

  async loadSettings() {
    const saved = await this.loadData() as Partial<VaultchatSettings> | null;
    this.settings = normalizeSettings(saved);
    await this.migrateKeysToSecureStorage();
    // Persist the normalized shape immediately. Waiting for an unrelated UI
    // change leaves every launch re-running the migration and never produces a
    // durable endpoint profile for an upgraded install.
    await this.saveSettings();
  }

  async saveSettings() { await this.saveData(this.settings); }

  // ── API keys ────────────────────────────────────────────────────────────

  // Moves any plain-text key found in data.json into SecretStorage. A key whose
  // move fails is left in place so the user is never locked out of a provider;
  // the next load tries again.
  private async migrateKeysToSecureStorage(): Promise<void> {
    const store = secureStore(this.app);
    if (!store) return;
    let moved = false;
    for (const id of Object.keys(PROVIDERS) as ProviderID[]) {
      const plain = this.settings.providers[id].apiKey;
      if (!plain) continue;
      try {
        store.setSecret(secretId(id), plain);
        this.settings.providers[id].apiKey = '';
        moved = true;
      } catch { /* keep the plain-text key and retry next load */ }
    }
    if (moved) await this.saveSettings();
  }

  /** Reads from SecretStorage when available, falling back to data.json. */
  getApiKey(id: ProviderID): string {
    const store = secureStore(this.app);
    if (store) {
      try {
        const secret = store.getSecret(secretId(id));
        if (secret) return secret;
      } catch { /* fall through to the plain-text value */ }
    }
    return this.settings.providers[id].apiKey;
  }

  async setApiKey(id: ProviderID, key: string): Promise<void> {
    const store = secureStore(this.app);
    if (store) {
      try {
        store.setSecret(secretId(id), key);
        this.settings.providers[id].apiKey = '';
        await this.saveSettings();
        return;
      } catch { /* fall through to plain text so the key is not silently lost */ }
    }
    this.settings.providers[id].apiKey = key;
    await this.saveSettings();
  }

  getEndpointApiKey(endpointId: string): string {
    const store = secureStore(this.app);
    if (!store) return '';
    try {
      return store.getSecret(endpointSecretId(endpointId)) ?? '';
    } catch {
      return '';
    }
  }

  async setEndpointApiKey(endpointId: string, key: string): Promise<void> {
    const store = secureStore(this.app);
    if (!store) {
      // No secret storage means no safe home for the key. Refusing is better
      // than quietly writing it into data.json, which syncs with the vault.
      new Notice('Vaultchat: this Obsidian version has no secret storage, so the endpoint key was not saved.');
      return;
    }
    try {
      store.setSecret(endpointSecretId(endpointId), key);
    } catch (e) {
      new Notice(`Vaultchat: could not save the endpoint key: ${(e as Error).message}`);
    }
  }

  // ── Session persistence ─────────────────────────────────────────────────

  async saveSession(session: ChatSession): Promise<void> { await this.sessions.save(session); }
  async loadAllSessions(): Promise<ChatSession[]>        { return this.sessions.loadAll(); }
  async deleteSession(id: string): Promise<void>         { await this.sessions.delete(id); }
}
