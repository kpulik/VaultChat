// Context resolution and budgeting.
//
// Pure: takes a list of vault paths in, gives a list of context files out. No
// Obsidian, no disk, so every inclusion and exclusion rule below is testable.

import type { ContextBudget, ContextSource, ResolvedFile, SkippedFile } from './types';

/** 'School/CS/lecture.md' -> 'School/CS'. A root file gives ''. */
export function parentFolder(path: string): string {
  const at = path.lastIndexOf('/');
  return at === -1 ? '' : path.slice(0, at);
}

/**
 * Is `path` inside `folder`?
 *
 * Compared segment-wise rather than with startsWith, which would put
 * `Notes-old/x.md` inside `Notes`.
 */
export function isInFolder(path: string, folder: string, recursive: boolean): boolean {
  if (folder === '') {
    return recursive ? true : !path.includes('/');
  }
  if (!path.startsWith(folder + '/')) return false;
  return recursive ? true : parentFolder(path) === folder;
}

export function filesInFolder(paths: string[], folder: string, recursive: boolean): string[] {
  return paths.filter(p => isInFolder(p, folder, recursive));
}

/**
 * Turns the configured sources into a concrete, de-duplicated file list.
 *
 * A file reachable from two sources keeps the first reason it was found by, so
 * the inspector explains it once rather than listing it twice.
 */
export function resolveSources(
  sources: ContextSource[],
  allPaths: string[],
  activeFilePath: string | null,
): ResolvedFile[] {
  const out  = new Map<string, ResolvedFile>();
  const add  = (path: string, reason: string) => {
    if (!out.has(path)) out.set(path, { path, reason });
  };

  for (const source of sources) {
    switch (source.kind) {
      case 'entire-vault':
        // This is a capability flag for indexed, on-demand agent search. It
        // deliberately contributes no file contents to the prompt.
        break;
      case 'current-note': {
        if (source.path || activeFilePath) add(source.path ?? activeFilePath!, 'Current note');
        break;
      }
      case 'current-folder': {
        if (!activeFilePath) break;
        const folder = parentFolder(activeFilePath);
        const label  = folder === '' ? 'vault root' : folder;
        for (const p of filesInFolder(allPaths, folder, source.recursive)) {
          add(p, `Current folder (${label})`);
        }
        break;
      }
      case 'file': {
        // Only if it still exists: a chip can outlive the note it points at.
        if (allPaths.includes(source.path)) add(source.path, 'Attached file');
        break;
      }
      case 'folder': {
        for (const p of filesInFolder(allPaths, source.path, source.recursive)) {
          add(p, `Folder (${source.path})`);
        }
        break;
      }
    }
  }

  return [...out.values()];
}

/**
 * Rough token count.
 *
 * Deliberately an estimate: the real count depends on a tokenizer this plugin
 * does not ship, and the number exists to warn before a send, not to bill for
 * one. Four characters per token is close enough for English prose and errs
 * high on code, which is the safe direction.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Fills context up to a token ceiling and reports what did not fit.
 *
 * §11 forbids silently sending a whole folder that will not fit. Anything
 * dropped is returned with a reason so the UI can say so rather than quietly
 * truncating the prompt.
 */
export function applyBudget(
  files: { path: string; content: string; reason: string }[],
  maxTokens: number,
): ContextBudget {
  const included: ContextBudget['included'] = [];
  const skipped:  SkippedFile[] = [];
  let total = 0;

  for (const file of files) {
    const cost = estimateTokens(file.content);
    // A single file larger than the whole budget can never fit; say that
    // plainly rather than reporting it as "no room left".
    if (cost > maxTokens) {
      skipped.push({ path: file.path, reason: `too large on its own (~${cost} tokens)` });
      continue;
    }
    if (total + cost > maxTokens) {
      skipped.push({ path: file.path, reason: 'context budget full' });
      continue;
    }
    included.push(file);
    total += cost;
  }

  return { included, skipped, estimatedTokens: total };
}

/** The `<file>` blocks a request carries, in the shape the prompt expects. */
export function renderContextBlocks(files: { path: string; content: string }[]): string {
  return files.map(f => `<file path="${f.path}">\n${f.content}\n</file>\n\n`).join('');
}
