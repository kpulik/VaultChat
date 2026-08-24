export type ProviderID = 'anthropic' | 'openai' | 'gemini' | 'openrouter' | 'local';
export type ApiFormat = 'anthropic' | 'openai';

export interface ModelDefinition {
  id:    string;
  label: string;
}

export interface ProviderDef {
  name:              string;
  format:            ApiFormat;
  defaultBaseUrl:    string;
  endpoint:          string;
  models:            ModelDefinition[];
  apiKeyLabel:       string | null;
  apiKeyPlaceholder: string;
  // false means the field is shown but sending works without it, for local
  // servers that are only sometimes started behind a key.
  apiKeyRequired:    boolean;
  dynamicModels:     boolean;
  customBaseUrl:     boolean;
}

// Order matters: this is the order of the provider dropdown in both the chat
// header and the settings tab. Local comes first because running a local model
// is what this plugin is for; the hosted providers are the fallback.
export const PROVIDERS: Record<ProviderID, ProviderDef> = {
  local: {
    // Any server that speaks the OpenAI chat-completions API: Ollama, LM Studio,
    // llama.cpp, vLLM, LocalAI, Jan. Models are read from /v1/models.
    name: 'Local (OpenAI-compatible)',
    format: 'openai',
    // 127.0.0.1 rather than localhost: Node resolves localhost to ::1 first, and
    // most local servers bind IPv4 only, which surfaces as ECONNREFUSED.
    defaultBaseUrl: 'http://127.0.0.1:11434',
    endpoint: '/v1/chat/completions',
    models: [],
    apiKeyLabel: 'API key',
    apiKeyPlaceholder: 'Leave blank if your server does not need one',
    apiKeyRequired: false,
    dynamicModels: true,
    customBaseUrl: true,
  },
  anthropic: {
    name: 'Anthropic',
    format: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    endpoint: '/v1/messages',
    models: [
      { id: 'claude-opus-5',   label: 'Claude Opus 5' },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
      { id: 'claude-fable-5',  label: 'Claude Fable 5' },
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    ],
    apiKeyLabel: 'API key',
    apiKeyPlaceholder: 'sk-ant-api03-...',
    apiKeyRequired: true,
    dynamicModels: false,
    customBaseUrl: false,
  },
  openai: {
    name: 'OpenAI',
    format: 'openai',
    defaultBaseUrl: 'https://api.openai.com',
    endpoint: '/v1/chat/completions',
    models: [
      { id: 'gpt-5.6-sol',   label: 'GPT-5.6 Sol' },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
      { id: 'gpt-5.6-luna',  label: 'GPT-5.6 Luna' },
    ],
    apiKeyLabel: 'API key',
    apiKeyPlaceholder: 'sk-...',
    apiKeyRequired: true,
    dynamicModels: false,
    customBaseUrl: false,
  },
  gemini: {
    name: 'Google Gemini',
    format: 'openai',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    endpoint: '/chat/completions',
    models: [
      { id: 'gemini-3.6-flash',       label: 'Gemini 3.6 Flash' },
      { id: 'gemini-3.5-flash',       label: 'Gemini 3.5 Flash' },
      { id: 'gemini-3.5-flash-lite',  label: 'Gemini 3.5 Flash Lite' },
      { id: 'gemini-3.1-flash-lite',  label: 'Gemini 3.1 Flash Lite' },
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)' },
    ],
    apiKeyLabel: 'API key',
    apiKeyPlaceholder: 'AIza...',
    apiKeyRequired: true,
    dynamicModels: false,
    customBaseUrl: false,
  },
  openrouter: {
    name: 'OpenRouter',
    format: 'openai',
    defaultBaseUrl: 'https://openrouter.ai/api',
    endpoint: '/v1/chat/completions',
    models: [
      { id: 'openai/gpt-5.6-sol',          label: 'GPT-5.6 Sol' },
      { id: 'openai/gpt-5.6-terra',        label: 'GPT-5.6 Terra' },
      { id: 'openai/gpt-5.6-luna',         label: 'GPT-5.6 Luna' },
      { id: 'anthropic/claude-opus-5',     label: 'Claude Opus 5' },
      { id: 'anthropic/claude-sonnet-5',   label: 'Claude Sonnet 5' },
      { id: 'anthropic/claude-fable-5',    label: 'Claude Fable 5' },
      { id: 'google/gemini-3.6-flash',     label: 'Gemini 3.6 Flash' },
      { id: 'google/gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite' },
      { id: 'x-ai/grok-4.5',               label: 'Grok 4.5' },
      { id: 'qwen/qwen3.7-plus',           label: 'Qwen3.7 Plus' },
      { id: 'qwen/qwen3.7-flash',          label: 'Qwen3.7 Flash' },
    ],
    apiKeyLabel: 'API key',
    apiKeyPlaceholder: 'sk-or-v1-...',
    apiKeyRequired: true,
    dynamicModels: true,
    customBaseUrl: false,
  },
};

// Used only when max tokens is left at 0 and the provider requires the field.
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

export function keySource(id: ProviderID): string {
  const map: Record<ProviderID, string> = {
    anthropic:  'console.anthropic.com',
    openai:     'platform.openai.com/api-keys',
    gemini:     'aistudio.google.com/apikey',
    openrouter: 'openrouter.ai/keys',
    local:      '',
  };
  return map[id];
}
