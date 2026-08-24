import { SuggestModal, TFile } from 'obsidian';
import { searchIndex } from '../vault/search';
import type { App } from 'obsidian';
import type { VaultIndex } from '../vault/VaultIndex';
import type { FileMatch } from '../vault/search';

/**
 * Natural-language note search (§15, §40).
 *
 * Ranks by the same scorer the agent uses, and shows the reason each note
 * matched. Showing the reason is not decoration: it is how a user can tell an
 * alias hit from a filename hit, and therefore whether the top result is the
 * note they meant.
 */
export class VaultSearchModal extends SuggestModal<FileMatch> {
  private index: VaultIndex;

  constructor(app: App, index: VaultIndex) {
    super(app);
    this.index = index;
    this.setPlaceholder('Describe the note: a name, an alias, a tag, a heading…');
  }

  getSuggestions(query: string): FileMatch[] {
    if (query.trim() === '') return [];
    return searchIndex(this.index.entries(), query).slice(0, 50);
  }

  renderSuggestion(match: FileMatch, el: HTMLElement): void {
    el.createDiv({ cls: 'cs-search-path', text: match.path });
    const meta = el.createDiv({ cls: 'cs-search-meta' });
    meta.createSpan({ text: match.reason });
    meta.createSpan({
      cls: 'cs-search-score',
      text: `${Math.round(match.confidence * 100)}%`,
    });
  }

  onChooseSuggestion(match: FileMatch): void {
    const file = this.app.vault.getAbstractFileByPath(match.path);
    if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
  }
}
