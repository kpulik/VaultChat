import { Modal, Notice } from 'obsidian';
import { timeAgo } from './format';
import type { App } from 'obsidian';
import type { OperationHistory } from '../agent/history';
import type { PlanExecutor } from '../agent/PlanExecutor';

/**
 * What VaultChat has changed, and what can still be taken back (§26).
 *
 * Every row states plainly whether it is reversible. An entry whose undo
 * information was never captured says so instead of showing a button that
 * would fail -- §26 forbids claiming an operation is undoable when it is not.
 */
export class ActivityModal extends Modal {
  private history: OperationHistory;
  private executor: PlanExecutor;

  constructor(app: App, history: OperationHistory, executor: PlanExecutor) {
    super(app);
    this.history = history;
    this.executor = executor;
  }

  onOpen(): void {
    this.setTitle('Vaultchat activity');
    void this.render();
  }

  private async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();

    const entries = await this.history.all();
    if (entries.length === 0) {
      contentEl.createDiv({ cls: 'cs-activity-empty', text: 'VaultChat has not changed anything yet.' });
      return;
    }

    for (const entry of entries) {
      const row = contentEl.createDiv('cs-activity-row');
      if (entry.undoneAt) row.addClass('cs-activity-row--undone');

      const head = row.createDiv('cs-activity-head');
      head.createSpan({ cls: 'cs-activity-time', text: timeAgo(entry.at) });
      head.createSpan({
        cls: 'cs-activity-desc',
        text: entry.description || `${entry.operationCount} operation(s)`,
      });

      row.createDiv({
        cls: 'cs-activity-meta',
        text: `${entry.operationCount} operation(s) · ${entry.affected.length} file(s)`,
      });

      if (entry.undoneAt) {
        row.createDiv({ cls: 'cs-activity-note', text: `Undone ${timeAgo(entry.undoneAt)}` });
        continue;
      }

      if (!entry.undoable) {
        row.createDiv({
          cls: 'cs-activity-note',
          text: `Cannot be undone — ${entry.undoBlockedBy ?? 'the original state was not captured'}`,
        });
        continue;
      }

      const btn = row.createEl('button', { cls: 'cs-action-btn', text: 'Undo' });
      btn.addEventListener('click', () => {
        btn.disabled = true;
        void (async () => {
          const result = await this.executor.undo(entry.undo);
          await this.history.markUndone(entry.id);
          if (result.errors.length > 0) {
            new Notice(
              `Undid ${result.undone}, but ${result.errors.length} step(s) failed: ${result.errors[0]}`,
              10000);
          } else {
            new Notice(`Undid ${result.undone} operation(s).`);
          }
          await this.render();
        })();
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
