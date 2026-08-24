import { Modal } from 'obsidian';
import type { App } from 'obsidian';

/** Renames a saved chat. Enter accepts, Escape cancels. */
export class SessionRenameModal extends Modal {
  private value: string;
  private onSubmit: (title: string) => Promise<void>;

  constructor(app: App, current: string, onSubmit: (title: string) => Promise<void>) {
    super(app);
    this.value = current;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    this.setTitle('Rename chat');
    const input = this.contentEl.createEl('input', {
      cls: 'cs-rename-input',
      attr: { type: 'text', placeholder: 'Chat name' },
    });
    input.value = this.value;
    input.focus();
    input.select();

    const submit = () => {
      const title = input.value.trim();
      // An empty name would leave an unlabelled row, so it is simply declined.
      if (title === '') return;
      this.close();
      void this.onSubmit(title);
    };

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });

    const row = this.contentEl.createDiv('cs-plan-buttons');
    row.createEl('button', { cls: 'mod-cta', text: 'Rename' })
      .addEventListener('click', submit);
    row.createEl('button', { text: 'Cancel' })
      .addEventListener('click', () => { this.close(); });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
