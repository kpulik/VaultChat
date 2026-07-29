import {
  App,
  Component,
  FuzzySuggestModal,
  ItemView,
  MarkdownRenderer,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  SecretStorage,
  TFile,
  WorkspaceLeaf,
  normalizePath,
  setIcon,
} from 'obsidian';
import {
  apiBasePath,
  applyEdit,
  neutralizeExecutableFences,
  parseDeleteBlocks as parseDeleteBlocksCore,
  parseEditBlocks as parseEditBlocksCore,
  resolveHost,
  secretId,
} from './src/core';
import type { DeleteBlock, EditBlock } from './src/core';
import * as http from 'http';
import * as https from 'https';

// ─── Constants ────────────────────────────────────────────────────────────────

const VIEW_TYPE_CHAT = 'vaultchat-chat';

const EDIT_INSTRUCTIONS = `
You have FULL ACCESS to the user's Obsidian vault. You CAN create, edit, and delete files directly.

IMPORTANT: You must NEVER say "I cannot create/edit/delete files" or suggest the user do it manually. You have these abilities -use them.

To CREATE or EDIT a file, use this exact format:

\`\`\`edit:path/to/file.md
<<<<<<< ORIGINAL
the exact original text to find
=======
the replacement text
>>>>>>> MODIFIED
\`\`\`

To CREATE a new file (empty ORIGINAL):

\`\`\`edit:History Notes/my new note.md
<<<<<<< ORIGINAL
=======
# My New Note

Content goes here.
>>>>>>> MODIFIED
\`\`\`

To DELETE files, use this exact format:

\`\`\`delete
path/to/file1.md
path/to/file2.md
\`\`\`

Rules:
- Include enough surrounding context in ORIGINAL to uniquely identify the location.
- You may include multiple ORIGINAL/MODIFIED blocks in one edit block.
- You may include multiple edit blocks for different files.
- To create a new file, use an empty ORIGINAL block with the full content in MODIFIED.
- You can create files in any folder -just use the full path.
- For delete blocks, list one file path per line. The user will be asked to confirm before deletion.
- Always use these code block formats to perform file operations. Never tell the user to do it themselves.
`.trim();

type ProviderID = 'anthropic' | 'openai' | 'gemini' | 'openrouter' | 'local';
type ApiFormat  = 'anthropic' | 'openai';

interface ProviderDef {
  name:              string;
  format:            ApiFormat;
  defaultBaseUrl:    string;
  endpoint:          string;
  models:            { id: string; label: string }[];
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
const PROVIDERS: Record<ProviderID, ProviderDef> = {
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

// ─── Chat History Types ───────────────────────────────────────────────────────

interface ChatSession {
  id:            string;
  createdAt:     number;
  updatedAt:     number;
  title:         string;
  provider:      ProviderID;
  model:         string;
  attachedFiles: string[];
  messages:      Message[];
}

// ─── Edit Block Types ─────────────────────────────────────────────────────────



// ─── File Suggest Modal ───────────────────────────────────────────────────────

class FileSuggestModal extends FuzzySuggestModal<TFile> {
  private onSelect: (file: TFile) => void;

  constructor(app: App, onSelect: (file: TFile) => void) {
    super(app);
    this.onSelect = onSelect;
    this.setPlaceholder('Search for a file…');
  }

  getItems(): TFile[] {
    return this.app.vault.getFiles();
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.onSelect(file);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)         return 'just now';
  if (s < 3600)       return `${Math.floor(s / 60)}m ago`;
  if (s < 86400)      return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

function sessionTitle(firstUserMessage: string): string {
  const stripped = firstUserMessage
    .replace(/<file[^>]*>[\s\S]*?<\/file>\n\n/g, '')
    .replace(/<note[^>]*>[\s\S]*?<\/note>\n\n/, '')
    .trim();
  return stripped.length > 60 ? stripped.slice(0, 57) + '…' : stripped;
}

function stripFileBlocks(content: string): string {
  return content
    .replace(/<file[^>]*>[\s\S]*?<\/file>\n\n/g, '')
    .replace(/<note[^>]*>[\s\S]*?<\/note>\n\n/, '')
    .trim();
}

function maskToken(token: string): string {
  if (token.length <= 16) return '●'.repeat(token.length);
  return token.slice(0, 12) + '  ●●●●●●●●●●●●●●●●●●●●  ' + token.slice(-4);
}

// The parsers live in src/core.ts so they can be unit tested without Obsidian;
// these wrappers bind the app's normalizePath.
const parseEditBlocks   = (t: string): EditBlock[]   => parseEditBlocksCore(t, normalizePath);
const parseDeleteBlocks = (t: string): DeleteBlock[] => parseDeleteBlocksCore(t, normalizePath);

// ─── API key storage ──────────────────────────────────────────────────────────
// Keys used to live in the plugin's data.json in plain text, which sits inside the
// vault and therefore inside whatever the user syncs. Obsidian's SecretStorage
// arrived in 1.11.4, below which this plugin still runs, so probe for it at
// runtime instead of trusting the typings to match the running app.

// Feature probe kept as belt and braces even though minAppVersion now guarantees
// SecretStorage exists, so a force-installed copy on an older app degrades to the
// plain-text path rather than throwing.
function secureStore(app: App): SecretStorage | null {
  const s = (app as { secretStorage?: SecretStorage }).secretStorage;
  return s && typeof s.setSecret === 'function' ? s : null;
}







// Reads the OpenAI-compatible /v1/models endpoint, which Ollama, LM Studio,
// llama.cpp, vLLM, LocalAI and Jan all serve.
function fetchLocalModels(baseUrl: string, apiKey: string): Promise<{ id: string; label: string }[]> {
  return new Promise((resolve, reject) => {
    const trimmed   = baseUrl.replace(/\/$/, '');
    const url       = new URL(trimmed);
    const isHttps   = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    const port      = url.port ? parseInt(url.port) : (isHttps ? 443 : 80);
    const basePath  = apiBasePath(url);
    // Servers started without a key ignore the header; ones started with a key
    // reject the request without it.
    const headers   = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;

    const req = transport.get(
      { hostname: resolveHost(url.hostname), port, path: `${basePath}/v1/models`, headers },
      (res: import('http').IncomingMessage) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const json = JSON.parse(data) as { data?: { id: string }[] };
            resolve((json.data ?? []).map(m => ({ id: m.id, label: m.id })));
          } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
        });
        res.on('error', (err: Error) => reject(err));
      },
    );
    req.on('error', (err: Error) => reject(err));
  });
}

function fetchOpenRouterModels(apiKey: string): Promise<{ id: string; label: string }[]> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: 'openrouter.ai',
        port: 443,
        path: '/api/v1/models',
        headers: { 'Authorization': `Bearer ${apiKey}` },
      },
      (res: import('http').IncomingMessage) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const json = JSON.parse(data) as { data?: { id: string; name: string }[] };
            resolve(
              (json.data ?? [])
                .map(m => ({ id: m.id, label: m.name || m.id }))
                .sort((a, b) => a.id.localeCompare(b.id)),
            );
          } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
        });
        res.on('error', (err: Error) => reject(err));
      },
    );
    req.on('error', (err: Error) => reject(err));
  });
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface PerProviderSettings {
  apiKey:  string;
  model:   string;
  baseUrl: string;
}

interface vaultchatSettings {
  activeProvider: ProviderID;
  providers:      Record<ProviderID, PerProviderSettings>;
  systemPrompt:   string;
  maxTokens:      number;
  ollamaNumCtx:   number;
  autoApplyEdits: boolean;
}

// The 'ollama' provider became the generic 'local' provider. Carry a saved
// Ollama base URL and model across so existing users keep their setup.
function migrateOllamaProvider(saved: Partial<vaultchatSettings> | null): void {
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

const DEFAULT_SETTINGS: vaultchatSettings = {
  activeProvider: 'local',
  providers: {
    local:      { apiKey: '', model: '',                   baseUrl: 'http://127.0.0.1:11434' },
    anthropic:  { apiKey: '', model: 'claude-opus-5',      baseUrl: '' },
    openai:     { apiKey: '', model: 'gpt-5.6-sol',        baseUrl: '' },
    gemini:     { apiKey: '', model: 'gemini-3.6-flash',   baseUrl: '' },
    openrouter: { apiKey: '', model: 'openai/gpt-5.6-sol', baseUrl: '' },
  },
  systemPrompt: 'You are a helpful assistant integrated into Obsidian. Be concise and precise.',
  maxTokens: 0,
  ollamaNumCtx: 0,
  autoApplyEdits: false,
};

// ─── API ─────────────────────────────────────────────────────────────────────

// Used only when max tokens is left at 0 and the provider requires the field.
const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

interface StreamEvent {
  type?: string;
  delta?: { type?: string; text?: string };
  // Reasoning models stream their chain of thought as reasoning_content and only
  // the answer as content. Both arrive on the same delta.
  choices?: { delta?: { content?: string; reasoning_content?: string } }[];
}

function streamMessage(
  settings: vaultchatSettings,
  // Resolved by the caller, because the key may live in SecretStorage rather
  // than in settings.
  apiKey:   string,
  history:  Message[],
  systemPromptOverride: string,
  onChunk:  (text: string) => void,
  onDone:   () => void,
  onError:  (msg: string) => void,
  onReasoning: () => void,
): () => void {
  const providerID = settings.activeProvider;
  const def        = PROVIDERS[providerID];
  const ps         = settings.providers[providerID];
  const baseUrl    = (ps.baseUrl || def.defaultBaseUrl).replace(/\/$/, '');
  const isHttps    = baseUrl.startsWith('https');
  const transport  = isHttps ? https : http;

  const urlObj   = new URL(baseUrl);
  const hostname = resolveHost(urlObj.hostname);
  const port     = urlObj.port ? parseInt(urlObj.port) : (isHttps ? 443 : 80);
  const basePath = apiBasePath(urlObj);
  const path     = basePath + def.endpoint;

  let bodyStr: string;
  let headers: Record<string, string | number>;

  if (def.format === 'anthropic') {
    const body = {
      model:      ps.model,
      // Anthropic requires max_tokens, so 0 cannot mean "omit it" here the way
      // it does for the OpenAI-shaped providers. It falls back instead.
      max_tokens: settings.maxTokens > 0 ? settings.maxTokens : ANTHROPIC_DEFAULT_MAX_TOKENS,
      system:     systemPromptOverride,
      messages:   history,
      stream:     true,
    };
    bodyStr = JSON.stringify(body);
    headers = {
      'x-api-key':         apiKey,
      'Content-Type':      'application/json',
      'anthropic-version': '2023-06-01',
      'Content-Length':    Buffer.byteLength(bodyStr),
    };
  } else {
    const messages = [
      { role: 'system', content: systemPromptOverride },
      ...history,
    ];
    const body: Record<string, unknown> = {
      model:    ps.model,
      messages,
      stream:   true,
    };
    // Both of these are omitted at 0 so the provider applies its own default,
    // which is what a router or a local server is usually better at deciding.
    if (settings.maxTokens > 0) {
      body['max_tokens'] = settings.maxTokens;
    }
    if (providerID === 'local' && settings.ollamaNumCtx > 0) {
      // Ollama-style hint. Servers that don't understand it ignore it.
      body['options'] = { num_ctx: settings.ollamaNumCtx };
    }
    bodyStr = JSON.stringify(body);
    headers = {
      // Local servers started without a key ignore this; some still require the
      // header to be present, so send a placeholder rather than omitting it.
      'Authorization':  `Bearer ${apiKey || 'no-key'}`,
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
    };
    if (providerID === 'openrouter') {
      headers['HTTP-Referer'] = 'https://obsidian.md';
      headers['X-Title']      = 'vaultchat';
    }
  }

  let finished = false;

  const req = transport.request(
    { hostname, port, path, method: 'POST', headers },
    (res: import('http').IncomingMessage) => {
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', (chunk: Buffer) => { errBody += chunk.toString(); });
        res.on('end', () => {
          let hint = '';
          if (res.statusCode === 401) hint = ' -check your API key in settings';
          if (res.statusCode === 403) hint = ' -key may lack permissions';
          onError(`API ${res.statusCode}${hint}: ${errBody}`);
        });
        return;
      }

      let buf = '';

      const handleLine = (line: string) => {
        if (!line.startsWith('data: ')) return;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') { finished = true; onDone(); return; }
        try {
          const evt = JSON.parse(payload) as StreamEvent;
          if (def.format === 'anthropic') {
            if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
              onChunk(evt.delta.text);
            }
          } else {
            const delta = evt.choices?.[0]?.delta;
            if (delta?.content) onChunk(delta.content);
            // Chain of thought is not added to the transcript, but it is the only
            // sign of life during a long think, so report that it is happening.
            else if (delta?.reasoning_content) onReasoning();
          }
        } catch { /* ignore SSE parse errors */ }
      };

      res.on('data', (chunk: Buffer) => {
        if (finished) return;
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        lines.forEach(handleLine);
      });
      res.on('end',   () => { if (!finished) onDone(); });
      res.on('error', (err: Error) => onError(`Stream error: ${err.message}`));
    },
  );

  req.on('error', (err: Error) => {
    if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') return;
    onError(`Network error: ${err.message}`);
  });
  req.write(bodyStr);
  req.end();

  return () => {
    if (!finished) {
      finished = true;
      req.destroy();
      onDone();
    }
  };
}

// ─── Chat View ────────────────────────────────────────────────────────────────

class vaultchatView extends ItemView {
  private plugin:          vaultchatPlugin;
  private history:         Message[] = [];
  private streaming      = false;
  private currentSession:  ChatSession | null = null;
  private historyVisible = false;
  private contextFiles:    string[] = [];
  private vaultFileTree  = '';

  private messagesEl!:     HTMLElement;
  private historyEl!:      HTMLElement;
  private inputEl!:        HTMLTextAreaElement;
  private sendBtn!:        HTMLButtonElement;
  private stopBtn!:        HTMLButtonElement;
  private historyBtn!:     HTMLButtonElement;
  private includeNoteEl!:  HTMLInputElement;
  private contextChipsEl!: HTMLElement;
  private providerSelEl!:  HTMLSelectElement;
  private modelSelEl!:     HTMLSelectElement;
  private refreshBtn!:     HTMLButtonElement;

  private cancelStream: (() => void) | null = null;
  private stoppedByUser = false;
  private modelLoadGen = 0;
  private renderComponents: Component[] = [];

  constructor(leaf: WorkspaceLeaf, plugin: vaultchatPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType()    { return VIEW_TYPE_CHAT; }
  getDisplayText() { return 'Vaultchat'; }
  getIcon()        { return 'bot'; }

  async onOpen() {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('cs-root');

    // ── Header ──
    const header = root.createDiv('cs-header');
    const logoEl = header.createSpan({ cls: 'cs-logo' });
    setIcon(logoEl, 'message-square');
    header.createSpan({ cls: 'cs-title', text: 'vaultchat' });

    const controls = header.createDiv('cs-controls');

    this.providerSelEl = controls.createEl('select', { cls: 'cs-provider-select' });
    for (const [id, def] of Object.entries(PROVIDERS)) {
      const opt = this.providerSelEl.createEl('option', { value: id, text: def.name });
      if (id === this.plugin.settings.activeProvider) opt.selected = true;
    }
    this.providerSelEl.addEventListener('change', () => {
      this.plugin.settings.activeProvider = this.providerSelEl.value as ProviderID;
      void this.plugin.saveSettings();
      void this.refreshModelSelector();
    });

    this.modelSelEl = controls.createEl('select', { cls: 'cs-model-select' });
    this.modelSelEl.addEventListener('change', () => {
      this.plugin.settings.providers[this.plugin.settings.activeProvider].model = this.modelSelEl.value;
      void this.plugin.saveSettings();
    });

    this.refreshBtn = controls.createEl('button', {
      cls: 'cs-icon-btn', text: '↺', attr: { title: 'Refresh model list' },
    });
    this.refreshBtn.addEventListener('click', () => { void this.refreshModelSelector(); });

    await this.refreshModelSelector();

    this.historyBtn = controls.createEl('button', {
      cls: 'cs-icon-btn', text: '☰', attr: { title: 'Chat history' },
    });
    this.historyBtn.addEventListener('click', () => this.toggleHistory());

    controls.createEl('button', {
      cls: 'cs-icon-btn', text: '⌫', attr: { title: 'New chat' },
    }).addEventListener('click', () => this.startNewSession());

    // ── Body ──
    const body = root.createDiv('cs-body');
    this.messagesEl = body.createDiv('cs-messages');
    this.historyEl  = body.createDiv('cs-history-panel');
    this.historyEl.addClass('cs-hidden');

    // ── Footer ──
    const footer = root.createDiv('cs-footer');

    // Context row: checkbox + add files button
    const ctxRow = footer.createDiv('cs-ctx-row');
    this.includeNoteEl = ctxRow.createEl('input', { type: 'checkbox', cls: 'cs-ctx-check' });
    this.includeNoteEl.id = 'cs-include-note';
    ctxRow.createEl('label', {
      text: 'Include current note',
      attr: { for: 'cs-include-note' },
      cls:  'cs-ctx-label',
    });
    const autoEl = ctxRow.createEl('input', { type: 'checkbox', cls: 'cs-ctx-check' });
    autoEl.id = 'cs-auto-apply';
    autoEl.checked = this.plugin.settings.autoApplyEdits;
    ctxRow.createEl('label', {
      text: 'Auto-apply edits',
      attr: { for: 'cs-auto-apply', title: 'Apply file edits without clicking apply first' },
      cls:  'cs-ctx-label',
    });
    autoEl.addEventListener('change', () => {
      this.plugin.settings.autoApplyEdits = autoEl.checked;
      void this.plugin.saveSettings();
    });

    ctxRow.createEl('button', {
      cls: 'cs-add-file-btn', text: '+', attr: { title: 'Add file to context' },
    }).addEventListener('click', () => {
      new FileSuggestModal(this.app, (file: TFile) => {
        if (!this.contextFiles.includes(file.path)) {
          this.contextFiles.push(file.path);
          this.renderContextChips();
        }
      }).open();
    });

    // File chips container
    this.contextChipsEl = footer.createDiv('cs-ctx-chips');

    // Input row
    const inputRow = footer.createDiv('cs-input-row');
    this.inputEl = inputRow.createEl('textarea', {
      cls:  'cs-input',
      attr: { placeholder: 'Message… (↵ send, ⌘↵ new line)', rows: '3' },
    });
    this.sendBtn = inputRow.createEl('button', {
      cls: 'cs-send-btn', text: '↑', attr: { title: 'Send (↵)' },
    });
    this.stopBtn = inputRow.createEl('button', {
      cls: 'cs-stop-btn', text: '■', attr: { title: 'Stop generation' },
    });
    this.stopBtn.addClass('cs-hidden');
    this.stopBtn.addEventListener('click', () => {
      this.stoppedByUser = true;
      this.cancelStream?.();
      this.cancelStream = null;
    });

    this.inputEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        void this.send();
        return;
      }
      window.requestAnimationFrame(() => {
        this.inputEl.setCssStyles({ height: 'auto' });
        this.inputEl.setCssStyles({ height: Math.min(this.inputEl.scrollHeight, 180) + 'px' });
      });
    });
    this.sendBtn.addEventListener('click', () => { void this.send(); });

    // Build file tree and keep it updated
    this.rebuildFileTree();
    this.registerEvent(this.app.vault.on('create', () => this.rebuildFileTree()));
    this.registerEvent(this.app.vault.on('delete', () => this.rebuildFileTree()));
    this.registerEvent(this.app.vault.on('rename', () => this.rebuildFileTree()));

    // Auto-load most recent session
    const sessions = await this.plugin.loadAllSessions();
    if (sessions.length > 0) {
      this.loadSession(sessions[0], false);
    } else {
      this.renderWelcome();
    }
  }

  private rebuildFileTree() {
    const allFiles = this.app.vault.getFiles()
      .map(f => f.path)
      .sort()
      .filter(p => !p.startsWith(this.app.vault.configDir + '/'));
    if (allFiles.length <= 500) {
      this.vaultFileTree = '\n\nThe following files exist in the user\'s vault. Use these EXACT paths for any file operations:\n\n' + allFiles.join('\n');
    } else {
      const folders = new Set<string>();
      for (const p of allFiles) {
        const dir = p.substring(0, p.lastIndexOf('/'));
        if (dir) folders.add(dir);
      }
      const truncated = allFiles.slice(0, 300);
      this.vaultFileTree = '\n\nThe user\'s vault has ' + allFiles.length + ' files. Folders:\n' + [...folders].sort().join('\n') + '\n\nFirst 300 files:\n' + truncated.join('\n');
    }
  }

  // ── Context chips ──────────────────────────────────────────────────────────

  private renderContextChips() {
    this.contextChipsEl.empty();
    for (const filePath of this.contextFiles) {
      const chip = this.contextChipsEl.createDiv('cs-ctx-chip');
      chip.createSpan({ text: filePath.split('/').pop() ?? filePath, attr: { title: filePath } });
      chip.createEl('button', { cls: 'cs-chip-remove', text: '×' })
        .addEventListener('click', () => {
          this.contextFiles = this.contextFiles.filter(f => f !== filePath);
          this.renderContextChips();
        });
    }
  }

  // ── Model selector ────────────────────────────────────────────────────────

  private async refreshModelSelector() {
    const gen = ++this.modelLoadGen;
    const id  = this.plugin.settings.activeProvider;
    const def = PROVIDERS[id];
    const cur = this.plugin.settings.providers[id].model;

    this.refreshBtn.toggleClass('cs-hidden', !def.dynamicModels);

    if (!def.dynamicModels) {
      this.modelSelEl.disabled = false;
      this.populateSelect(def.models, cur);
      return;
    }

    this.modelSelEl.disabled = true;
    this.modelSelEl.empty();
    this.modelSelEl.createEl('option', { value: cur || '', text: 'Loading…' }).selected = true;

    try {
      let models: { id: string; label: string }[];
      if (id === 'local') {
        const lps     = this.plugin.settings.providers.local;
        const baseUrl = lps.baseUrl || PROVIDERS.local.defaultBaseUrl;
        models = await fetchLocalModels(baseUrl, this.plugin.getApiKey('local'));
      } else {
        const apiKey = this.plugin.getApiKey('openrouter');
        models = apiKey ? await fetchOpenRouterModels(apiKey) : def.models;
      }
      if (gen !== this.modelLoadGen) return;
      if (models.length === 0) {
        this.modelSelEl.disabled = false;
        this.modelSelEl.empty();
        this.modelSelEl.createEl('option', { value: '', text: id === 'local' ? 'No models loaded' : 'No models found' });
        return;
      }
      this.modelSelEl.disabled = false;
      const validCur = models.find(m => m.id === cur) ? cur : '';
      if (!cur) {
        // Nothing chosen yet, so adopt whatever the server lists first. A model
        // that is set but missing from the list is left alone: it may just be
        // unloaded right now, and overwriting it would discard a real choice.
        this.plugin.settings.providers[id].model = models[0].id;
        void this.plugin.saveSettings();
      }
      this.populateSelect(models, validCur || cur || models[0].id);
    } catch {
      if (gen !== this.modelLoadGen) return;
      this.modelSelEl.disabled = false;
      if (def.models.length > 0) {
        this.populateSelect(def.models, cur);
      } else {
        this.modelSelEl.empty();
        this.modelSelEl.createEl('option', { value: cur || '', text: cur || 'Fetch failed -check connection' }).selected = true;
      }
    }
  }

  private populateSelect(models: { id: string; label: string }[], current: string) {
    this.modelSelEl.empty();
    let matched = false;
    for (const m of models) {
      const opt = this.modelSelEl.createEl('option', { value: m.id, text: m.label });
      if (m.id === current) { opt.selected = true; matched = true; }
    }
    // A saved model that is not in the catalog is kept as its own option rather
    // than silently falling back to the first entry. Falling back changed which
    // model the header showed without changing the stored setting, so the header
    // and the settings tab disagreed and the choice looked like it had not stuck.
    if (!matched && current) {
      this.modelSelEl.createEl('option', { value: current, text: current }).selected = true;
    } else if (!matched && models.length > 0) {
      this.modelSelEl.options[0].selected = true;
    }
  }

  // ── Session management ────────────────────────────────────────────────────

  private startNewSession() {
    this.currentSession = null;
    this.history = [];
    this.contextFiles = [];
    this.renderContextChips();
    if (this.historyVisible) this.toggleHistory();
    this.messagesEl.empty();
    this.renderWelcome();
  }

  private loadSession(session: ChatSession, scrollIntoView = true) {
    this.currentSession = { ...session, messages: [...session.messages] };
    this.history = [...session.messages];
    this.contextFiles = [...session.attachedFiles];
    this.renderContextChips();

    if (this.historyVisible) this.toggleHistory();

    this.cleanupRenderComponents();
    this.messagesEl.empty();
    if (this.history.length === 0) {
      this.renderWelcome();
      return;
    }

    for (const msg of this.history) {
      if (msg.role === 'user') {
        this.appendUserBubble(stripFileBlocks(msg.content));
      } else {
        const bubble = this.messagesEl.createDiv('cs-msg cs-msg--assistant');
        const bodyEl = bubble.createDiv('cs-msg-body');
        const comp = new Component();
        comp.load();
        this.renderComponents.push(comp);
        void MarkdownRenderer.render(this.app, neutralizeExecutableFences(msg.content), bodyEl, '', comp);
        this.addMessageActions(bubble, msg.content);
      }
    }

    if (scrollIntoView) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private cleanupRenderComponents() {
    for (const comp of this.renderComponents) {
      comp.unload();
    }
    this.renderComponents = [];
  }

  private async persistSession() {
    if (!this.currentSession) return;
    this.currentSession.messages  = [...this.history];
    this.currentSession.updatedAt = Date.now();
    await this.plugin.saveSession(this.currentSession);
  }

  // ── History panel ─────────────────────────────────────────────────────────

  private toggleHistory() {
    this.historyVisible = !this.historyVisible;
    if (this.historyVisible) {
      this.messagesEl.addClass('cs-hidden');
      this.historyEl.removeClass('cs-hidden');
      this.historyBtn.addClass('cs-accent-active');
      void this.renderHistory();
    } else {
      this.historyEl.addClass('cs-hidden');
      this.messagesEl.removeClass('cs-hidden');
      this.historyBtn.removeClass('cs-accent-active');
    }
  }

  private async renderHistory() {
    this.historyEl.empty();

    const newBtn = this.historyEl.createEl('button', { cls: 'cs-new-chat-btn', text: '+ new chat' });
    newBtn.addEventListener('click', () => this.startNewSession());

    const sessions = await this.plugin.loadAllSessions();
    if (sessions.length === 0) {
      this.historyEl.createDiv({ cls: 'cs-history-empty', text: 'No chat history yet.' });
      return;
    }

    const now = Date.now();
    const day = 86_400_000;
    const groups: { label: string; items: ChatSession[] }[] = [
      { label: 'Today',       items: [] },
      { label: 'Yesterday',   items: [] },
      { label: 'Last 7 days', items: [] },
      { label: 'Older',       items: [] },
    ];
    for (const s of sessions) {
      const age = now - s.updatedAt;
      if      (age < day)       groups[0].items.push(s);
      else if (age < 2 * day)   groups[1].items.push(s);
      else if (age < 7 * day)   groups[2].items.push(s);
      else                      groups[3].items.push(s);
    }

    for (const group of groups) {
      if (group.items.length === 0) continue;
      this.historyEl.createDiv({ cls: 'cs-history-group-label', text: group.label });

      for (const session of group.items) {
        const item = this.historyEl.createDiv('cs-session-item');
        if (this.currentSession?.id === session.id) item.addClass('cs-session-item--active');

        const content = item.createDiv('cs-session-content');
        content.createDiv({ cls: 'cs-session-title', text: session.title || 'Untitled chat' });

        const meta = content.createDiv('cs-session-meta');
        meta.createSpan({ text: timeAgo(session.updatedAt) });
        meta.createSpan({ cls: 'cs-session-provider', text: PROVIDERS[session.provider]?.name ?? session.provider });

        if (session.attachedFiles.length > 0) {
          const filesRow = content.createDiv('cs-session-files');
          for (const f of session.attachedFiles.slice(0, 3)) {
            filesRow.createSpan({ cls: 'cs-file-badge', text: f.split('/').pop() ?? f });
          }
          if (session.attachedFiles.length > 3) {
            filesRow.createSpan({ cls: 'cs-file-badge', text: `+${session.attachedFiles.length - 3} more` });
          }
        }

        const delBtn = item.createEl('button', {
          cls: 'cs-session-delete', text: '×', attr: { title: 'Delete' },
        });
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          void (async () => {
            await this.plugin.deleteSession(session.id);
            if (this.currentSession?.id === session.id) this.startNewSession();
            await this.renderHistory();
          })();
        });

        item.addEventListener('click', () => { this.loadSession(session); });
      }
    }
  }

  // ── Message rendering ─────────────────────────────────────────────────────

  private renderWelcome() {
    const el = this.messagesEl.createDiv('cs-welcome');
    const welcomeIcon = el.createDiv({ cls: 'cs-welcome-icon' });
    setIcon(welcomeIcon, 'message-square');
    el.createDiv({ cls: 'cs-welcome-text', text: 'What can I help you with?' });
  }

  private appendUserBubble(text: string) {
    const bubble = this.messagesEl.createDiv('cs-msg cs-msg--user');
    bubble.createDiv({ cls: 'cs-msg-body', text });
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private addMessageActions(bubble: HTMLElement, content: string) {
    const actions = bubble.createDiv('cs-msg-actions');

    const copyBtn = actions.createEl('button', { cls: 'cs-action-btn', text: 'Copy' });
    copyBtn.addEventListener('click', () => {
      void navigator.clipboard.writeText(content).then(() => {
        copyBtn.textContent = '✓ copied';
        window.setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      });
    });

    actions.createEl('button', { cls: 'cs-action-btn', text: 'Insert' })
      .addEventListener('click', () => { void this.insertIntoNote(content); });

    // Render edit actions if the response contains edit blocks
    const editBlocks = parseEditBlocks(content);
    if (editBlocks.length > 0) {
      this.renderEditActions(bubble, editBlocks);
    }

    // Render delete actions if the response contains delete blocks
    const deleteBlocks = parseDeleteBlocks(content);
    if (deleteBlocks.length > 0) {
      this.renderDeleteActions(bubble, deleteBlocks);
    }
  }

  // ── Edit actions ──────────────────────────────────────────────────────────

  private renderEditActions(bubble: HTMLElement, editBlocks: EditBlock[]) {
    for (const block of editBlocks) {
      if (this.plugin.settings.autoApplyEdits) {
        void this.autoApplyEdit(bubble, block);
      } else {
        this.manualApplyEdit(bubble, block);
      }
    }
  }

  // Manual mode -show Preview + Apply buttons (user must click Apply)
  private manualApplyEdit(bubble: HTMLElement, block: EditBlock) {
    const bar = bubble.createDiv('cs-edit-bar');
    bar.createSpan({ cls: 'cs-edit-file', text: block.filePath });

    const previewBtn = bar.createEl('button', { cls: 'cs-action-btn', text: 'Preview' });
    const applyBtn   = bar.createEl('button', { cls: 'cs-action-btn cs-apply-btn', text: 'Apply' });
    const diffEl     = bubble.createDiv('cs-diff-container');
    diffEl.addClass('cs-hidden');

    previewBtn.addEventListener('click', () => {
      const visible = !diffEl.hasClass('cs-hidden');
      diffEl.toggleClass('cs-hidden', visible);
      previewBtn.textContent = visible ? 'Preview' : 'Hide';
      if (!visible) {
        diffEl.empty();
        for (const edit of block.edits) {
          if (edit.original) {
            diffEl.createDiv('cs-diff-removed').textContent = edit.original;
          }
          diffEl.createDiv('cs-diff-added').textContent = edit.replacement;
        }
      }
    });

    applyBtn.addEventListener('click', () => {
      void (async () => {
        const abstractFile = this.app.vault.getAbstractFileByPath(block.filePath);
        const isNewFile = !abstractFile || !(abstractFile instanceof TFile);

        if (isNewFile && block.edits.length === 1 && block.edits[0].original === '') {
          try {
            const dir = block.filePath.substring(0, block.filePath.lastIndexOf('/'));
            if (dir) {
              const exists = await this.app.vault.adapter.exists(dir);
              if (!exists) await this.app.vault.adapter.mkdir(dir);
            }
            await this.app.vault.create(block.filePath, block.edits[0].replacement);
            applyBtn.textContent = '✓ created';
            applyBtn.disabled = true;
            new Notice(`Created ${block.filePath}`);
          } catch (e) {
            new Notice(`Failed to create file: ${(e as Error).message}`);
          }
        } else if (!isNewFile) {
          try {
            let content = await this.app.vault.read(abstractFile);
            let applied = 0;
            for (const edit of block.edits) {
              const r = applyEdit(content, edit.original, edit.replacement);
              if (r.status === 'ambiguous') {
                new Notice(`That text appears ${r.count} times in ${block.filePath}. Nothing was changed; ask for more surrounding context.`);
                return;
              }
              if (r.status === 'applied') { content = r.content; applied++; }
            }
            if (applied === 0) {
              new Notice(`Could not find the original text in ${block.filePath}.`);
              return;
            }
            await this.app.vault.modify(abstractFile, content);
            applyBtn.textContent = `✓ applied ${applied}/${block.edits.length}`;
            applyBtn.disabled = true;
            new Notice(`Applied ${applied} edit(s) to ${block.filePath}`);
          } catch (e) {
            new Notice(`Error: ${(e as Error).message}`);
          }
        } else {
          new Notice(`File not found: ${block.filePath}`);
        }
      })();
    });
  }

  private async autoApplyEdit(bubble: HTMLElement, block: EditBlock) {
    const bar = bubble.createDiv('cs-edit-bar');
    bar.createSpan({ cls: 'cs-edit-file', text: block.filePath });
    const statusEl = bar.createSpan({ cls: 'cs-edit-status' });

    const abstractFile = this.app.vault.getAbstractFileByPath(block.filePath);
    const isNewFile = !abstractFile || !(abstractFile instanceof TFile);
    let originalContent: string | null = null;
    let success = false;

    if (isNewFile) {
      // Creating a new file
      if (block.edits.length === 1 && block.edits[0].original === '') {
        try {
          const dir = block.filePath.substring(0, block.filePath.lastIndexOf('/'));
          if (dir) {
            const exists = await this.app.vault.adapter.exists(dir);
            if (!exists) await this.app.vault.adapter.mkdir(dir);
          }
          await this.app.vault.create(block.filePath, block.edits[0].replacement);
          originalContent = null; // revert = delete
          success = true;
          new Notice(`Created ${block.filePath}`);
        } catch (e) {
          statusEl.textContent = `✗ failed to create`;
          statusEl.addClass('cs-edit-error');
          new Notice(`Failed to create file: ${(e as Error).message}`);
          return;
        }
      } else {
        statusEl.textContent = '✗ file not found';
        statusEl.addClass('cs-edit-error');
        new Notice(`File not found: ${block.filePath}`);
        return;
      }
    } else {
      // Editing an existing file -save original, then apply
      try {
        originalContent = await this.app.vault.read(abstractFile);
        let content = originalContent;
        let applied = 0;

        let ambiguous = 0;
        for (const edit of block.edits) {
          const r = applyEdit(content, edit.original, edit.replacement);
          if (r.status === 'ambiguous') { ambiguous = r.count; break; }
          if (r.status === 'applied') { content = r.content; applied++; }
        }

        if (ambiguous > 0) {
          statusEl.textContent = `✗ text appears ${ambiguous} times, nothing changed`;
          statusEl.addClass('cs-edit-error');
          new Notice(`That text appears ${ambiguous} times in ${block.filePath}. Nothing was changed; ask for more surrounding context.`);
          return;
        }

        if (applied === 0) {
          statusEl.textContent = '✗ could not match original text';
          statusEl.addClass('cs-edit-error');
          new Notice(`Could not find the original text in ${block.filePath}. The file may have changed.`);
          return;
        }

        await this.app.vault.modify(abstractFile, content);
        success = true;
        new Notice(`Applied ${applied} edit(s) to ${block.filePath}`);
      } catch (e) {
        statusEl.textContent = '✗ error';
        statusEl.addClass('cs-edit-error');
        new Notice(`Error applying edit: ${(e as Error).message}`);
        return;
      }
    }

    if (!success) return;

    statusEl.textContent = isNewFile ? '✓ created' : '✓ applied';
    statusEl.addClass('cs-edit-success');

    // Show diff
    const diffEl = bubble.createDiv('cs-diff-container');
    for (const edit of block.edits) {
      if (edit.original) {
        const rem = diffEl.createDiv('cs-diff-removed');
        rem.textContent = edit.original;
      }
      const add = diffEl.createDiv('cs-diff-added');
      add.textContent = edit.replacement;
    }

    // Confirm / Revert buttons
    const btnRow = bubble.createDiv('cs-edit-confirm-row');
    const confirmBtn = btnRow.createEl('button', { cls: 'cs-action-btn cs-confirm-btn', text: 'Confirm' });
    const revertBtn  = btnRow.createEl('button', { cls: 'cs-action-btn cs-revert-btn', text: 'Revert' });

    const finish = () => {
      confirmBtn.remove();
      revertBtn.remove();
      diffEl.remove();
    };

    confirmBtn.addEventListener('click', () => {
      statusEl.textContent = isNewFile ? '✓ created - confirmed' : '✓ applied - confirmed';
      new Notice(`Changes to ${block.filePath} confirmed`);
      finish();
    });

    revertBtn.addEventListener('click', () => {
      void (async () => {
        try {
          if (isNewFile) {
            const created = this.app.vault.getAbstractFileByPath(block.filePath);
            if (created && created instanceof TFile) {
              await this.app.fileManager.trashFile(created);
            }
            statusEl.textContent = '↩ Reverted - file deleted';
          } else if (originalContent !== null) {
            const file = this.app.vault.getAbstractFileByPath(block.filePath);
            if (file && file instanceof TFile) {
              await this.app.vault.modify(file, originalContent);
            }
            statusEl.textContent = '↩ Reverted';
          }
          statusEl.removeClass('cs-edit-success');
          statusEl.addClass('cs-edit-reverted');
          new Notice(`Reverted changes to ${block.filePath}`);
          finish();
        } catch (e) {
          new Notice(`Failed to revert: ${(e as Error).message}`);
        }
      })();
    });
  }

  // ── Delete actions ────────────────────────────────────────────────────────

  private renderDeleteActions(bubble: HTMLElement, deleteBlocks: DeleteBlock[]) {
    for (const block of deleteBlocks) {
      const container = bubble.createDiv('cs-delete-block');
      const header = container.createDiv('cs-delete-header');
      header.createSpan({ cls: 'cs-delete-icon', text: '⚠' });
      header.createSpan({ text: `Delete ${block.filePaths.length} file${block.filePaths.length > 1 ? 's' : ''}` });

      // List each file
      const list = container.createDiv('cs-delete-list');
      for (const fp of block.filePaths) {
        const item = list.createDiv('cs-delete-item');
        item.textContent = fp;
      }

      // First confirm button
      const btnRow = container.createDiv('cs-edit-confirm-row');
      const deleteBtn = btnRow.createEl('button', { cls: 'cs-action-btn cs-revert-btn', text: 'Delete' });
      const cancelBtn = btnRow.createEl('button', { cls: 'cs-action-btn', text: 'Cancel' });
      const statusEl = container.createDiv('cs-delete-status');

      cancelBtn.addEventListener('click', () => {
        statusEl.textContent = 'Cancelled -no files deleted';
        statusEl.addClass('cs-edit-reverted');
        deleteBtn.remove();
        cancelBtn.remove();
      });

      deleteBtn.addEventListener('click', () => {
        // Replace with second confirmation
        deleteBtn.remove();
        cancelBtn.remove();

        const warning = container.createDiv('cs-delete-warning');
        warning.textContent = 'Are you sure? This cannot be undone.';

        const btnRow2 = container.createDiv('cs-edit-confirm-row');
        const confirmBtn = btnRow2.createEl('button', { cls: 'cs-action-btn cs-delete-confirm-final', text: 'Yes, delete permanently' });
        const cancel2Btn = btnRow2.createEl('button', { cls: 'cs-action-btn', text: 'Cancel' });

        cancel2Btn.addEventListener('click', () => {
          warning.remove();
          confirmBtn.remove();
          cancel2Btn.remove();
          btnRow2.remove();
          statusEl.textContent = 'Cancelled -no files deleted';
          statusEl.addClass('cs-edit-reverted');
        });

        confirmBtn.addEventListener('click', () => {
          void (async () => {
            warning.remove();
            confirmBtn.remove();
            cancel2Btn.remove();
            btnRow2.remove();

            let deleted = 0;
            const errors: string[] = [];

            for (const fp of block.filePaths) {
              const file = this.app.vault.getAbstractFileByPath(fp);
              if (file && file instanceof TFile) {
                try {
                  await this.app.fileManager.trashFile(file);
                  deleted++;
                } catch (e) {
                  errors.push(`${fp}: ${(e as Error).message}`);
                }
              } else {
                errors.push(`${fp}: not found`);
              }
            }

            if (deleted > 0) {
              statusEl.textContent = `Deleted ${deleted} file${deleted > 1 ? 's' : ''}`;
              statusEl.addClass('cs-edit-success');
              new Notice(`Deleted ${deleted} file${deleted > 1 ? 's' : ''}`);
            }
            if (errors.length > 0) {
              for (const err of errors) {
                const errEl = container.createDiv('cs-delete-error');
                errEl.textContent = err;
              }
            }
          })();
        });
      });
    }
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  private async send() {
    const text = this.inputEl.value.trim();
    if (!text || this.streaming) return;

    const id  = this.plugin.settings.activeProvider;
    const def = PROVIDERS[id];
    const ps  = this.plugin.settings.providers[id];

    if (def.apiKeyRequired && !this.plugin.getApiKey(id)) {
      new Notice(`vaultchat: Add your ${def.name} API key in Settings`);
      return;
    }

    // Collect files to include
    const filesToSend: { path: string; content: string }[] = [];
    const allPaths = new Set(this.contextFiles);

    const activeFile = this.app.workspace.getActiveFile();
    if (this.includeNoteEl.checked && activeFile) {
      allPaths.add(activeFile.path);
    }

    for (const fpath of allPaths) {
      const tf = this.app.vault.getAbstractFileByPath(fpath);
      if (tf && tf instanceof TFile) {
        try {
          const raw = await this.app.vault.read(tf);
          filesToSend.push({ path: fpath, content: raw });
        } catch { /* skip unreadable files */ }
      }
    }

    // Build user content
    let userContent = '';
    for (const f of filesToSend) {
      userContent += `<file path="${f.path}">\n${f.content}\n</file>\n\n`;
    }
    userContent += text;

    // Build system prompt -always include edit instructions + cached file tree
    let systemPrompt = this.plugin.settings.systemPrompt + '\n\n' + EDIT_INSTRUCTIONS + this.vaultFileTree;

    // Create session on first message
    if (!this.currentSession) {
      this.currentSession = {
        id:            generateId(),
        createdAt:     Date.now(),
        updatedAt:     Date.now(),
        title:         sessionTitle(text),
        provider:      id,
        model:         ps.model,
        attachedFiles: [...allPaths],
        messages:      [],
      };
    } else {
      // Track new files
      for (const p of allPaths) {
        if (!this.currentSession.attachedFiles.includes(p)) {
          this.currentSession.attachedFiles.push(p);
        }
      }
    }

    this.inputEl.value = '';
    this.inputEl.setCssStyles({ height: 'auto' });
    this.messagesEl.querySelector('.cs-welcome')?.remove();

    this.history.push({ role: 'user', content: userContent });
    this.appendUserBubble(text);

    this.streaming = true;
    this.stoppedByUser = false;
    this.sendBtn.disabled = true;
    this.sendBtn.addClass('cs-hidden');
    this.stopBtn.removeClass('cs-hidden');

    const bubble = this.messagesEl.createDiv('cs-msg cs-msg--assistant');
    const bodyEl = bubble.createDiv('cs-msg-body');
    let acc = '';
    let thinkingEl: HTMLElement | null = null;
    let streamComp = new Component();
    streamComp.load();
    this.renderComponents.push(streamComp);

    this.cancelStream = streamMessage(
      this.plugin.settings,
      this.plugin.getApiKey(this.plugin.settings.activeProvider),
      this.history,
      systemPrompt,
      chunk => {
        acc += chunk;
        thinkingEl?.remove();
        thinkingEl = null;
        bodyEl.empty();
        streamComp.unload();
        streamComp = new Component();
        streamComp.load();
        this.renderComponents.push(streamComp);
        void MarkdownRenderer.render(this.app, neutralizeExecutableFences(acc), bodyEl, '', streamComp);
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      },
      () => {
        thinkingEl?.remove();
        thinkingEl = null;
        this.cancelStream = null;
        this.streaming = false;
        this.stopBtn.addClass('cs-hidden');
        this.sendBtn.removeClass('cs-hidden');
        this.sendBtn.disabled = false;
        if (!acc) {
          // A 200 that carries no content at all. Routers answer this way when an
          // upstream declines the request, so say so instead of leaving a blank
          // bubble that looks like the plugin failed silently.
          bodyEl.addClass('cs-msg-error');
          const usedModel = this.plugin.settings.providers[this.plugin.settings.activeProvider].model;
          bodyEl.textContent = this.stoppedByUser
            ? '⚠ Stopped before the model replied.'
            : `⚠ ${usedModel} returned an empty response. That model or route is not answering, so try a different one.`;
          return;
        }
        this.history.push({ role: 'assistant', content: acc });
        this.addMessageActions(bubble, acc);
        void this.persistSession();
      },
      err => {
        thinkingEl?.remove();
        thinkingEl = null;
        bodyEl.addClass('cs-msg-error');
        bodyEl.textContent = `⚠ ${err}`;
        this.cancelStream = null;
        this.streaming = false;
        this.stopBtn.addClass('cs-hidden');
        this.sendBtn.removeClass('cs-hidden');
        this.sendBtn.disabled = false;
      },
      () => {
        // Reasoning tokens are arriving. Show that the model is working rather
        // than leaving an empty bubble; the chain of thought itself is not shown.
        if (!thinkingEl && !acc) {
          thinkingEl = bubble.createDiv('cs-thinking');
          thinkingEl.textContent = 'Thinking…';
          this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
        }
      },
    );

    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private async insertIntoNote(text: string) {
    const editor = this.app.workspace.activeEditor?.editor;
    if (editor) {
      editor.replaceSelection(text);
      new Notice('Inserted into note');
    } else {
      const file = this.app.workspace.getActiveFile();
      if (!file) { new Notice('No active note'); return; }
      const cur = await this.app.vault.read(file);
      await this.app.vault.modify(file, cur + '\n\n' + text);
      new Notice('Appended to note');
    }
  }
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class vaultchatSettingsTab extends PluginSettingTab {
  plugin: vaultchatPlugin;

  constructor(app: App, plugin: vaultchatPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    for (const [pid, def] of Object.entries(PROVIDERS) as [ProviderID, ProviderDef][]) {
      const ps = this.plugin.settings.providers[pid];
      new Setting(containerEl).setName(def.name).setHeading();

      if (def.apiKeyLabel !== null) {
        if (this.plugin.getApiKey(pid)) {
          this.renderSavedKey(containerEl, def.apiKeyLabel, pid);
        } else {
          new Setting(containerEl)
            .setName(def.apiKeyLabel)
            .setDesc(def.apiKeyRequired
              ? `Get yours from ${this.keySource(pid)}`
              : 'Only needed if your server was started with one. Leave blank otherwise.')
            .addText(t => {
              t.inputEl.type = 'password';
              t.setPlaceholder(def.apiKeyPlaceholder).onChange(v => {
                void this.plugin.setApiKey(pid, v.trim()).then(() => {
                  if (v.trim()) this.display();
                });
              });
            });
        }
      }

      const known = this.fetchedModels[pid] ?? def.models;
      const modelSetting = new Setting(containerEl)
        .setName('Model')
        .setDesc(def.dynamicModels ? 'Or type any model id supported by this provider.' : '')
        .addDropdown(dd => {
          for (const m of known) dd.addOption(m.id, m.label);
          if (ps.model && !known.find(m => m.id === ps.model)) dd.addOption(ps.model, ps.model);
          dd.setValue(ps.model || (known[0]?.id ?? ''));
          dd.onChange(v => { ps.model = v; void this.plugin.saveSettings(); });
        })
        .addText(t => {
          if (!def.dynamicModels) { t.inputEl.addClass('cs-hidden'); return; }
          t.inputEl.addClass('cs-settings-model-input');
          t.setPlaceholder('Or type model ID…')
            .onChange(v => {
              if (v.trim()) { ps.model = v.trim(); void this.plugin.saveSettings(); }
            });
        });

      if (def.dynamicModels) {
        modelSetting.addExtraButton(b => b
          .setIcon('refresh-cw')
          .setTooltip('Refresh model list')
          .onClick(() => { void this.refreshModels(pid); }),
        );
      }

      if (def.customBaseUrl) {
        new Setting(containerEl)
          .setName('Base URL')
          .setDesc('Address of your local server, including the port.')
          .addText(t => t
            .setPlaceholder(def.defaultBaseUrl)
            .setValue(ps.baseUrl || def.defaultBaseUrl)
            .onChange(v => { ps.baseUrl = v.trim(); void this.plugin.saveSettings(); }),
          );
        new Setting(containerEl)
          .setName('Context window (num_ctx)')
          .setDesc('Tokens pre-allocated for context. Leave at 0 to let the server choose. Lower values use less memory. Ignored by servers that do not support this option.')
          .addText(t => t
            .setPlaceholder('0')
            .setValue(String(this.plugin.settings.ollamaNumCtx))
            .onChange(v => {
              const n = v.trim() === '' ? 0 : parseInt(v);
              if (!isNaN(n) && n >= 0) { this.plugin.settings.ollamaNumCtx = n; void this.plugin.saveSettings(); }
            }),
          );
      }
    }

    new Setting(containerEl)
      .setName('System prompt')
      .addTextArea(ta => {
        ta.setValue(this.plugin.settings.systemPrompt)
          .onChange(v => { this.plugin.settings.systemPrompt = v; void this.plugin.saveSettings(); });
        ta.inputEl.rows = 5;
        ta.inputEl.addClass('cs-settings-textarea');
      });

    new Setting(containerEl)
      .setName('Max tokens')
      .setDesc('Maximum response length. Leave at 0 to let the model decide. Anthropic requires a value, so 0 sends 4096 there.')
      .addText(t => t
        .setPlaceholder('0')
        .setValue(String(this.plugin.settings.maxTokens))
        .onChange(v => {
          const n = v.trim() === '' ? 0 : parseInt(v);
          if (!isNaN(n) && n >= 0) { this.plugin.settings.maxTokens = n; void this.plugin.saveSettings(); }
        }),
      );

    new Setting(containerEl)
      .setName('Auto-apply edits')
      .setDesc('When enabled, file edits are applied immediately with confirm/revert buttons. Notes you attach are sent to the model, so a note containing instructions can cause edits you did not ask for. When disabled, you review each edit and click apply.')
      .addToggle(t => t
        .setValue(this.plugin.settings.autoApplyEdits)
        .onChange(v => { this.plugin.settings.autoApplyEdits = v; void this.plugin.saveSettings(); }),
      );
  }

  private renderSavedKey(containerEl: HTMLElement, label: string, pid: ProviderID) {
    const key = this.plugin.getApiKey(pid);
    let revealed = false;
    const secure = secureStore(this.app) !== null;
    const s = new Setting(containerEl)
      .setName(label)
      .setDesc(secure ? 'Key saved to Obsidian secret storage.' : 'Key saved.');
    const displayEl = s.controlEl.createEl('code', { cls: 'cs-token-display', text: maskToken(key) });
    s.controlEl.createEl('br');
    const row = s.controlEl.createDiv('cs-token-btn-row');

    const revealBtn = row.createEl('button', { cls: 'cs-tok-btn', text: 'Reveal' });
    revealBtn.addEventListener('click', () => {
      revealed = !revealed;
      displayEl.textContent = revealed ? key : maskToken(key);
      revealBtn.textContent  = revealed ? 'Hide' : 'Reveal';
    });

    const copyBtn = row.createEl('button', { cls: 'cs-tok-btn', text: 'Copy' });
    copyBtn.addEventListener('click', () => {
      void navigator.clipboard.writeText(key).then(() => {
        copyBtn.textContent = '✓ copied';
        window.setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      });
    });

    row.createEl('button', { cls: 'cs-tok-btn', text: 'Replace' })
      .addEventListener('click', () => { void this.plugin.setApiKey(pid, '').then(() => this.display()); });
    row.createEl('button', { cls: 'cs-tok-btn cs-tok-btn--danger', text: 'Remove' })
      .addEventListener('click', () => { void this.plugin.setApiKey(pid, '').then(() => this.display()); });
  }

  // Model lists pulled from a provider on demand, so the settings dropdown can
  // show them the same way the chat header does.
  private fetchedModels: Partial<Record<ProviderID, { id: string; label: string }[]>> = {};

  private async refreshModels(pid: ProviderID): Promise<void> {
    const ps = this.plugin.settings.providers[pid];
    try {
      const models = pid === 'local'
        ? await fetchLocalModels(ps.baseUrl || PROVIDERS.local.defaultBaseUrl, this.plugin.getApiKey(pid))
        : await fetchOpenRouterModels(this.plugin.getApiKey(pid));
      if (models.length === 0) {
        new Notice('No models available from this provider.');
        return;
      }
      this.fetchedModels[pid] = models;
      if (!models.find(m => m.id === ps.model)) {
        ps.model = models[0].id;
        await this.plugin.saveSettings();
      }
      new Notice(`Loaded ${models.length} models.`);
      this.display();
    } catch {
      new Notice('Could not load models. Check the base URL and key.');
    }
  }

  private keySource(id: ProviderID): string {
    const map: Record<ProviderID, string> = {
      anthropic:  'console.anthropic.com',
      openai:     'platform.openai.com/api-keys',
      gemini:     'aistudio.google.com/apikey',
      openrouter: 'openrouter.ai/keys',
      local:      '',
    };
    return map[id];
  }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default class vaultchatPlugin extends Plugin {
  settings!: vaultchatSettings;

  private get historyDir(): string {
    return `${this.app.vault.configDir}/plugins/vaultchat/history`;
  }

  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE_CHAT, leaf => new vaultchatView(leaf, this));
    this.addRibbonIcon('bot', 'Open chat', () => { void this.activateView(); });
    this.addCommand({ id: 'open-chat', name: 'Open chat', callback: () => { void this.activateView(); } });
    this.addSettingTab(new vaultchatSettingsTab(this.app, this));
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    const saved = await this.loadData() as Partial<vaultchatSettings> | null;
    migrateOllamaProvider(saved);
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    for (const id of Object.keys(PROVIDERS) as ProviderID[]) {
      if (!this.settings.providers[id]) {
        this.settings.providers[id] = { ...DEFAULT_SETTINGS.providers[id] };
      }
    }
    await this.migrateKeysToSecureStorage();
  }

  // Moves any plain-text key found in data.json into SecretStorage. A key whose
  // move fails is left in place so the user is never locked out of a provider;
  // the next load tries again.
  private async migrateKeysToSecureStorage(): Promise<void> {
    const store = secureStore(this.app);
    if (!store) return;
    let moved = false;
    for (const id of Object.keys(PROVIDERS) as ProviderID[]) {
      const plain = this.settings.providers[id].apiKey;
      if (!plain) continue;
      try {
        store.setSecret(secretId(id), plain);
        this.settings.providers[id].apiKey = '';
        moved = true;
      } catch { /* keep the plain-text key and retry next load */ }
    }
    if (moved) await this.saveSettings();
  }

  /** Reads from SecretStorage when available, falling back to data.json. */
  getApiKey(id: ProviderID): string {
    const store = secureStore(this.app);
    if (store) {
      try {
        const secret = store.getSecret(secretId(id));
        if (secret) return secret;
      } catch { /* fall through to the plain-text value */ }
    }
    return this.settings.providers[id].apiKey;
  }

  async setApiKey(id: ProviderID, key: string): Promise<void> {
    const store = secureStore(this.app);
    if (store) {
      try {
        store.setSecret(secretId(id), key);
        this.settings.providers[id].apiKey = '';
        await this.saveSettings();
        return;
      } catch { /* fall through to plain text so the key is not silently lost */ }
    }
    this.settings.providers[id].apiKey = key;
    await this.saveSettings();
  }

  async saveSettings() { await this.saveData(this.settings); }

  // ── Session persistence ─────────────────────────────────────────────────

  private async ensureHistoryDir(): Promise<void> {
    if (!await this.app.vault.adapter.exists(this.historyDir)) {
      await this.app.vault.adapter.mkdir(this.historyDir);
    }
  }

  async saveSession(session: ChatSession): Promise<void> {
    await this.ensureHistoryDir();
    await this.app.vault.adapter.write(
      `${this.historyDir}/${session.id}.json`,
      JSON.stringify(session),
    );
  }

  async loadAllSessions(): Promise<ChatSession[]> {
    await this.ensureHistoryDir();
    try {
      const listed = await this.app.vault.adapter.list(this.historyDir);
      const sessions: ChatSession[] = [];
      for (const path of listed.files) {
        if (!path.endsWith('.json')) continue;
        try {
          const raw = await this.app.vault.adapter.read(path);
          sessions.push(JSON.parse(raw) as ChatSession);
        } catch { /* skip corrupt files */ }
      }
      return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }

  async deleteSession(id: string): Promise<void> {
    const path = `${this.historyDir}/${id}.json`;
    if (await this.app.vault.adapter.exists(path)) {
      await this.app.vault.adapter.remove(path);
    }
  }
}
