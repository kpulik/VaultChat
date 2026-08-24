// Obsidian link parsing and rewriting (§19-21).
//
// Pure: string in, string out. Link rewriting is the operation most likely to
// quietly corrupt a vault -- it touches files the user never named, in bulk --
// so every rule here is testable without an app.

export interface Wikilink {
  /** The whole match, brackets and leading `!` included. */
  raw:      string;
  embed:    boolean;
  /** Note being linked to. Empty for a same-note link like `[[#Heading]]`. */
  target:   string;
  heading?: string;
  block?:   string;
  /** Display text after `|`. */
  alias?:   string;
  start:    number;
  end:      number;
}

export interface MarkdownLink {
  raw:   string;
  embed: boolean;
  text:  string;
  href:  string;
  start: number;
  end:   number;
}

const WIKILINK  = /(!?)\[\[([^\][]+)\]\]/g;
const MDLINK    = /(!?)\[([^\][]*)\]\(([^()\s]+)\)/g;

/**
 * Byte ranges that must not be rewritten: fenced blocks and inline code.
 *
 * A `[[Note]]` inside a fenced example is documentation, not a reference.
 * Rewriting it during a rename would silently edit someone's tutorial to point
 * at a file the example was never about.
 */
export function protectedRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  const lines = text.split('\n');

  // Scanned line by line rather than by regex: a regex for "fence to matching
  // fence" either stops at the first blank line or, if made lazy the other way,
  // swallows the rest of the document -- and swallowing means a rename silently
  // skips every real link after the first code block.
  let offset = 0;
  let fenceStart: number | null = null;
  let fenceChar = '';

  for (const line of lines) {
    const m = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceStart === null) {
      if (m) { fenceStart = offset; fenceChar = m[1][0]; }
    } else if (m && m[1][0] === fenceChar) {
      out.push([fenceStart, offset + line.length]);
      fenceStart = null;
    }
    offset += line.length + 1;
  }
  // An unclosed fence protects everything after it, which is how a renderer
  // treats it too.
  if (fenceStart !== null) out.push([fenceStart, text.length]);

  const inline = /`+[^`\n]*`+/g;
  for (let m = inline.exec(text); m !== null; m = inline.exec(text)) {
    const at = m.index;
    if (out.some(([a, b]) => at >= a && at < b)) continue;
    out.push([at, at + m[0].length]);
  }

  return out;
}

function isProtected(ranges: [number, number][], at: number): boolean {
  return ranges.some(([a, b]) => at >= a && at < b);
}

/** Splits `Target#Heading|Alias` into its parts. */
function splitInner(inner: string): Omit<Wikilink, 'raw' | 'embed' | 'start' | 'end'> {
  const bar   = inner.indexOf('|');
  const alias = bar === -1 ? undefined : inner.slice(bar + 1);
  const left  = bar === -1 ? inner : inner.slice(0, bar);

  const hash = left.indexOf('#');
  if (hash === -1) {
    return { target: left.trim(), ...(alias !== undefined ? { alias } : {}) };
  }

  const target   = left.slice(0, hash).trim();
  const fragment = left.slice(hash + 1);
  const base     = { target, ...(alias !== undefined ? { alias } : {}) };

  return fragment.startsWith('^')
    ? { ...base, block: fragment.slice(1) }
    : { ...base, heading: fragment };
}

export function parseWikilinks(text: string, skipCode = true): Wikilink[] {
  const ranges = skipCode ? protectedRanges(text) : [];
  const out: Wikilink[] = [];
  for (let m = WIKILINK.exec(text); m !== null; m = WIKILINK.exec(text)) {
    if (isProtected(ranges, m.index)) continue;
    out.push({
      raw:   m[0],
      embed: m[1] === '!',
      ...splitInner(m[2]),
      start: m.index,
      end:   m.index + m[0].length,
    });
  }
  return out;
}

export function parseMarkdownLinks(text: string, skipCode = true): MarkdownLink[] {
  const ranges = skipCode ? protectedRanges(text) : [];
  const out: MarkdownLink[] = [];
  for (let m = MDLINK.exec(text); m !== null; m = MDLINK.exec(text)) {
    if (isProtected(ranges, m.index)) continue;
    out.push({
      raw: m[0], embed: m[1] === '!', text: m[2], href: m[3],
      start: m.index, end: m.index + m[0].length,
    });
  }
  return out;
}

/** Rebuilds a wikilink from its parts, preserving embed, fragment and alias. */
export function formatWikilink(link: Omit<Wikilink, 'raw' | 'start' | 'end'>): string {
  let inner = link.target;
  if (link.heading !== undefined) inner += `#${link.heading}`;
  else if (link.block !== undefined) inner += `#^${link.block}`;
  if (link.alias !== undefined) inner += `|${link.alias}`;
  return `${link.embed ? '!' : ''}[[${inner}]]`;
}

/**
 * Rewrites link targets, leaving everything else exactly as written.
 *
 * `resolve` receives the link's target and returns a replacement, or null to
 * leave that link alone. Alias, heading, block id and embed marker are carried
 * across untouched -- §21 is explicit that a rename must not normalise link
 * syntax it was not asked to change.
 *
 * Replacements are applied back-to-front so earlier offsets stay valid.
 */
export function rewriteWikilinks(
  text: string,
  resolve: (target: string, link: Wikilink) => string | null,
): { text: string; changed: number } {
  const links = parseWikilinks(text);
  let out = text;
  let changed = 0;

  for (let i = links.length - 1; i >= 0; i--) {
    const link = links[i];
    // A same-note link has no target to repoint.
    if (link.target === '') continue;
    const next = resolve(link.target, link);
    if (next === null || next === link.target) continue;
    const rebuilt = formatWikilink({ ...link, target: next });
    out = out.slice(0, link.start) + rebuilt + out.slice(link.end);
    changed++;
  }

  return { text: out, changed };
}

export function rewriteMarkdownLinks(
  text: string,
  resolve: (href: string, link: MarkdownLink) => string | null,
): { text: string; changed: number } {
  const links = parseMarkdownLinks(text);
  let out = text;
  let changed = 0;

  for (let i = links.length - 1; i >= 0; i--) {
    const link = links[i];
    const next = resolve(link.href, link);
    if (next === null || next === link.href) continue;
    const rebuilt = `${link.embed ? '!' : ''}[${link.text}](${next})`;
    out = out.slice(0, link.start) + rebuilt + out.slice(link.end);
    changed++;
  }

  return { text: out, changed };
}

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * Resolves a wikilink target the way Obsidian does, near enough for renames.
 *
 * Obsidian accepts a bare basename, a partial path, or a full path, with or
 * without the `.md` extension. Shortest matching path wins, which is the
 * documented tie-break and the one users expect.
 */
export function resolveLinkTarget(target: string, allPaths: string[]): string | null {
  const clean = target.trim().replace(/\.md$/i, '');
  if (clean === '') return null;
  const lower = clean.toLowerCase();

  const candidates = allPaths.filter(p => {
    const noExt = p.replace(/\.md$/i, '').toLowerCase();
    if (noExt === lower) return true;
    if (noExt.endsWith('/' + lower)) return true;
    return p.toLowerCase() === lower;
  });

  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
}

/**
 * The shortest unambiguous way to write a link to `path`.
 *
 * Prefers the bare basename, as Obsidian does, and falls back to the full path
 * when another note shares that basename -- writing the short form there would
 * repoint the link at whichever file happens to sort first.
 */
export function shortestLinkTo(path: string, allPaths: string[]): string {
  const basename = (path.split('/').pop() ?? path).replace(/\.md$/i, '');
  const clashes = allPaths.filter(p =>
    (p.split('/').pop() ?? p).replace(/\.md$/i, '').toLowerCase() === basename.toLowerCase());
  return clashes.length > 1 ? path.replace(/\.md$/i, '') : basename;
}

export interface LinkUpdate {
  path:    string;
  content: string;
  changed: number;
}

/**
 * Repoints every link to `oldPath` at `newPath`, across the files given.
 *
 * Returns only the files that actually changed, so a caller can report "8 notes
 * affected" from real edits rather than from a guess (§52).
 */
export function updateLinksForMove(
  files: { path: string; content: string }[],
  oldPath: string,
  newPath: string,
  allPathsAfterMove: string[],
): LinkUpdate[] {
  const replacement = shortestLinkTo(newPath, allPathsAfterMove);
  // Resolution has to be done against the pre-move layout, or a link written as
  // a bare basename would no longer find the file it currently points at.
  const allPathsBefore = allPathsAfterMove.map(p => (p === newPath ? oldPath : p));
  const updates: LinkUpdate[] = [];

  for (const file of files) {
    const wiki = rewriteWikilinks(file.content, target =>
      resolveLinkTarget(target, allPathsBefore) === oldPath ? replacement : null);

    const md = rewriteMarkdownLinks(wiki.text, href => {
      if (/^[a-z]+:\/\//i.test(href)) return null;   // external URL
      const decoded = decodeURIComponent(href);
      return resolveLinkTarget(decoded, allPathsBefore) === oldPath
        ? newPath.replace(/ /g, '%20')
        : null;
    });

    const changed = wiki.changed + md.changed;
    if (changed > 0) updates.push({ path: file.path, content: md.text, changed });
  }

  return updates;
}
