// The one place context resolution touches Obsidian.
//
// Everything decidable without a vault -- which files a source expands to, what
// fits in the budget -- lives in resolve.ts and is tested there. This reads the
// files and nothing else.

import { TFile } from 'obsidian';
import { applyBudget, resolveSources } from './resolve';
import { isIgnoredPath, withConfigDir } from '../vault/protected';
import type { App } from 'obsidian';
import type { ContextBudget, ContextSource } from './types';

export async function gatherContext(
  app: App,
  sources: ContextSource[],
  activeFilePath: string | null,
  ignoredPaths: string[],
  maxTokens: number,
): Promise<ContextBudget> {
  if (sources.length === 0) {
    return { included: [], skipped: [], estimatedTokens: 0 };
  }

  const ignored  = withConfigDir(ignoredPaths, app.vault.configDir);
  const allPaths = app.vault.getFiles()
    .map(f => f.path)
    .filter(p => !isIgnoredPath(p, ignored));

  const resolved = resolveSources(sources, allPaths, activeFilePath);

  const withContent: { path: string; content: string; reason: string }[] = [];
  const unreadable: { path: string; reason: string }[] = [];

  for (const file of resolved) {
    const tf = app.vault.getAbstractFileByPath(file.path);
    if (!(tf instanceof TFile)) {
      unreadable.push({ path: file.path, reason: 'not a readable file' });
      continue;
    }
    try {
      withContent.push({ path: file.path, content: await app.vault.read(tf), reason: file.reason });
    } catch {
      // A binary or locked file is reported, not silently dropped: the user
      // asked for it, so its absence has to be visible in the inspector.
      unreadable.push({ path: file.path, reason: 'could not be read' });
    }
  }

  const budget = applyBudget(withContent, maxTokens);
  return { ...budget, skipped: [...unreadable, ...budget.skipped] };
}
