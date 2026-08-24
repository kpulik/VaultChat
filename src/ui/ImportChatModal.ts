import { FuzzySuggestModal, TFile } from 'obsidian';
import type { App, FuzzyMatch } from 'obsidian';

/** Selects a Markdown note to import as a VaultChat conversation. */
export class ImportChatModal extends FuzzySuggestModal<TFile> {
  private readonly onChoose: (file: TFile) => void;

  constructor(app: App, onChoose: (file: TFile) => void) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder('Choose a vaultchat Markdown export…');
  }

  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles();
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  renderSuggestion(match: FuzzyMatch<TFile>, el: HTMLElement): void {
    super.renderSuggestion(match, el);
    el.createSpan({ cls: 'cs-import-file-kind', text: 'Markdown' });
  }

  onChooseItem(file: TFile): void {
    this.onChoose(file);
  }
}
