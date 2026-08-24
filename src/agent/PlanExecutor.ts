// Runs a plan against the vault (§23, §26).
//
// Two rules shape this file:
//
//  - Nothing is claimed that was not observed. Undo is only offered when the
//    information needed to reverse every step was actually captured first, and
//    link counts come from Obsidian's own rename rather than from a guess.
//  - A failure stops the run and reports exactly how far it got. Silently
//    ploughing on through a half-applied reorganisation is the worst outcome
//    available, so it is the one case this refuses outright.

import { TFile, TFolder } from 'obsidian';
import { applyEdit } from '../core';
import { contentNeededBefore, inverseOf, isPlanUndoable } from './plan';
import { resolveLinkTarget, updateLinksForMove } from '../vault/links';
import type { App } from 'obsidian';
import type { UndoEntry, VaultOperation, VaultPlan } from './plan';

export interface ExecutionReport {
  completed:    VaultOperation[];
  failed:       { op: VaultOperation; error: string } | null;
  /** Operations after the failure, which were deliberately not attempted. */
  notAttempted: VaultOperation[];
  /** Reverse order, ready to replay. Empty when the run is not undoable. */
  undo:         UndoEntry[];
  undoable:     boolean;
  /** Why undo is unavailable, when it is. */
  undoBlockedBy: string | null;
}

export class PlanExecutor {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  /**
   * Predicts which notes a plan's renames and moves will touch, so the preview
   * can say "8 notes affected" before anything runs.
   *
   * The prediction only: the moves themselves go through
   * `fileManager.renameFile`, which is Obsidian's own link-aware rename and
   * respects the user's link settings. Rewriting links here as well would
   * double-write every affected note and could disagree with the app about what
   * a link resolves to.
   */
  async predictLinkUpdates(plan: VaultPlan): Promise<{ path: string; changed: number }[]> {
    const moves = plan.operations.filter(
      (op): op is Extract<VaultOperation, { kind: 'rename_file' | 'move_file' }> =>
        op.kind === 'rename_file' || op.kind === 'move_file');
    if (moves.length === 0) return [];

    const allPaths = this.app.vault.getFiles().map(f => f.path);
    const totals = new Map<string, number>();

    for (const move of moves) {
      const after = allPaths.map(p => (p === move.path ? move.newPath : p));
      const candidates = this.app.vault.getMarkdownFiles()
        .filter(f => f.path !== move.path);

      const files: { path: string; content: string }[] = [];
      for (const file of candidates) {
        const cache = this.app.metadataCache.getFileCache(file);
        const refs = [...(cache?.links ?? []), ...(cache?.embeds ?? [])];
        // Only read notes that link somewhere at all, and only those whose
        // links could plausibly resolve to the file being moved.
        if (refs.length === 0) continue;
        const touches = refs.some(r => {
          const target = r.link.split('#')[0].split('|')[0].trim();
          return resolveLinkTarget(target, allPaths) === move.path;
        });
        if (!touches) continue;
        files.push({ path: file.path, content: await this.app.vault.read(file) });
      }

      for (const update of updateLinksForMove(files, move.path, move.newPath, after)) {
        totals.set(update.path, (totals.get(update.path) ?? 0) + update.changed);
      }
    }

    return [...totals.entries()].map(([path, changed]) => ({ path, changed })).sort(
      (a, b) => a.path.localeCompare(b.path));
  }

  async execute(plan: VaultPlan): Promise<ExecutionReport> {
    // Everything needed to reverse the plan is read up front. Capturing as we
    // go would mean a failure halfway leaves some steps reversible and others
    // not, which is the state that cannot be explained to a user.
    const captured = new Map<string, string | null>();
    for (const op of plan.operations) {
      const path = contentNeededBefore(op);
      if (path === null || captured.has(path)) continue;
      const file = this.file(path);
      if (!file) { captured.set(path, null); continue; }
      try {
        captured.set(path, await this.app.vault.read(file));
      } catch {
        captured.set(path, null);
      }
    }

    const completed: VaultOperation[] = [];
    const undo: UndoEntry[] = [];
    const inverses: (UndoEntry | null)[] = [];

    for (let i = 0; i < plan.operations.length; i++) {
      const op = plan.operations[i];
      try {
        await this.run(op);
      } catch (e) {
        const inverse = isPlanUndoable(inverses) ? undo : [];
        return {
          completed,
          failed:       { op, error: (e as Error).message },
          notAttempted: plan.operations.slice(i + 1),
          undo:         inverse,
          undoable:     inverse.length > 0,
          undoBlockedBy: inverse.length > 0 ? null
            : 'the completed steps were not all reversible',
        };
      }
      completed.push(op);
      const path = contentNeededBefore(op);
      const inverse = inverseOf(op, path === null ? null : captured.get(path) ?? null);
      inverses.push(inverse);
      if (inverse) undo.unshift(inverse);
    }

    const undoable = isPlanUndoable(inverses);
    return {
      completed,
      failed:       null,
      notAttempted: [],
      undo:         undoable ? undo : [],
      undoable,
      undoBlockedBy: undoable ? null
        : 'the contents of at least one changed file could not be read beforehand',
    };
  }

  private async run(op: VaultOperation): Promise<void> {
    switch (op.kind) {
      case 'create_folder': {
        if (this.app.vault.getAbstractFileByPath(op.path) instanceof TFolder) return;
        await this.app.vault.createFolder(op.path);
        return;
      }

      case 'create_file': {
        if (this.file(op.path)) throw new Error(`${op.path} already exists`);
        await this.ensureParent(op.path);
        await this.app.vault.create(op.path, op.content);
        return;
      }

      case 'edit_file': {
        const file = this.mustFile(op.path);
        const before = await this.app.vault.read(file);
        // The same guarantee the edit blocks have always given: an original
        // that appears twice is refused rather than applied to whichever copy
        // happens to come first.
        const result = applyEdit(before, op.original, op.replacement);
        if (result.status === 'not_found') {
          throw new Error(`the text to replace is not in ${op.path}`);
        }
        if (result.status === 'ambiguous') {
          throw new Error(`that text appears ${result.count} times in ${op.path}; nothing was changed`);
        }
        await this.app.vault.modify(file, result.content);
        return;
      }

      case 'update_links': {
        const file = this.mustFile(op.path);
        await this.app.vault.modify(file, op.content);
        return;
      }

      case 'rename_file':
      case 'move_file': {
        const file = this.mustFile(op.path);
        if (this.app.vault.getAbstractFileByPath(op.newPath)) {
          throw new Error(`${op.newPath} already exists`);
        }
        await this.ensureParent(op.newPath);
        // Obsidian's own rename, so links follow exactly as they would if the
        // user had done it by hand in the file explorer.
        await this.app.fileManager.renameFile(file, op.newPath);
        return;
      }

      case 'copy_file': {
        const file = this.mustFile(op.path);
        if (this.app.vault.getAbstractFileByPath(op.newPath)) {
          throw new Error(`${op.newPath} already exists`);
        }
        await this.ensureParent(op.newPath);
        await this.app.vault.copy(file, op.newPath);
        return;
      }

      case 'delete_file': {
        const file = this.mustFile(op.path);
        // Trash, never a hard delete: recoverable from outside the plugin even
        // if this plugin's own undo is unavailable.
        await this.app.fileManager.trashFile(file);
        return;
      }
    }
  }

  /** Replays an undo stack. Reports what could not be reversed. */
  async undo(entries: UndoEntry[]): Promise<{ undone: number; errors: string[] }> {
    let undone = 0;
    const errors: string[] = [];

    for (const entry of entries) {
      try {
        switch (entry.kind) {
          case 'delete_created': {
            const target = this.app.vault.getAbstractFileByPath(entry.path);
            if (target) await this.app.fileManager.trashFile(target);
            break;
          }
          case 'restore_content': {
            await this.app.vault.modify(this.mustFile(entry.path), entry.content);
            break;
          }
          case 'move_back': {
            const file = this.mustFile(entry.from);
            await this.ensureParent(entry.to);
            await this.app.fileManager.renameFile(file, entry.to);
            break;
          }
          case 'recreate': {
            if (this.file(entry.path)) throw new Error(`${entry.path} already exists again`);
            await this.ensureParent(entry.path);
            await this.app.vault.create(entry.path, entry.content);
            break;
          }
        }
        undone++;
      } catch (e) {
        errors.push(`${entry.kind} ${'path' in entry ? entry.path : entry.from}: ${(e as Error).message}`);
      }
    }

    return { undone, errors };
  }

  private file(path: string): TFile | null {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  }

  private mustFile(path: string): TFile {
    const f = this.file(path);
    if (!f) throw new Error(`no note at ${path}`);
    return f;
  }

  private async ensureParent(path: string): Promise<void> {
    const at = path.lastIndexOf('/');
    if (at === -1) return;
    const dir = path.slice(0, at);
    if (dir === '' || this.app.vault.getAbstractFileByPath(dir)) return;
    await this.app.vault.createFolder(dir);
  }
}
