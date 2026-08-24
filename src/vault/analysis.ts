// Vault health analysis (§38, §39).
//
// Pure: takes note records in, returns findings out. These drive *proposals*
// only -- §38 is explicit that duplicates are never deleted automatically, so
// nothing here decides anything, it only reports.

export interface AnalysedNote {
  path:    string;
  content: string;
}

export interface DuplicateGroup {
  /** Why these are grouped: an identical name, or identical content. */
  reason: 'same name' | 'identical content';
  key:    string;
  paths:  string[];
}

const basename = (path: string): string =>
  (path.split('/').pop() ?? path).replace(/\.md$/i, '');

/**
 * Notes sharing a filename in different folders.
 *
 * Common and often deliberate (an index note per folder), so this is reported
 * as something to look at, never as something to fix.
 */
export function findDuplicateNames(paths: string[]): DuplicateGroup[] {
  const byName = new Map<string, string[]>();
  for (const path of paths) {
    const key = basename(path).toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), path]);
  }
  return [...byName.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => ({ reason: 'same name' as const, key, paths: group.sort() }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Content reduced to what a reader would call "the same note".
 *
 * Whitespace and case are normalised so a reformatted copy still matches; the
 * frontmatter block is dropped because two genuine copies routinely differ only
 * by their created/modified dates.
 */
export function contentFingerprint(text: string): string {
  return text
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function findIdenticalContent(notes: AnalysedNote[]): DuplicateGroup[] {
  const byPrint = new Map<string, string[]>();
  for (const note of notes) {
    const print = contentFingerprint(note.content);
    // An empty note is not a duplicate of every other empty note in any useful
    // sense, so they are left out rather than reported as one huge group.
    if (print === '') continue;
    byPrint.set(print, [...(byPrint.get(print) ?? []), note.path]);
  }
  return [...byPrint.values()]
    .filter(group => group.length > 1)
    .map(group => ({
      reason: 'identical content' as const,
      key: group[0],
      paths: group.sort(),
    }));
}

/** Word set for similarity, with very short words dropped as noise. */
export function wordSet(text: string): Set<string> {
  return new Set(
    contentFingerprint(text)
      .split(/[^a-z0-9]+/)
      .filter(w => w.length > 3));
}

/** Jaccard overlap, 0..1. Two empty notes are not similar, they are empty. */
export function similarity(a: string, b: string): number {
  const setA = wordSet(a);
  const setB = wordSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const word of setA) if (setB.has(word)) shared++;
  return shared / (setA.size + setB.size - shared);
}

export interface SimilarPair {
  a:          string;
  b:          string;
  similarity: number;
}

/**
 * Notes that are nearly the same.
 *
 * O(n²) by design and capped by the caller: an approximate index would trade
 * away exactly the near-misses this is looking for.
 */
export function findNearDuplicates(
  notes: AnalysedNote[],
  threshold = 0.8,
): SimilarPair[] {
  const out: SimilarPair[] = [];
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const score = similarity(notes[i].content, notes[j].content);
      if (score >= threshold && score < 1) {
        out.push({ a: notes[i].path, b: notes[j].path, similarity: Math.round(score * 100) / 100 });
      }
    }
  }
  return out.sort((x, y) => y.similarity - x.similarity);
}

// ── Link health (§39) ───────────────────────────────────────────────────────

export interface LinkHealth {
  orphans:   string[];
  brokenBy:  { path: string; unresolved: string[] }[];
  totalBroken: number;
}

/**
 * Notes nothing links to, and links pointing at nothing.
 *
 * A note with no backlinks is not automatically a problem -- an index or a
 * daily note legitimately has none -- so this reports and does not judge.
 */
export function analyseLinkHealth(
  paths: string[],
  backlinksOf: (path: string) => string[],
  unresolvedIn: (path: string) => string[],
): LinkHealth {
  const orphans: string[] = [];
  const brokenBy: { path: string; unresolved: string[] }[] = [];
  let totalBroken = 0;

  for (const path of paths) {
    if (backlinksOf(path).length === 0) orphans.push(path);
    const unresolved = unresolvedIn(path);
    if (unresolved.length > 0) {
      brokenBy.push({ path, unresolved });
      totalBroken += unresolved.length;
    }
  }

  return { orphans: orphans.sort(), brokenBy, totalBroken };
}
