// Operation history and its undo stacks (§26).
//
// Kept in the plugin's own config folder, next to the chat sessions, so a
// vault sync carries it and an undo survives a restart.

import type { App } from 'obsidian';
import type { UndoEntry } from './plan';

export interface HistoryEntry {
  id:             string;
  at:             number;
  description:    string;
  operationCount: number;
  affected:       string[];
  undo:           UndoEntry[];
  undoable:       boolean;
  /** Why undo is unavailable, shown instead of a button that would do nothing. */
  undoBlockedBy:  string | null;
  undoneAt?:      number;
}

// Undo stacks hold file contents, so the log is capped by entries rather than
// left to grow with the size of everything the agent has ever touched.
const MAX_ENTRIES = 50;

export class OperationHistory {
  private app: App;
  private entries: HistoryEntry[] = [];
  private loaded = false;

  constructor(app: App) {
    this.app = app;
  }

  private get path(): string {
    return `${this.app.vault.configDir}/plugins/vaultchat/operations.json`;
  }

  async load(): Promise<HistoryEntry[]> {
    if (this.loaded) return this.entries;
    try {
      if (await this.app.vault.adapter.exists(this.path)) {
        const raw = await this.app.vault.adapter.read(this.path);
        const parsed: unknown = JSON.parse(raw);
        this.entries = Array.isArray(parsed) ? parsed as HistoryEntry[] : [];
      }
    } catch {
      // A corrupt log must not stop the plugin loading; it is a record, not state.
      this.entries = [];
    }
    this.loaded = true;
    return this.entries;
  }

  async record(entry: HistoryEntry): Promise<void> {
    await this.load();
    this.entries.unshift(entry);
    this.entries = this.entries.slice(0, MAX_ENTRIES);
    await this.save();
  }

  async markUndone(id: string): Promise<void> {
    await this.load();
    const entry = this.entries.find(e => e.id === id);
    if (!entry) return;
    entry.undoneAt = Date.now();
    // The stack is spent once replayed; keeping it would offer a second undo
    // that would fail or, worse, half-succeed.
    entry.undo = [];
    entry.undoable = false;
    entry.undoBlockedBy = 'already undone';
    await this.save();
  }

  async all(): Promise<HistoryEntry[]> {
    return this.load();
  }

  private async save(): Promise<void> {
    const dir = `${this.app.vault.configDir}/plugins/vaultchat`;
    if (!await this.app.vault.adapter.exists(dir)) {
      await this.app.vault.adapter.mkdir(dir);
    }
    await this.app.vault.adapter.write(this.path, JSON.stringify(this.entries));
  }
}
