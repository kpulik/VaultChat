// Saved AI presets (§32).
//
// Pure: a preset is data plus the rules for applying it. Applying returns a new
// settings patch rather than mutating, so a preset can be previewed, and a
// half-applied one cannot exist.

import type { ProviderID } from '../providers/catalog';

export interface Preset {
  id:            string;
  name:          string;
  systemPrompt?: string;
  provider?:     ProviderID;
  /** Only meaningful with the local provider. */
  endpointId?:   string;
  model?:        string;
  maxTokens?:    number;
  /** Turn the current note on automatically when this preset is chosen. */
  includeCurrentNote?: boolean;
}

/**
 * Starting points, not a fixed menu.
 *
 * Every field is optional, so a preset changes only what it names -- picking
 * "Summarize" must not silently move a user off the model they chose.
 */
export const BUILTIN_PRESETS: Preset[] = [
  {
    id: 'builtin-research',
    name: 'Research',
    systemPrompt:
      'You are a research assistant working in an Obsidian vault. Search before you answer, '
      + 'cite the notes you used by path, and say plainly when the vault does not contain something.',
  },
  {
    id: 'builtin-summarize',
    name: 'Summarize',
    systemPrompt:
      'Summarize concisely and faithfully. Lead with the single most important point, keep the '
      + 'author’s terminology, and never introduce claims the source does not make.',
    includeCurrentNote: true,
  },
  {
    id: 'builtin-editor',
    name: 'Obsidian editor',
    systemPrompt:
      'You edit notes in place. Prefer the smallest change that does the job, preserve the '
      + 'author’s voice and formatting, and never reflow text you were not asked to touch.',
    includeCurrentNote: true,
  },
  {
    id: 'builtin-organizer',
    name: 'Vault organizer',
    systemPrompt:
      'You reorganize vaults. Search first, show which notes you selected and which you excluded '
      + 'and why, then propose a plan. Never act on an ambiguous match.',
  },
];

export function findPreset(presets: Preset[], id: string | null | undefined): Preset | null {
  if (!id) return null;
  return presets.find(p => p.id === id) ?? null;
}

/** Built-ins first, then the user's own. */
export function allPresets(custom: Preset[]): Preset[] {
  return [...BUILTIN_PRESETS, ...custom];
}

export function createPreset(list: Preset[], fields: Partial<Preset>, newId: string): Preset[] {
  return [...list, {
    id: newId,
    name: fields.name?.trim() || 'New preset',
    ...(fields.systemPrompt !== undefined ? { systemPrompt: fields.systemPrompt } : {}),
    ...(fields.provider !== undefined ? { provider: fields.provider } : {}),
    ...(fields.endpointId !== undefined ? { endpointId: fields.endpointId } : {}),
    ...(fields.model !== undefined ? { model: fields.model } : {}),
    ...(fields.maxTokens !== undefined ? { maxTokens: fields.maxTokens } : {}),
    ...(fields.includeCurrentNote !== undefined
      ? { includeCurrentNote: fields.includeCurrentNote }
      : {}),
  }];
}

export function updatePreset(list: Preset[], id: string, patch: Partial<Preset>): Preset[] {
  return list.map(p => (p.id === id ? { ...p, ...patch, id: p.id } : p));
}

export function deletePreset(list: Preset[], id: string): Preset[] {
  return list.filter(p => p.id !== id);
}

/** A built-in cannot be edited or deleted; duplicating one gives an editable copy. */
export function isBuiltin(id: string): boolean {
  return BUILTIN_PRESETS.some(p => p.id === id);
}

export interface PresetEffect {
  systemPrompt?: string;
  provider?:     ProviderID;
  endpointId?:   string;
  model?:        string;
  maxTokens?:    number;
  includeCurrentNote: boolean;
}

/**
 * What choosing this preset changes.
 *
 * Only the fields the preset actually sets appear, so applying one leaves every
 * unrelated setting exactly as the user left it.
 */
export function presetEffect(preset: Preset): PresetEffect {
  return {
    ...(preset.systemPrompt !== undefined ? { systemPrompt: preset.systemPrompt } : {}),
    ...(preset.provider     !== undefined ? { provider: preset.provider }         : {}),
    ...(preset.endpointId   !== undefined ? { endpointId: preset.endpointId }     : {}),
    ...(preset.model        !== undefined ? { model: preset.model }               : {}),
    ...(preset.maxTokens    !== undefined ? { maxTokens: preset.maxTokens }       : {}),
    includeCurrentNote: preset.includeCurrentNote === true,
  };
}
