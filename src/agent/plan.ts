// Vault plans: what a batch of changes is, before any of it happens (§23-26).
//
// Pure. Risk classification, protected-path guarding, the human-readable
// preview and the inverse of every operation are all decided here, without a
// vault, so the rules that gate a destructive change are testable on their own.

import { guardPaths } from '../vault/protected';
import type { ToolRisk } from './types';

export type VaultOperation =
  | { kind: 'create_folder'; path: string }
  | { kind: 'create_file';   path: string; content: string }
  | { kind: 'edit_file';     path: string; original: string; replacement: string }
  | { kind: 'rename_file';   path: string; newPath: string }
  | { kind: 'move_file';     path: string; newPath: string }
  | { kind: 'copy_file';     path: string; newPath: string }
  | { kind: 'delete_file';   path: string }
  // Derived by the link updater, never authored by the model.
  | { kind: 'update_links';  path: string; content: string; changed: number };

export interface VaultPlan {
  id:          string;
  createdAt:   number;
  description: string;
  operations:  VaultOperation[];
}

/** Confirmation tier (§25). */
export type PlanRisk = 'low' | 'moderate' | 'high';

const DESTRUCTIVE = new Set(['delete_file']);

/** Above this, even non-destructive work is broad enough to want reviewing. */
const BULK_THRESHOLD = 5;

/**
 * Every path an operation reads or writes, including destinations.
 *
 * Destinations count: a move into a protected folder is just as much a write to
 * that folder as a delete inside it.
 */
export function operationPaths(op: VaultOperation): string[] {
  switch (op.kind) {
    case 'rename_file':
    case 'move_file':
    case 'copy_file':
      return [op.path, op.newPath];
    default:
      return [op.path];
  }
}

export function affectedFiles(plan: VaultPlan): string[] {
  return [...new Set(plan.operations.flatMap(operationPaths))].sort();
}

/**
 * How much confirmation this plan needs.
 *
 * Any deletion makes a plan high risk on its own, however small; a large batch
 * of anything else does too, because reviewing thirty moves one notice at a
 * time is not review.
 */
export function planRisk(plan: VaultPlan): PlanRisk {
  if (plan.operations.some(op => DESTRUCTIVE.has(op.kind))) return 'high';
  const writes = plan.operations.filter(op => op.kind !== 'update_links');
  if (writes.length > BULK_THRESHOLD) return 'high';
  if (writes.length === 0) return 'low';
  return 'moderate';
}

export function riskOfToolRisk(risk: ToolRisk): PlanRisk {
  return risk === 'read' ? 'low' : risk === 'write' ? 'moderate' : 'high';
}

export interface GuardedPlan {
  /** Operations that may run. */
  allowed: VaultOperation[];
  /** Operations refused, with the pattern that refused them. */
  blocked: { op: VaultOperation; path: string; pattern: string }[];
}

/**
 * Splits a plan against the protected-path list.
 *
 * Returns both halves rather than rejecting the plan outright: a
 * reorganisation that happens to touch one protected file should still be
 * offered for the other twenty-nine, with the exclusion stated.
 */
export function guardPlan(plan: VaultPlan, protectedPaths: string[]): GuardedPlan {
  const allowed: VaultOperation[] = [];
  const blocked: GuardedPlan['blocked'] = [];

  for (const op of plan.operations) {
    const { blocked: hits } = guardPaths(operationPaths(op), protectedPaths);
    if (hits.length === 0) allowed.push(op);
    else blocked.push({ op, path: hits[0].path, pattern: hits[0].pattern });
  }

  return { allowed, blocked };
}

// ── Preview (§24) ───────────────────────────────────────────────────────────

const VERB: Record<VaultOperation['kind'], string> = {
  create_folder: 'CREATE FOLDER',
  create_file:   'CREATE',
  edit_file:     'EDIT',
  rename_file:   'RENAME',
  move_file:     'MOVE',
  copy_file:     'COPY',
  delete_file:   'DELETE',
  update_links:  'UPDATE LINKS',
};

function describeOp(op: VaultOperation): string {
  switch (op.kind) {
    case 'rename_file':
    case 'move_file':
    case 'copy_file':
      return `${op.path} → ${op.newPath}`;
    case 'update_links':
      return `${op.path} (${op.changed} link${op.changed === 1 ? '' : 's'})`;
    default:
      return op.path;
  }
}

/**
 * A grouped, human-readable summary.
 *
 * Compact for a small plan and detailed for a large one, per §24 -- but a
 * deletion is always listed by name, however long the list, because the one
 * thing a user must never have to expand a summary to discover is what is
 * about to be destroyed.
 */
export function previewPlan(plan: VaultPlan, maxPerGroup = 10): string {
  const order: VaultOperation['kind'][] = [
    'create_folder', 'create_file', 'edit_file',
    'rename_file', 'move_file', 'copy_file', 'update_links', 'delete_file',
  ];

  const lines: string[] = [];
  for (const kind of order) {
    const ops = plan.operations.filter(op => op.kind === kind);
    if (ops.length === 0) continue;

    lines.push(ops.length === 1 ? VERB[kind] : `${VERB[kind]} ${ops.length} files`);

    const limit = kind === 'delete_file' ? ops.length : maxPerGroup;
    for (const op of ops.slice(0, limit)) lines.push(`  ${describeOp(op)}`);
    if (ops.length > limit) lines.push(`  … and ${ops.length - limit} more`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

// ── Undo (§26) ──────────────────────────────────────────────────────────────

/**
 * What has to be captured before an operation runs for it to be reversible.
 *
 * `null` means the operation cannot be undone, and §26 forbids claiming
 * otherwise -- so the executor records that honestly rather than offering an
 * Undo button that would silently do nothing.
 */
export type UndoEntry =
  | { kind: 'delete_created';  path: string }
  | { kind: 'restore_content'; path: string; content: string }
  | { kind: 'move_back';       from: string; to: string }
  | { kind: 'recreate';        path: string; content: string };

/** Content the executor must read before an operation, to be able to reverse it. */
export function contentNeededBefore(op: VaultOperation): string | null {
  switch (op.kind) {
    case 'edit_file':
    case 'delete_file':
    case 'update_links':
      return op.path;
    default:
      return null;
  }
}

export function inverseOf(op: VaultOperation, capturedContent: string | null): UndoEntry | null {
  switch (op.kind) {
    case 'create_file':
    case 'create_folder':
      return { kind: 'delete_created', path: op.path };

    case 'edit_file':
    case 'update_links':
      // Undoable only if the previous contents were actually read first.
      return capturedContent === null
        ? null
        : { kind: 'restore_content', path: op.path, content: capturedContent };

    case 'rename_file':
    case 'move_file':
      return { kind: 'move_back', from: op.newPath, to: op.path };

    case 'copy_file':
      return { kind: 'delete_created', path: op.newPath };

    case 'delete_file':
      // Obsidian trashes rather than shreds, but the plugin can only promise a
      // restore when it holds the contents itself.
      return capturedContent === null
        ? null
        : { kind: 'recreate', path: op.path, content: capturedContent };
  }
}

export function isPlanUndoable(entries: (UndoEntry | null)[]): boolean {
  return entries.length > 0 && entries.every(e => e !== null);
}

// ── Building plans from tool calls ──────────────────────────────────────────

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

function parentOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at === -1 ? '' : path.slice(0, at);
}

/** Joins a folder and a name, treating the vault root as a real folder. */
export function joinPath(folder: string, name: string): string {
  return folder === '' ? name : `${folder}/${name}`;
}

/**
 * Turns one validated write call into the operations it means.
 *
 * A batch expands into individual operations here rather than staying a single
 * opaque step, so the preview lists every file by name and the executor can
 * report exactly which one failed.
 *
 * Returns null for a tool that is not a write, which is how the caller tells
 * read calls and write calls apart without a second lookup.
 */
export function operationsFromCall(
  tool: string,
  args: Record<string, unknown>,
): VaultOperation[] | null {
  // Narrowed rather than coerced: validateCall has already type-checked these,
  // but String() on an unknown would turn a stray object into "[object Object]"
  // and write that into a path.
  const str = (k: string): string => (typeof args[k] === 'string' ? args[k] : '');
  const list = (k: string): string[] => Array.isArray(args[k]) ? args[k] as string[] : [];

  switch (tool) {
    case 'create_folder':
      return [{ kind: 'create_folder', path: str('path') }];

    case 'create_file':
      return [{ kind: 'create_file', path: str('path'), content: str('content') }];

    case 'edit_file':
      return [{
        kind: 'edit_file',
        path: str('path'),
        original: str('original'),
        replacement: str('replacement'),
      }];

    case 'rename_file': {
      // A rename keeps the note where it is; only the filename changes.
      const path = str('path');
      const name = basename(str('newName'));
      if (name === '') return [];
      return [{ kind: 'rename_file', path, newPath: joinPath(parentOf(path), name) }];
    }

    case 'move_file': {
      const path = str('path');
      return [{ kind: 'move_file', path, newPath: joinPath(str('destFolder'), basename(path)) }];
    }

    case 'copy_file':
      return [{ kind: 'copy_file', path: str('path'), newPath: str('destPath') }];

    case 'delete_file':
      return [{ kind: 'delete_file', path: str('path') }];

    case 'batch_move': {
      const dest = str('destFolder');
      return list('paths').map(path => ({
        kind: 'move_file' as const,
        path,
        newPath: joinPath(dest, basename(path)),
      }));
    }

    case 'batch_delete':
      return list('paths').map(path => ({ kind: 'delete_file' as const, path }));

    case 'batch_rename': {
      const find = str('find');
      const replace = str('replace');
      if (find === '') return [];
      return list('paths').flatMap(path => {
        // Literal, via split/join: a model-supplied string is not a pattern,
        // and treating it as one would let "." rewrite every character.
        const name = basename(path);
        const renamed = name.split(find).join(replace);
        if (renamed === name || renamed === '') return [];
        return [{
          kind: 'rename_file' as const,
          path,
          newPath: joinPath(parentOf(path), basename(renamed)),
        }];
      });
    }

    case 'batch_edit': {
      const original = str('original');
      if (original === '') return [];
      return list('paths').map(path => ({
        kind: 'edit_file' as const,
        path,
        original,
        replacement: str('replacement'),
      }));
    }

    default:
      return null;
  }
}

/** Drops operations that would move or copy a file onto itself. */
export function pruneNoOps(ops: VaultOperation[]): VaultOperation[] {
  return ops.filter(op => {
    if (op.kind === 'move_file' || op.kind === 'rename_file' || op.kind === 'copy_file') {
      return op.path !== op.newPath;
    }
    return true;
  });
}
