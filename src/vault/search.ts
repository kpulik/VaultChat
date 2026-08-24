// Vault search and natural-language file matching (§16, §40).
//
// Pure: operates on index entries handed in by the caller, so ranking and --
// more importantly -- the refusal to guess between two similar notes can be
// tested without a vault.

/** What the index knows about one note. Built from Obsidian's metadata cache. */
export interface NoteIndexEntry {
  path:      string;
  basename:  string;
  aliases:   string[];
  tags:      string[];
  headings:  string[];
  mtime:     number;
  /** In-memory search text loaded incrementally from the note body. */
  content?:  string;
}

export interface FileMatch {
  path:       string;
  /** 0..1. Category boundaries are documented on CONFIDENCE below. */
  confidence: number;
  /** Why this matched, in words, so the model and the user see the same reason. */
  reason:     string;
}

export const CONFIDENCE = {
  /** Acceptable to act on without asking. */
  HIGH:   0.8,
  /** Worth offering, not worth acting on alone. */
  MEDIUM: 0.45,
} as const;

/**
 * Two candidates this close together are not distinguishable by the score, so
 * the result is ambiguous no matter how high either one is.
 */
const TIE_WINDOW = 0.15;

export type MatchVerdict =
  | { kind: 'match';     match: FileMatch }
  | { kind: 'ambiguous'; candidates: FileMatch[] }
  | { kind: 'none' };

const norm = (s: string): string => s.trim().toLowerCase();

/** Splits a natural-language reference into comparable terms. */
export function queryTerms(query: string): string[] {
  return norm(query)
    .replace(/\.md$/, '')
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 0);
}

/**
 * Scores one note against a reference like "my networking notes".
 *
 * Exactness beats breadth throughout: an exact basename must always outrank a
 * note that merely contains every term, or "Networking" loses to
 * "Networking notes from last term".
 */
export function scoreEntry(entry: NoteIndexEntry, query: string): FileMatch | null {
  const q     = norm(query).replace(/\.md$/, '');
  const terms = queryTerms(query);
  if (terms.length === 0) return null;

  const base = norm(entry.basename);
  const path = norm(entry.path);

  if (path === q || path === q + '.md') {
    return { path: entry.path, confidence: 1, reason: 'exact path' };
  }
  if (base === q) {
    return { path: entry.path, confidence: 0.95, reason: 'exact filename' };
  }
  const alias = entry.aliases.find(a => norm(a) === q);
  if (alias !== undefined) {
    return { path: entry.path, confidence: 0.9, reason: `alias "${alias}"` };
  }

  const inBase = terms.filter(t => base.includes(t)).length;
  if (inBase === terms.length) {
    return { path: entry.path, confidence: 0.7, reason: 'filename contains every term' };
  }

  const heading = entry.headings.find(h => norm(h) === q);
  if (heading !== undefined) {
    return { path: entry.path, confidence: 0.6, reason: `heading "${heading}"` };
  }

  const tag = entry.tags.find(t => terms.includes(norm(t).replace(/^#/, '')));
  if (tag !== undefined) {
    return { path: entry.path, confidence: 0.5, reason: `tagged ${tag}` };
  }

  const content = norm(entry.content ?? '');
  const inContent = terms.filter(term => content.includes(term)).length;
  if (inContent === terms.length) {
    return { path: entry.path, confidence: 0.45, reason: 'note content contains every term' };
  }
  if (inContent > 0) {
    return {
      path: entry.path,
      confidence: 0.2 + 0.2 * (inContent / terms.length),
      reason: `note content contains ${inContent} of ${terms.length} terms`,
    };
  }

  const inPath = terms.filter(t => path.includes(t)).length;
  if (inPath === terms.length) {
    return { path: entry.path, confidence: 0.45, reason: 'path contains every term' };
  }
  if (inBase > 0) {
    // Partial: scaled so it can never reach the MEDIUM band on its own.
    return {
      path: entry.path,
      confidence: 0.2 + 0.2 * (inBase / terms.length),
      reason: `filename contains ${inBase} of ${terms.length} terms`,
    };
  }

  return null;
}

/** Every note that matches at all, best first. */
export function searchIndex(entries: NoteIndexEntry[], query: string): FileMatch[] {
  return entries
    .map(e => scoreEntry(e, query))
    .filter((m): m is FileMatch => m !== null)
    .sort((a, b) => b.confidence - a.confidence || a.path.localeCompare(b.path));
}

/**
 * Resolves a natural-language file reference, or refuses to.
 *
 * §16: ambiguity must stop execution rather than be guessed. Two notes with
 * indistinguishable scores return `ambiguous` and the caller asks -- picking
 * whichever sorted first would silently edit the wrong note, and the user would
 * have no way to tell it happened.
 */
export function findFile(entries: NoteIndexEntry[], query: string): MatchVerdict {
  const ranked = searchIndex(entries, query);
  if (ranked.length === 0) return { kind: 'none' };

  const best = ranked[0];
  if (best.confidence < CONFIDENCE.MEDIUM) return { kind: 'none' };

  // An exact path is unique by definition, so it is never ambiguous.
  if (best.confidence < 1) {
    const rivals = ranked.filter(m => best.confidence - m.confidence <= TIE_WINDOW);
    if (rivals.length > 1) return { kind: 'ambiguous', candidates: rivals };
  }

  if (best.confidence < CONFIDENCE.HIGH) {
    return { kind: 'ambiguous', candidates: [best] };
  }
  return { kind: 'match', match: best };
}
