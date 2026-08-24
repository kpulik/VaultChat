// Runs validated tool calls against the vault (§17, §43).
//
// Only the read tier is executed here. Writes are defined in the registry but
// are collected by ChatView into a reviewed plan before PlanExecutor can touch
// the vault. Keeping that boundary here prevents a model response from gaining
// an inline write path.

import { TFile, TFolder, normalizePath } from 'obsidian';
import { validateCall } from './registry';
import { findFile, searchIndex } from '../vault/search';
import {
  analyseLinkHealth,
  findDuplicateNames,
  findIdenticalContent,
  findNearDuplicates,
} from '../vault/analysis';
import { isInFolder } from '../context/resolve';
import { estimateTokens } from '../context/resolve';
import { parseWikilinks } from '../vault/links';
import type { App } from 'obsidian';
import type { ToolCall, ToolResult } from './types';
import type { VaultIndex } from '../vault/VaultIndex';

/** Caps a read_folder so one call cannot swallow the context window. */
const FOLDER_READ_MAX_TOKENS = 12000;

/**
 * Near-duplicate detection compares every pair, so a large vault is sampled
 * rather than left to run for minutes on the UI thread. The cap is reported in
 * the result, because a partial scan presented as a complete one is exactly the
 * false claim §52 forbids.
 */
const DUPLICATE_SCAN_LIMIT = 400;

export class ToolExecutor {
  private app: App;
  private index: VaultIndex;

  constructor(app: App, index: VaultIndex) {
    this.app = app;
    this.index = index;
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const checked = validateCall(call, normalizePath);
    if (!checked.ok) return { ok: false, id: call.id, tool: call.tool, error: checked.error };

    const a = checked.args;
    const fail = (kind: 'not_found' | 'failed', message: string): ToolResult =>
      ({ ok: false, id: call.id, tool: call.tool, error: { kind, message } });
    const done = (data: unknown): ToolResult => ({ ok: true, id: call.id, tool: call.tool, data });

    try {
      switch (call.tool) {
        case 'search_vault': {
          const hits = searchIndex(this.index.entries(), a.query as string).slice(0, 25);
          return done({ query: a.query, count: hits.length, matches: hits });
        }

        case 'find_file': {
          const verdict = findFile(this.index.entries(), a.query as string);
          if (verdict.kind === 'none') {
            return fail('not_found', `Nothing in the vault matches "${String(a.query)}".`);
          }
          if (verdict.kind === 'ambiguous') {
            // Handed back as an error on purpose: the model must ask rather
            // than pick, and a success-shaped result invites picking (§16).
            return { ok: false, id: call.id, tool: call.tool, error: {
              kind: 'ambiguous',
              message: `"${String(a.query)}" matches more than one note. Ask the user which one.`,
              candidates: verdict.candidates.map(c => ({ path: c.path, reason: c.reason })),
            } };
          }
          return done(verdict.match);
        }

        case 'read_file': {
          const file = this.file(a.path as string);
          if (!file) return fail('not_found', `No note at "${String(a.path)}".`);
          return done({ path: file.path, content: await this.app.vault.read(file) });
        }

        case 'list_folder': {
          const paths = this.inFolder(a.path as string, a.recursive === true);
          return done({ folder: a.path, count: paths.length, files: paths });
        }

        case 'read_folder': {
          const paths = this.inFolder(a.path as string, a.recursive === true);
          const files: { path: string; content: string }[] = [];
          const skipped: string[] = [];
          let tokens = 0;
          for (const path of paths) {
            const file = this.file(path);
            if (!file) { skipped.push(path); continue; }
            const content = await this.app.vault.read(file);
            const cost = estimateTokens(content);
            // Reported rather than silently dropped, so the model knows its
            // view of the folder is partial and can read the rest by path.
            if (tokens + cost > FOLDER_READ_MAX_TOKENS) { skipped.push(path); continue; }
            files.push({ path, content });
            tokens += cost;
          }
          return done({ folder: a.path, files, skippedForSize: skipped, estimatedTokens: tokens });
        }

        case 'get_note_metadata': {
          const note = this.index.get(a.path as string);
          if (!note) return fail('not_found', `No indexed note at "${String(a.path)}".`);
          return done({
            path: note.path, basename: note.basename, aliases: note.aliases,
            tags: note.tags, headings: note.headings, properties: note.properties,
            size: note.size, mtime: note.mtime,
          });
        }

        case 'get_backlinks': {
          if (!this.index.get(a.path as string)) {
            return fail('not_found', `No indexed note at "${String(a.path)}".`);
          }
          const backlinks = this.index.backlinksOf(a.path as string);
          return done({ path: a.path, count: backlinks.length, backlinks });
        }

        case 'get_links': {
          const note = this.index.get(a.path as string);
          if (!note) return fail('not_found', `No indexed note at "${String(a.path)}".`);
          const resolve = (raw: string) => {
            const parsed = parseWikilinks(`[[${raw}]]`, false)[0];
            const target = parsed?.target ?? raw.split('#')[0].split('|')[0].trim();
            const candidate = target === ''
              ? this.app.vault.getAbstractFileByPath(note.path)
              : this.app.metadataCache.getFirstLinkpathDest(target, note.path);
            const dest = candidate instanceof TFile ? candidate : null;
            const cache = dest ? this.app.metadataCache.getFileCache(dest) : null;
            const headingExists = parsed?.heading === undefined
              ? true
              : Boolean(cache?.headings?.some(h => h.heading.toLowerCase() === parsed.heading?.toLowerCase()));
            const blockExists = parsed?.block === undefined
              ? true
              : Boolean(cache?.blocks?.[parsed.block]);
            return {
              link: raw,
              target,
              resolvesTo: dest?.path ?? null,
              heading: parsed?.heading ?? null,
              headingExists: dest ? headingExists : false,
              block: parsed?.block ?? null,
              blockExists: dest ? blockExists : false,
              fragmentResolved: Boolean(dest && headingExists && blockExists),
            };
          };
          return done({
            path: note.path,
            links:  note.links.map(resolve),
            embeds: note.embeds.map(resolve),
          });
        }

        case 'find_duplicates': {
          const all = this.app.vault.getMarkdownFiles();
          const scanned = all.slice(0, DUPLICATE_SCAN_LIMIT);
          const notes: { path: string; content: string }[] = [];
          for (const file of scanned) {
            notes.push({ path: file.path, content: await this.app.vault.read(file) });
          }
          return done({
            sameName:  findDuplicateNames(all.map(f => f.path)),
            identical: findIdenticalContent(notes),
            near:      findNearDuplicates(notes, 0.8).slice(0, 25),
            scanned:   scanned.length,
            totalNotes: all.length,
            complete:  scanned.length === all.length,
            note: 'Reported only. Propose a consolidation for the user to review; never delete a duplicate on your own.',
          });
        }

        case 'check_link_health': {
          const paths = this.index.entries().map(e => e.path);
          const health = analyseLinkHealth(
            paths,
            p2 => this.index.backlinksOf(p2),
            p2 => this.index.unresolvedLinksIn(p2));
          return done({
            ...health,
            brokenBy: health.brokenBy.slice(0, 50),
            orphans:  health.orphans.slice(0, 50),
            note: 'A note with no backlinks is not necessarily a problem; index and daily notes legitimately have none.',
          });
        }

        case 'get_unresolved_links': {
          if (!this.index.get(a.path as string)) {
            return fail('not_found', `No indexed note at "${String(a.path)}".`);
          }
          const unresolved = this.index.unresolvedLinksIn(a.path as string);
          return done({ path: a.path, count: unresolved.length, unresolved });
        }

        default:
          // A registry entry with no executor. Says so plainly rather than
          // reporting a silent success the vault never saw.
          return fail('failed',
            `"${call.tool}" must be queued through a reviewed vault plan.`);
      }
    } catch (e) {
      return fail('failed', (e as Error).message);
    }
  }

  private file(path: string): TFile | null {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  }

  /** Folder contents by path, whether or not the folder object exists. */
  private inFolder(folder: string, recursive: boolean): string[] {
    const target = this.app.vault.getAbstractFileByPath(folder);
    if (folder !== '' && !(target instanceof TFolder)) return [];
    return this.app.vault.getFiles()
      .map(f => f.path)
      .filter(p => isInFolder(p, folder, recursive))
      .sort();
  }
}
