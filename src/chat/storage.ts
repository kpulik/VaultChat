import { generateId } from '../ids';
import { migrateSession } from './migrate';
import type { App } from 'obsidian';
import type { ChatSession } from './types';

/**
 * Chat sessions are one JSON file each under the plugin's config folder, so a
 * corrupt or hand-edited session can never take the rest of the history with it.
 */
export class SessionStore {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  private get dir(): string {
    return `${this.app.vault.configDir}/plugins/vaultchat/history`;
  }

  private async ensureDir(): Promise<void> {
    if (!await this.app.vault.adapter.exists(this.dir)) {
      await this.app.vault.adapter.mkdir(this.dir);
    }
  }

  async save(session: ChatSession): Promise<void> {
    await this.ensureDir();
    await this.app.vault.adapter.write(
      `${this.dir}/${session.id}.json`,
      JSON.stringify(session),
    );
  }

  async loadAll(): Promise<ChatSession[]> {
    await this.ensureDir();
    try {
      const listed = await this.app.vault.adapter.list(this.dir);
      const sessions: ChatSession[] = [];
      for (const path of listed.files) {
        if (!path.endsWith('.json')) continue;
        try {
          const raw = await this.app.vault.adapter.read(path);
          const parsed = JSON.parse(raw) as unknown;
          // Pre-2.0 sessions are flat transcripts; they are read back as a
          // single-branch tree so no existing chat is lost on upgrade.
          const session = migrateSession(parsed, generateId);
          if (session) {
            sessions.push(session);
            if (typeof parsed !== 'object' || parsed === null || !('version' in parsed)
                || (parsed as { version?: unknown }).version !== 2) {
              await this.app.vault.adapter.write(path, JSON.stringify(session));
            }
          }
        } catch { /* skip corrupt files */ }
      }
      return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }

  async delete(id: string): Promise<void> {
    const path = `${this.dir}/${id}.json`;
    if (await this.app.vault.adapter.exists(path)) {
      await this.app.vault.adapter.remove(path);
    }
  }
}
