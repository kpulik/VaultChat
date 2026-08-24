import { Notice, TFile } from 'obsidian';
import { applyEdit } from '../core';
import type { App } from 'obsidian';
import type { DeleteBlock, EditBlock } from '../core';

/**
 * The reviewable-write surface: everything that turns a model-proposed edit or
 * deletion into an actual vault change.
 *
 * Split out of the chat view because it is the security-sensitive half and
 * benefits from being readable on its own -- ambiguity refusal, the
 * confirm/revert pair, and the two-step delete all live here and nowhere else.
 *
 * Holds no state of its own: the auto-apply flag is read through a callback so
 * a change in settings takes effect on the next message without the view having
 * to rebuild anything.
 */
export class VaultEditActions {
  private app: App;
  private autoApply: () => boolean;

  constructor(app: App, autoApply: () => boolean) {
    this.app = app;
    this.autoApply = autoApply;
  }

  renderEdits(bubble: HTMLElement, editBlocks: EditBlock[]) {
    for (const block of editBlocks) {
      if (this.autoApply()) {
        void this.autoApplyEdit(bubble, block);
      } else {
        this.manualApplyEdit(bubble, block);
      }
    }
  }

  // Manual mode -show Preview + Apply buttons (user must click Apply)
  private manualApplyEdit(bubble: HTMLElement, block: EditBlock) {
    const bar = bubble.createDiv('cs-edit-bar');
    bar.createSpan({ cls: 'cs-edit-file', text: block.filePath });

    const previewBtn = bar.createEl('button', { cls: 'cs-action-btn', text: 'Preview' });
    const applyBtn   = bar.createEl('button', { cls: 'cs-action-btn cs-apply-btn', text: 'Apply' });
    const diffEl     = bubble.createDiv('cs-diff-container');
    diffEl.addClass('cs-hidden');

    previewBtn.addEventListener('click', () => {
      const visible = !diffEl.hasClass('cs-hidden');
      diffEl.toggleClass('cs-hidden', visible);
      previewBtn.textContent = visible ? 'Preview' : 'Hide';
      if (!visible) {
        diffEl.empty();
        for (const edit of block.edits) {
          if (edit.original) {
            diffEl.createDiv('cs-diff-removed').textContent = edit.original;
          }
          diffEl.createDiv('cs-diff-added').textContent = edit.replacement;
        }
      }
    });

    applyBtn.addEventListener('click', () => {
      void (async () => {
        const abstractFile = this.app.vault.getAbstractFileByPath(block.filePath);
        const isNewFile = !abstractFile || !(abstractFile instanceof TFile);

        if (isNewFile && block.edits.length === 1 && block.edits[0].original === '') {
          try {
            const dir = block.filePath.substring(0, block.filePath.lastIndexOf('/'));
            if (dir) {
              const exists = await this.app.vault.adapter.exists(dir);
              if (!exists) await this.app.vault.adapter.mkdir(dir);
            }
            await this.app.vault.create(block.filePath, block.edits[0].replacement);
            applyBtn.textContent = '✓ created';
            applyBtn.disabled = true;
            new Notice(`Created ${block.filePath}`);
          } catch (e) {
            new Notice(`Failed to create file: ${(e as Error).message}`);
          }
        } else if (!isNewFile) {
          try {
            let content = await this.app.vault.read(abstractFile);
            let applied = 0;
            for (const edit of block.edits) {
              const r = applyEdit(content, edit.original, edit.replacement);
              if (r.status === 'ambiguous') {
                new Notice(`That text appears ${r.count} times in ${block.filePath}. Nothing was changed; ask for more surrounding context.`);
                return;
              }
              if (r.status === 'applied') { content = r.content; applied++; }
            }
            if (applied === 0) {
              new Notice(`Could not find the original text in ${block.filePath}.`);
              return;
            }
            await this.app.vault.modify(abstractFile, content);
            applyBtn.textContent = `✓ applied ${applied}/${block.edits.length}`;
            applyBtn.disabled = true;
            new Notice(`Applied ${applied} edit(s) to ${block.filePath}`);
          } catch (e) {
            new Notice(`Error: ${(e as Error).message}`);
          }
        } else {
          new Notice(`File not found: ${block.filePath}`);
        }
      })();
    });
  }

  private async autoApplyEdit(bubble: HTMLElement, block: EditBlock) {
    const bar = bubble.createDiv('cs-edit-bar');
    bar.createSpan({ cls: 'cs-edit-file', text: block.filePath });
    const statusEl = bar.createSpan({ cls: 'cs-edit-status' });

    const abstractFile = this.app.vault.getAbstractFileByPath(block.filePath);
    const isNewFile = !abstractFile || !(abstractFile instanceof TFile);
    let originalContent: string | null = null;
    let success = false;

    if (isNewFile) {
      // Creating a new file
      if (block.edits.length === 1 && block.edits[0].original === '') {
        try {
          const dir = block.filePath.substring(0, block.filePath.lastIndexOf('/'));
          if (dir) {
            const exists = await this.app.vault.adapter.exists(dir);
            if (!exists) await this.app.vault.adapter.mkdir(dir);
          }
          await this.app.vault.create(block.filePath, block.edits[0].replacement);
          originalContent = null; // revert = delete
          success = true;
          new Notice(`Created ${block.filePath}`);
        } catch (e) {
          statusEl.textContent = `✗ failed to create`;
          statusEl.addClass('cs-edit-error');
          new Notice(`Failed to create file: ${(e as Error).message}`);
          return;
        }
      } else {
        statusEl.textContent = '✗ file not found';
        statusEl.addClass('cs-edit-error');
        new Notice(`File not found: ${block.filePath}`);
        return;
      }
    } else {
      // Editing an existing file -save original, then apply
      try {
        originalContent = await this.app.vault.read(abstractFile);
        let content = originalContent;
        let applied = 0;

        let ambiguous = 0;
        for (const edit of block.edits) {
          const r = applyEdit(content, edit.original, edit.replacement);
          if (r.status === 'ambiguous') { ambiguous = r.count; break; }
          if (r.status === 'applied') { content = r.content; applied++; }
        }

        if (ambiguous > 0) {
          statusEl.textContent = `✗ text appears ${ambiguous} times, nothing changed`;
          statusEl.addClass('cs-edit-error');
          new Notice(`That text appears ${ambiguous} times in ${block.filePath}. Nothing was changed; ask for more surrounding context.`);
          return;
        }

        if (applied === 0) {
          statusEl.textContent = '✗ could not match original text';
          statusEl.addClass('cs-edit-error');
          new Notice(`Could not find the original text in ${block.filePath}. The file may have changed.`);
          return;
        }

        await this.app.vault.modify(abstractFile, content);
        success = true;
        new Notice(`Applied ${applied} edit(s) to ${block.filePath}`);
      } catch (e) {
        statusEl.textContent = '✗ error';
        statusEl.addClass('cs-edit-error');
        new Notice(`Error applying edit: ${(e as Error).message}`);
        return;
      }
    }

    if (!success) return;

    statusEl.textContent = isNewFile ? '✓ created' : '✓ applied';
    statusEl.addClass('cs-edit-success');

    // Show diff
    const diffEl = bubble.createDiv('cs-diff-container');
    for (const edit of block.edits) {
      if (edit.original) {
        const rem = diffEl.createDiv('cs-diff-removed');
        rem.textContent = edit.original;
      }
      const add = diffEl.createDiv('cs-diff-added');
      add.textContent = edit.replacement;
    }

    // Confirm / Revert buttons
    const btnRow = bubble.createDiv('cs-edit-confirm-row');
    const confirmBtn = btnRow.createEl('button', { cls: 'cs-action-btn cs-confirm-btn', text: 'Confirm' });
    const revertBtn  = btnRow.createEl('button', { cls: 'cs-action-btn cs-revert-btn', text: 'Revert' });

    const finish = () => {
      confirmBtn.remove();
      revertBtn.remove();
      diffEl.remove();
    };

    confirmBtn.addEventListener('click', () => {
      statusEl.textContent = isNewFile ? '✓ created - confirmed' : '✓ applied - confirmed';
      new Notice(`Changes to ${block.filePath} confirmed`);
      finish();
    });

    revertBtn.addEventListener('click', () => {
      void (async () => {
        try {
          if (isNewFile) {
            const created = this.app.vault.getAbstractFileByPath(block.filePath);
            if (created && created instanceof TFile) {
              await this.app.fileManager.trashFile(created);
            }
            statusEl.textContent = '↩ Reverted - file deleted';
          } else if (originalContent !== null) {
            const file = this.app.vault.getAbstractFileByPath(block.filePath);
            if (file && file instanceof TFile) {
              await this.app.vault.modify(file, originalContent);
            }
            statusEl.textContent = '↩ Reverted';
          }
          statusEl.removeClass('cs-edit-success');
          statusEl.addClass('cs-edit-reverted');
          new Notice(`Reverted changes to ${block.filePath}`);
          finish();
        } catch (e) {
          new Notice(`Failed to revert: ${(e as Error).message}`);
        }
      })();
    });
  }

  // ── Delete actions ────────────────────────────────────────────────────────

  renderDeletes(bubble: HTMLElement, deleteBlocks: DeleteBlock[]) {
    for (const block of deleteBlocks) {
      const container = bubble.createDiv('cs-delete-block');
      const header = container.createDiv('cs-delete-header');
      header.createSpan({ cls: 'cs-delete-icon', text: '⚠' });
      header.createSpan({ text: `Delete ${block.filePaths.length} file${block.filePaths.length > 1 ? 's' : ''}` });

      // List each file
      const list = container.createDiv('cs-delete-list');
      for (const fp of block.filePaths) {
        const item = list.createDiv('cs-delete-item');
        item.textContent = fp;
      }

      // First confirm button
      const btnRow = container.createDiv('cs-edit-confirm-row');
      const deleteBtn = btnRow.createEl('button', { cls: 'cs-action-btn cs-revert-btn', text: 'Delete' });
      const cancelBtn = btnRow.createEl('button', { cls: 'cs-action-btn', text: 'Cancel' });
      const statusEl = container.createDiv('cs-delete-status');

      cancelBtn.addEventListener('click', () => {
        statusEl.textContent = 'Cancelled -no files deleted';
        statusEl.addClass('cs-edit-reverted');
        deleteBtn.remove();
        cancelBtn.remove();
      });

      deleteBtn.addEventListener('click', () => {
        // Replace with second confirmation
        deleteBtn.remove();
        cancelBtn.remove();

        const warning = container.createDiv('cs-delete-warning');
        warning.textContent = 'Are you sure? This cannot be undone.';

        const btnRow2 = container.createDiv('cs-edit-confirm-row');
        const confirmBtn = btnRow2.createEl('button', { cls: 'cs-action-btn cs-delete-confirm-final', text: 'Yes, delete permanently' });
        const cancel2Btn = btnRow2.createEl('button', { cls: 'cs-action-btn', text: 'Cancel' });

        cancel2Btn.addEventListener('click', () => {
          warning.remove();
          confirmBtn.remove();
          cancel2Btn.remove();
          btnRow2.remove();
          statusEl.textContent = 'Cancelled -no files deleted';
          statusEl.addClass('cs-edit-reverted');
        });

        confirmBtn.addEventListener('click', () => {
          void (async () => {
            warning.remove();
            confirmBtn.remove();
            cancel2Btn.remove();
            btnRow2.remove();

            let deleted = 0;
            const errors: string[] = [];

            for (const fp of block.filePaths) {
              const file = this.app.vault.getAbstractFileByPath(fp);
              if (file && file instanceof TFile) {
                try {
                  await this.app.fileManager.trashFile(file);
                  deleted++;
                } catch (e) {
                  errors.push(`${fp}: ${(e as Error).message}`);
                }
              } else {
                errors.push(`${fp}: not found`);
              }
            }

            if (deleted > 0) {
              statusEl.textContent = `Deleted ${deleted} file${deleted > 1 ? 's' : ''}`;
              statusEl.addClass('cs-edit-success');
              new Notice(`Deleted ${deleted} file${deleted > 1 ? 's' : ''}`);
            }
            if (errors.length > 0) {
              for (const err of errors) {
                const errEl = container.createDiv('cs-delete-error');
                errEl.textContent = err;
              }
            }
          })();
        });
      });
    }
  }
}
