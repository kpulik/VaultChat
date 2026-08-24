import { PROVIDERS } from '../providers/catalog';
import { migrateLocalEndpoint } from '../endpoints/manager';
import { DEFAULT_IGNORED_PATHS, DEFAULT_PROTECTED_PATHS } from '../vault/protected';
import type { ProviderID } from '../providers/catalog';
import type { OpenAICompatibleEndpoint } from '../endpoints/types';
import type { Preset } from './presets';

export interface PerProviderSettings {
  apiKey:  string;
  model:   string;
  baseUrl: string;
}

export interface VaultchatSettings {
  activeProvider: ProviderID;
  providers:      Record<ProviderID, PerProviderSettings>;
  // Saved OpenAI-compatible servers. The 'local' provider selects one of these
  // rather than carrying a single base URL of its own.
  endpoints:        OpenAICompatibleEndpoint[];
  activeEndpointId: string | null;
  /** Ceiling for attached-note context, in estimated tokens. */
  contextMaxTokens: number;
  /** Folders destructive operations refuse to touch. */
  protectedPaths:   string[];
  /** Folders kept out of search and context. */
  ignoredPaths:     string[];
  /** The user's own presets. Built-ins are not stored. */
  presets:          Preset[];
  activePresetId:   string | null;
  /** Keep a current-note source following the active editor file when enabled. */
  dynamicCurrentNote: boolean;
  systemPrompt:   string;
  maxTokens:      number;
  ollamaNumCtx:   number;
  autoApplyEdits: boolean;
}

export const DEFAULT_SETTINGS: VaultchatSettings = {
  activeProvider: 'local',
  providers: {
    local:      { apiKey: '', model: '',                   baseUrl: 'http://127.0.0.1:11434' },
    anthropic:  { apiKey: '', model: 'claude-opus-5',      baseUrl: '' },
    openai:     { apiKey: '', model: 'gpt-5.6-sol',        baseUrl: '' },
    gemini:     { apiKey: '', model: 'gemini-3.6-flash',   baseUrl: '' },
    openrouter: { apiKey: '', model: 'openai/gpt-5.6-sol', baseUrl: '' },
  },
  endpoints: [],
  activeEndpointId: null,
  contextMaxTokens: 30000,
  protectedPaths: [...DEFAULT_PROTECTED_PATHS],
  ignoredPaths: [...DEFAULT_IGNORED_PATHS],
  presets: [],
  activePresetId: null,
  dynamicCurrentNote: false,
  systemPrompt: 'You are a helpful assistant integrated into Obsidian. Be concise and precise.',
  maxTokens: 0,
  ollamaNumCtx: 0,
  autoApplyEdits: false,
};

// The 'ollama' provider became the generic 'local' provider. Carry a saved
// Ollama base URL and model across so existing users keep their setup.
export function migrateOllamaProvider(saved: Partial<VaultchatSettings> | null): void {
  if (!saved) return;
  const legacy = saved as unknown as {
    activeProvider?: string;
    providers?: Record<string, PerProviderSettings>;
  };
  if (legacy.providers?.ollama && !legacy.providers.local) {
    legacy.providers.local = legacy.providers.ollama;
    delete legacy.providers.ollama;
  }
  if (legacy.activeProvider === 'ollama') {
    legacy.activeProvider = 'local';
  }
}

// Fills in any provider block a saved settings file predates, so a new provider
// never reads as undefined on load.
export function normalizeSettings(saved: Partial<VaultchatSettings> | null): VaultchatSettings {
  migrateOllamaProvider(saved);
  const settings = Object.assign({}, DEFAULT_SETTINGS, saved);

  const providerSaved = saved?.providers as unknown;
  const providerMap = providerSaved && typeof providerSaved === 'object'
    ? providerSaved as Record<string, unknown>
    : {};
  settings.providers = {} as VaultchatSettings['providers'];
  for (const id of Object.keys(PROVIDERS) as ProviderID[]) {
    const raw = providerMap[id];
    const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    settings.providers[id] = {
      apiKey: typeof source.apiKey === 'string'
        ? source.apiKey : DEFAULT_SETTINGS.providers[id].apiKey,
      model: typeof source.model === 'string'
        ? source.model : DEFAULT_SETTINGS.providers[id].model,
      baseUrl: typeof source.baseUrl === 'string'
        ? source.baseUrl : DEFAULT_SETTINGS.providers[id].baseUrl,
    };
  }

  if (!(settings.activeProvider in PROVIDERS)) settings.activeProvider = 'local';
  settings.contextMaxTokens = Number.isFinite(settings.contextMaxTokens)
    && settings.contextMaxTokens >= 0
    ? settings.contextMaxTokens : DEFAULT_SETTINGS.contextMaxTokens;
  settings.maxTokens = Number.isFinite(settings.maxTokens) && settings.maxTokens >= 0
    ? settings.maxTokens : DEFAULT_SETTINGS.maxTokens;
  settings.ollamaNumCtx = Number.isFinite(settings.ollamaNumCtx) && settings.ollamaNumCtx >= 0
    ? settings.ollamaNumCtx : DEFAULT_SETTINGS.ollamaNumCtx;
  settings.systemPrompt = typeof settings.systemPrompt === 'string'
    ? settings.systemPrompt : DEFAULT_SETTINGS.systemPrompt;
  settings.autoApplyEdits = settings.autoApplyEdits === true;
  settings.activeEndpointId = typeof settings.activeEndpointId === 'string'
    ? settings.activeEndpointId : null;
  settings.activePresetId = typeof settings.activePresetId === 'string'
    ? settings.activePresetId : null;
  settings.dynamicCurrentNote = settings.dynamicCurrentNote === true;

  const cleanPaths = (value: unknown, fallback: string[]): string[] => Array.isArray(value)
    ? [...new Set(value.filter((path): path is string => typeof path === 'string')
      .map(path => path.trim()).filter(Boolean))]
    : [...fallback];
  settings.protectedPaths = cleanPaths(saved?.protectedPaths, DEFAULT_PROTECTED_PATHS);
  settings.ignoredPaths = cleanPaths(saved?.ignoredPaths, DEFAULT_IGNORED_PATHS);

  settings.presets = Array.isArray(saved?.presets)
    ? saved.presets.filter((value): value is Preset => {
      if (!value || typeof value !== 'object') return false;
      const preset = value as Partial<Preset>;
      return typeof preset.id === 'string' && preset.id.length > 0
        && typeof preset.name === 'string' && preset.name.length > 0;
    }).map(preset => ({ ...preset }))
    : [];

  // Seed the endpoint list on a fresh install, or carry a pre-2.0 local server
  // across on upgrade. A saved file that already has an endpoints array is left
  // exactly as it is -- including an empty one, which means the user deleted
  // every endpoint and should not have one handed back.
  if (!Array.isArray(saved?.endpoints)) {
    const seed: { endpoints?: OpenAICompatibleEndpoint[]; activeEndpointId?: string | null;
                  providers?: Record<string, { model?: string; baseUrl?: string } | undefined> } =
      { providers: settings.providers };
    migrateLocalEndpoint(seed);
    settings.endpoints        = seed.endpoints ?? [];
    settings.activeEndpointId = seed.activeEndpointId ?? null;
  } else {
    settings.endpoints = settings.endpoints.filter(endpoint =>
      endpoint && typeof endpoint.id === 'string'
      && typeof endpoint.name === 'string'
      && typeof endpoint.baseUrl === 'string'
      && typeof endpoint.enabled === 'boolean');
  }

  return settings;
}
