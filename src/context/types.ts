/**
 * Where context comes from.
 *
 * Sources compose: the current note, the current folder, explicitly chosen files
 * and folders can all be on at once. They are deliberately not a single
 * mutually-exclusive mode (§9) -- "current note plus these two folders" is the
 * normal case, not an edge case.
 */
export type ContextSource =
  /** Enables indexed, on-demand vault search without concatenating the vault. */
  | { kind: 'entire-vault' }
  | { kind: 'current-note'; path?: string }
  | { kind: 'current-folder'; recursive: boolean }
  | { kind: 'file';   path: string }
  | { kind: 'folder'; path: string; recursive: boolean };

/** A file that made it into context, and the reason it is there. */
export interface ResolvedFile {
  path:   string;
  /** Shown verbatim in the context inspector, so it has to read as English. */
  reason: string;
}

export interface SkippedFile {
  path:   string;
  reason: string;
}

export interface ContextBudget {
  included:        { path: string; content: string; reason: string }[];
  skipped:         SkippedFile[];
  estimatedTokens: number;
}
