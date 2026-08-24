// The tool catalogue and its argument validation (§17, §41).
//
// Pure: definitions plus a validator, no Obsidian. Every argument a model sends
// crosses this boundary, so the checks that stop a bad path reaching the vault
// are testable in isolation.

import { isSafeVaultPath } from '../core';
import type { Normalizer } from '../core';
import type { ToolCall, ToolDef, ToolError, ToolRisk } from './types';

const p = (name: string, desc: string, required = true) =>
  ({ name, type: 'string' as const, required, isPath: true, desc });
const s = (name: string, desc: string, required = true) =>
  ({ name, type: 'string' as const, required, desc });
const b = (name: string, desc: string) =>
  ({ name, type: 'boolean' as const, required: false, desc });
const paths = (name: string, desc: string) =>
  ({ name, type: 'string[]' as const, required: true, isPath: true, desc });

export const TOOLS: Record<string, ToolDef> = {
  // ── Read ──────────────────────────────────────────────────────────────────
  search_vault: {
    name: 'search_vault', risk: 'read',
    desc: 'Rank notes matching a natural-language description. Returns paths with a reason and confidence.',
    params: [s('query', 'What to look for: a name, alias, tag or heading.')],
  },
  find_file: {
    name: 'find_file', risk: 'read',
    desc: 'Resolve one note from a description. Returns a single match, or ambiguous candidates you must ask the user to choose between.',
    params: [s('query', 'The note being referred to.')],
  },
  read_file: {
    name: 'read_file', risk: 'read',
    desc: 'Read a note’s full contents.',
    params: [p('path', 'Exact vault path.')],
  },
  list_folder: {
    name: 'list_folder', risk: 'read',
    desc: 'List the notes in a folder without reading them.',
    params: [p('path', 'Folder path. Empty string means the vault root.'), b('recursive', 'Include subfolders.')],
  },
  read_folder: {
    name: 'read_folder', risk: 'read',
    desc: 'Read every note in a folder. Prefer list_folder then read_file when the folder is large.',
    params: [p('path', 'Folder path.'), b('recursive', 'Include subfolders.')],
  },
  get_note_metadata: {
    name: 'get_note_metadata', risk: 'read',
    desc: 'Aliases, tags, headings, properties and size for one note.',
    params: [p('path', 'Exact vault path.')],
  },
  get_backlinks: {
    name: 'get_backlinks', risk: 'read',
    desc: 'Notes that link to this one.',
    params: [p('path', 'Exact vault path.')],
  },
  get_links: {
    name: 'get_links', risk: 'read',
    desc: 'Links and embeds this note contains, with what each resolves to.',
    params: [p('path', 'Exact vault path.')],
  },
  get_unresolved_links: {
    name: 'get_unresolved_links', risk: 'read',
    desc: 'Links in this note that point at nothing.',
    params: [p('path', 'Exact vault path.')],
  },

  // ── Write ─────────────────────────────────────────────────────────────────
  create_folder: {
    name: 'create_folder', risk: 'write',
    desc: 'Create a folder.',
    params: [p('path', 'Folder path to create.')],
  },
  create_file: {
    name: 'create_file', risk: 'write',
    desc: 'Create a new note. Fails if it already exists.',
    params: [p('path', 'Path of the new note, ending in .md.'), s('content', 'Full contents.', false)],
  },
  edit_file: {
    name: 'edit_file', risk: 'write',
    desc: 'Replace an exact passage. The original must appear exactly once, so include enough surrounding text.',
    params: [
      p('path', 'Exact vault path.'),
      s('original', 'Text to find, copied exactly.'),
      s('replacement', 'Text to put in its place.', false),
    ],
  },
  rename_file: {
    name: 'rename_file', risk: 'write',
    desc: 'Rename a note in place. Links to it are updated.',
    params: [p('path', 'Current path.'), s('newName', 'New filename, without the folder.')],
  },
  move_file: {
    name: 'move_file', risk: 'write',
    desc: 'Move a note to another folder. Links to it are updated.',
    params: [p('path', 'Current path.'), p('destFolder', 'Destination folder.')],
  },
  copy_file: {
    name: 'copy_file', risk: 'write',
    desc: 'Copy a note to a new path.',
    params: [p('path', 'Source path.'), p('destPath', 'Destination path.')],
  },

  // ── Destructive ───────────────────────────────────────────────────────────
  delete_file: {
    name: 'delete_file', risk: 'destructive',
    desc: 'Move a note to the system trash. Always requires the user to confirm.',
    params: [p('path', 'Exact vault path.')],
  },
  batch_move: {
    name: 'batch_move', risk: 'destructive',
    desc: 'Move many notes into one folder, updating links.',
    params: [paths('paths', 'Notes to move.'), p('destFolder', 'Destination folder.')],
  },
  batch_rename: {
    name: 'batch_rename', risk: 'destructive',
    desc: 'Rename many notes by replacing a literal piece of text in each filename. Use to make a set of names consistent.',
    params: [
      paths('paths', 'Notes to rename.'),
      s('find', 'Literal text to find in each filename. Not a pattern.'),
      s('replace', 'What to put in its place. Empty removes it.', false),
    ],
  },
  batch_edit: {
    name: 'batch_edit', risk: 'destructive',
    desc: 'Apply the same exact replacement to many notes. The original must appear exactly once in each.',
    params: [
      paths('paths', 'Notes to edit.'),
      s('original', 'Text to find, copied exactly.'),
      s('replacement', 'Text to put in its place.', false),
    ],
  },
  find_duplicates: {
    name: 'find_duplicates', risk: 'read',
    desc: 'Report notes sharing a filename, notes with identical content, and near-identical notes. Reports only; never deletes.',
    params: [],
  },
  check_link_health: {
    name: 'check_link_health', risk: 'read',
    desc: 'Report links that point at nothing, and notes nothing links to.',
    params: [],
  },
  batch_delete: {
    name: 'batch_delete', risk: 'destructive',
    desc: 'Move many notes to the system trash.',
    params: [paths('paths', 'Notes to delete.')],
  },
};

export function toolRisk(name: string): ToolRisk | null {
  return TOOLS[name]?.risk ?? null;
}

/** Read-only tools run without asking; everything else goes through a plan. */
export function isAutoRunnable(name: string): boolean {
  return toolRisk(name) === 'read';
}

export type Validated =
  | { ok: true;  args: Record<string, unknown> }
  | { ok: false; error: ToolError };

function typeOk(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':   return typeof value === 'string';
    case 'boolean':  return typeof value === 'boolean';
    case 'number':   return typeof value === 'number' && Number.isFinite(value);
    case 'string[]': return Array.isArray(value) && value.every(v => typeof v === 'string');
    default:         return false;
  }
}

/**
 * Checks a call before anything touches the vault.
 *
 * Paths are the reason this exists. They arrive from the model, which means
 * from whatever was in the notes it read, so every one is normalised and
 * refused if it escapes the vault -- the same rule the edit blocks have always
 * applied, extended to every tool that takes a path.
 */
export function validateCall(call: ToolCall, normalize: Normalizer): Validated {
  const def = TOOLS[call.tool];
  if (!def) {
    return { ok: false, error: {
      kind: 'unknown_tool',
      message: `No tool called "${call.tool}". Available: ${Object.keys(TOOLS).join(', ')}.`,
    } };
  }

  const args: Record<string, unknown> = {};

  for (const param of def.params) {
    const raw = call.args[param.name];

    if (raw === undefined || raw === null) {
      if (param.required) {
        return { ok: false, error: {
          kind: 'invalid_args',
          message: `${def.name} needs "${param.name}": ${param.desc}`,
        } };
      }
      continue;
    }

    if (!typeOk(raw, param.type)) {
      return { ok: false, error: {
        kind: 'invalid_args',
        message: `${def.name}: "${param.name}" must be ${param.type}, got ${typeof raw}.`,
      } };
    }

    if (param.isPath) {
      const list = param.type === 'string[]' ? raw as string[] : [raw as string];
      const cleaned: string[] = [];
      for (const one of list) {
        // The vault root is a legal folder argument, but never a legal file.
        if (one === '' && param.type === 'string') { cleaned.push(''); continue; }
        if (!isSafeVaultPath(one, normalize)) {
          return { ok: false, error: {
            kind: 'invalid_args',
            message: `${def.name}: "${one}" is not a path inside the vault.`,
          } };
        }
        cleaned.push(normalize(one));
      }
      args[param.name] = param.type === 'string[]' ? cleaned : cleaned[0];
      continue;
    }

    args[param.name] = raw;
  }

  return { ok: true, args };
}

/**
 * One line per tool, for the system prompt.
 *
 * Takes a risk filter so the prompt can advertise only the tools that are
 * actually wired to an executor. Describing a tool the agent cannot run trains
 * it to emit calls that always fail.
 */
export function describeTools(risks?: ToolRisk[]): string {
  return Object.values(TOOLS).filter(t => !risks || risks.includes(t.risk)).map(t => {
    const sig = t.params
      .map(param => (param.required ? param.name : `${param.name}?`))
      .join(', ');
    return `- ${t.name}(${sig}) [${t.risk}] ${t.desc}`;
  }).join('\n');
}
