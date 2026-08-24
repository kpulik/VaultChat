import { FuzzySuggestModal, TFile } from 'obsidian';
import type { App, FuzzyMatch } from 'obsidian';

// Multi-select file picker. FuzzySuggestModal normally closes on the first
// choice; selectSuggestion is overridden so the list stays open and each Enter
// toggles a note, which is what attaching several notes at once needs. Escape
// finishes. renderSuggestion adds a checkmark for already-attached notes so the
// picker itself shows selection state, not just the chip row underneath it.
export class FileSuggestModal extends FuzzySuggestModal<TFile> {
  private onToggle: (file: TFile, added: boolean) => void;
  private attached: Set<string>;

  constructor(app: App, attached: string[], onToggle: (file: TFile, added: boolean) => void) {
    super(app);
    this.attached = new Set(attached);
    this.onToggle = onToggle;
    this.setPlaceholder('Search for a note. Enter adds or removes, escape closes.');
  }

  getItems(): TFile[] {
    return this.app.vault.getFiles();
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  renderSuggestion(match: FuzzyMatch<TFile>, el: HTMLElement): void {
    super.renderSuggestion(match, el);
    if (this.attached.has(match.item.path)) {
      el.addClass('cs-suggest-added');
      el.createSpan({ cls: 'cs-suggest-check', text: '✓' });
    }
  }

  selectSuggestion(match: FuzzyMatch<TFile>, _evt: MouseEvent | KeyboardEvent): void {
    const path  = match.item.path;
    const added = !this.attached.has(path);
    if (added) this.attached.add(path); else this.attached.delete(path);
    this.onToggle(match.item, added);
    // Re-run the current query so the checkmark updates without closing the modal.
    this.inputEl.dispatchEvent(new Event('input'));
  }

  // Selection is handled in selectSuggestion so the modal can stay open.
  onChooseItem(): void { /* intentionally empty */ }
}
