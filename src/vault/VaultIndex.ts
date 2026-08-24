// Incremental vault index (§14).
//
// The Obsidian adapter for the pure matching in search.ts: it turns the
// metadata cache into NoteIndexEntry records and keeps them current.
//
// Obsidian already parses every note, so nothing here re-implements a Markdown
// parser -- headings, tags, aliases, links and embeds all come from
// MetadataCache. Reinventing them would drift from what Obsidian itself thinks
// the vault contains, which is the one thing this must agree with.

import { TFile } from 'obsidian';
import { isIgnoredPath, withConfigDir } from './protected';
import { parseWikilinks } from './links';
import type { App, CachedMetadata, EventRef } from 'obsidian';
import type { NoteIndexEntry } from './search';

/** Everything the index knows, including the parts search.ts does not read. */
export interface IndexedNote extends NoteIndexEntry {
  /** Raw link targets found in the note, as written. */
  links:      string[];
  embeds:     string[];
  properties: Record<string, unknown>;
  size:       number;
}

export class VaultIndex {
  private app: App;
  private notes = new Map<string, IndexedNote>();
  /** target path -> paths that link to it. Rebuilt lazily when notes change. */
  private backlinks = new Map<string, Set<string>>();
  private backlinksStale = true;
  private ignored: () => string[];
  private refs: EventRef[] = [];

  constructor(app: App, ignored: () => string[]) {
    this.app = app;
    this.ignored = ignored;
  }

  /**
   * Builds the index and subscribes to changes.
   *
   * Returns the event refs so the caller can register them for cleanup; the
   * index does not own its own teardown because the plugin already has a
   * lifecycle that does this correctly.
   */
  start(): EventRef[] {
    this.rebuild();

    const { metadataCache, vault } = this.app;
    this.refs = [
      metadataCache.on('changed', (file, _data, cache) => { this.upsert(file, cache); }),
      vault.on('create', file => {
        if (file instanceof TFile) this.upsert(file, metadataCache.getFileCache(file));
      }),
      vault.on('delete', file => { this.remove(file.path); }),
      vault.on('rename', (file, oldPath) => {
        this.remove(oldPath);
        if (file instanceof TFile) this.upsert(file, this.app.metadataCache.getFileCache(file));
      }),
    ];
    return this.refs;
  }

  /** Full scan. Cheap enough at startup; every later change is incremental. */
  rebuild(): void {
    this.notes.clear();
    for (const file of this.app.vault.getMarkdownFiles()) {
      this.upsert(file, this.app.metadataCache.getFileCache(file));
    }
    this.backlinksStale = true;
  }

  private isIndexable(path: string): boolean {
    return !isIgnoredPath(path, withConfigDir(this.ignored(), this.app.vault.configDir));
  }

  private upsert(file: TFile, cache: CachedMetadata | null): void {
    if (file.extension.toLowerCase() !== 'md') { this.remove(file.path); return; }
    if (!this.isIndexable(file.path)) { this.remove(file.path); return; }

    const frontmatter = cache?.frontmatter ?? {};

    // Aliases are a string or a list depending on how the note was written.
    const rawAliases = (frontmatter as { aliases?: unknown }).aliases;
    const aliases = Array.isArray(rawAliases)
      ? rawAliases.filter((a): a is string => typeof a === 'string')
      : typeof rawAliases === 'string' ? [rawAliases] : [];

    // Inline #tags and frontmatter tags are separate places in the cache.
    const inline = (cache?.tags ?? []).map(t => t.tag.replace(/^#/, ''));
    const rawFmTags = (frontmatter as { tags?: unknown }).tags;
    const fmTags = Array.isArray(rawFmTags)
      ? rawFmTags.filter((t): t is string => typeof t === 'string')
      : typeof rawFmTags === 'string' ? rawFmTags.split(/[,\s]+/).filter(Boolean) : [];

    const properties: Record<string, unknown> = { ...frontmatter };
    delete properties.position;

    this.notes.set(file.path, {
      path:     file.path,
      basename: file.basename,
      aliases,
      tags:     [...new Set([...inline, ...fmTags.map(t => t.replace(/^#/, ''))])],
      headings: (cache?.headings ?? []).map(h => h.heading),
      links:    (cache?.links ?? []).map(l => l.link),
      embeds:   (cache?.embeds ?? []).map(e => e.link),
      properties,
      mtime:    file.stat.mtime,
      size:     file.stat.size,
    });
    this.backlinksStale = true;
    void this.loadContent(file, file.stat.mtime);
  }

  /** Loads body text for content search without making startup wait on every note. */
  private async loadContent(file: TFile, mtime: number): Promise<void> {
    try {
      const content = await this.app.vault.read(file);
      const current = this.notes.get(file.path);
      if (current?.mtime === mtime) current.content = content;
    } catch {
      // Metadata remains useful when a note is temporarily unreadable.
    }
  }

  private remove(path: string): void {
    if (this.notes.delete(path)) this.backlinksStale = true;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  entries(): IndexedNote[] {
    return [...this.notes.values()];
  }

  get(path: string): IndexedNote | null {
    return this.notes.get(path) ?? null;
  }

  size(): number {
    return this.notes.size;
  }

  /**
   * Notes linking to `path`.
   *
   * Resolved through Obsidian's own link resolution rather than by comparing
   * link text, so `[[Note]]`, `[[Folder/Note]]` and `[[Note|Alias]]` all count
   * as references to the same file -- which is the whole point of asking.
   */
  backlinksOf(path: string): string[] {
    if (this.backlinksStale) this.rebuildBacklinks();
    return [...(this.backlinks.get(path) ?? [])].sort();
  }

  private rebuildBacklinks(): void {
    this.backlinks.clear();
    for (const note of this.notes.values()) {
      for (const raw of [...note.links, ...note.embeds]) {
        const target = raw.split('#')[0].split('|')[0].trim();
        if (target === '') continue;
        const dest = this.app.metadataCache.getFirstLinkpathDest(target, note.path);
        if (!dest) continue;
        const set = this.backlinks.get(dest.path) ?? new Set<string>();
        set.add(note.path);
        this.backlinks.set(dest.path, set);
      }
    }
    this.backlinksStale = false;
  }

  /** Links in this note that resolve to nothing (§39). */
  unresolvedLinksIn(path: string): string[] {
    const note = this.notes.get(path);
    if (!note) return [];
    return [...note.links, ...note.embeds].filter(raw => !this.referenceResolves(raw, path));
  }

  /** Checks both the note path and a heading or block fragment. */
  private referenceResolves(raw: string, sourcePath: string): boolean {
    const parsed = parseWikilinks(`[[${raw}]]`, false)[0];
    const target = parsed?.target ?? raw.split('#')[0].split('|')[0].trim();
    const destination = target === ''
      ? this.app.vault.getAbstractFileByPath(sourcePath)
      : this.app.metadataCache.getFirstLinkpathDest(target, sourcePath);
    if (!(destination instanceof TFile)) return false;

    const cache = this.app.metadataCache.getFileCache(destination);
    if (parsed?.heading !== undefined) {
      if (!(cache?.headings ?? []).some(h => h.heading.toLowerCase() === parsed.heading?.toLowerCase())) {
        return false;
      }
    }
    if (parsed?.block !== undefined && !cache?.blocks?.[parsed.block]) return false;
    return true;
  }
}
