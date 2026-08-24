// Protected and ignored paths (§27).
//
// Pure: pattern matching only, no vault access, so the rules that stop a
// destructive operation are testable without an app around them.

/**
 * Folders a destructive operation refuses to touch unless the user has
 * deliberately removed them from the list.
 *
 * The vault's configuration folder is NOT listed here: it is not always
 * `.obsidian` -- the user can rename it -- so it is added at the point of use
 * from `Vault#configDir` by withConfigDir() below. Hardcoding the usual name
 * would leave a renamed config folder unprotected, which is the one case where
 * being wrong actually costs something.
 */
export const DEFAULT_PROTECTED_PATHS = ['Templates', '.trash'];

/** Folders kept out of search and context, but still writable. */
export const DEFAULT_IGNORED_PATHS = ['.trash'];

/**
 * The configured patterns plus the vault's real configuration folder.
 *
 * Always call this before matching, rather than trusting the saved list to
 * mention the config folder: it is derived, not user data.
 */
export function withConfigDir(patterns: string[], configDir: string): string[] {
  const clean = configDir.replace(/^\/+|\/+$/g, '');
  return clean === '' || patterns.includes(clean) ? patterns : [clean, ...patterns];
}

/**
 * Does `path` sit under `pattern`?
 *
 * Compared segment-wise. A prefix test would put `Templates-old/x.md` inside
 * `Templates`, which would either protect a folder the user never named or --
 * worse, in the ignore direction -- hide one they expected to search.
 *
 * A trailing `/*` means "the contents but not the folder itself"; a bare name
 * means the folder and everything in it.
 */
export function pathMatches(path: string, pattern: string): boolean {
  const clean = pattern.replace(/^\/+|\/+$/g, '');
  if (clean === '') return false;

  const contentsOnly = clean.endsWith('/*');
  const base = contentsOnly ? clean.slice(0, -2) : clean;
  if (base === '') return false;

  if (!contentsOnly && path === base) return true;
  return path.startsWith(base + '/');
}

export function isProtectedPath(path: string, patterns: string[]): boolean {
  return patterns.some(p => pathMatches(path, p));
}

export function isIgnoredPath(path: string, patterns: string[]): boolean {
  return patterns.some(p => pathMatches(path, p));
}

export interface GuardResult {
  allowed: string[];
  blocked: { path: string; pattern: string }[];
}

/**
 * Splits a batch into what may be written and what is protected.
 *
 * Returns both halves rather than throwing on the first hit: a plan that
 * touches thirty files should report every blocked one at once, not fail,
 * get edited, and fail again on the next.
 */
export function guardPaths(paths: string[], patterns: string[]): GuardResult {
  const allowed: string[] = [];
  const blocked: { path: string; pattern: string }[] = [];
  for (const path of paths) {
    const hit = patterns.find(p => pathMatches(path, p));
    if (hit === undefined) allowed.push(path);
    else blocked.push({ path, pattern: hit });
  }
  return { allowed, blocked };
}
