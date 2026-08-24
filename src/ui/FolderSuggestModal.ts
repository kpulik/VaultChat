import { FuzzySuggestModal, TFolder } from 'obsidian';
import type { App, FuzzyMatch } from 'obsidian';

/**
 * Folder picker, built the same way as the file picker: Enter toggles and the
 * list stays open, so several folders can be attached in one pass.
 */
export class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
  private onToggle: (folder: TFolder, added: boolean) => void;
  private attached: Set<string>;

  constructor(app: App, attached: string[], onToggle: (folder: TFolder, added: boolean) => void) {
    super(app);
    this.attached = new Set(attached);
    this.onToggle = onToggle;
    this.setPlaceholder('Search for a folder. Enter adds or removes, escape closes.');
  }

  getItems(): TFolder[] {
    const out: TFolder[] = [];
    // getAllLoadedFiles includes folders; the vault root is skipped because
    // attaching it would mean "the entire vault", which is its own mode.
    for (const f of this.app.vault.getAllLoadedFiles()) {
      if (f instanceof TFolder && f.path !== '/') out.push(f);
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  getItemText(folder: TFolder): string {
    return folder.path;
  }

  renderSuggestion(match: FuzzyMatch<TFolder>, el: HTMLElement): void {
    super.renderSuggestion(match, el);
    if (this.attached.has(match.item.path)) {
      el.addClass('cs-suggest-added');
      el.createSpan({ cls: 'cs-suggest-check', text: '✓' });
    }
  }

  selectSuggestion(match: FuzzyMatch<TFolder>, _evt: MouseEvent | KeyboardEvent): void {
    const path  = match.item.path;
    const added = !this.attached.has(path);
    if (added) this.attached.add(path); else this.attached.delete(path);
    this.onToggle(match.item, added);
    this.inputEl.dispatchEvent(new Event('input'));
  }

  onChooseItem(): void { /* handled in selectSuggestion so the modal stays open */ }
}
