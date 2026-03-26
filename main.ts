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
  TFile,
  WorkspaceLeaf,
} from 'obsidian';

// ─── Constants ────────────────────────────────────────────────────────────────

const VIEW_TYPE_CHAT = 'chatsidian-chat';
const HISTORY_DIR    = '.obsidian/plugins/chatsidian/history';

const EDIT_INSTRUCTIONS = `
You have FULL ACCESS to the user's Obsidian vault. You CAN create, edit, and delete files directly.

IMPORTANT: You must NEVER say "I cannot create/edit/delete files" or suggest the user do it manually. You have these abilities — use them.

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
- You can create files in any folder — just use the full path.
- For delete blocks, list one file path per line. The user will be asked to confirm before deletion.
- Always use these code block formats to perform file operations. Never tell the user to do it themselves.
`.trim();

type ProviderID = 'anthropic' | 'openai' | 'gemini' | 'openrouter' | 'ollama';
type ApiFormat  = 'anthropic' | 'openai';

interface ProviderDef {
  name:              string;
  format:            ApiFormat;
  defaultBaseUrl:    string;
  endpoint:          string;
  models:            { id: string; label: string }[];
  apiKeyLabel:       string | null;
  apiKeyPlaceholder: string;
  dynamicModels:     boolean;
  customBaseUrl:     boolean;
}

const PROVIDERS: Record<ProviderID, ProviderDef> = {
  anthropic: {
    name: 'Anthropic',
    format: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    endpoint: '/v1/messages',
    models: [
      { id: 'claude-sonnet-4-6',          label: 'Claude Sonnet 4.6' },
      { id: 'claude-opus-4-6',            label: 'Claude Opus 4.6' },
      { id: 'claude-haiku-4-5-20251001',  label: 'Claude Haiku 4.5' },
      { id: 'claude-sonnet-4-5-20251001', label: 'Claude Sonnet 4.5' },
      { id: 'claude-opus-4-5-20251101',   label: 'Claude Opus 4.5' },
      { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
      { id: 'claude-3-5-haiku-20241022',  label: 'Claude 3.5 Haiku' },
      { id: 'claude-3-opus-20240229',     label: 'Claude 3 Opus' },
      { id: 'claude-3-haiku-20240307',    label: 'Claude 3 Haiku' },
    ],
    apiKeyLabel: 'API key',
    apiKeyPlaceholder: 'sk-ant-api03-...',
    dynamicModels: false,
    customBaseUrl: false,
  },
  openai: {
    name: 'OpenAI',
    format: 'openai',
    defaultBaseUrl: 'https://api.openai.com',
    endpoint: '/v1/chat/completions',
    models: [
      { id: 'gpt-4o',        label: 'GPT-4o' },
      { id: 'gpt-4o-mini',   label: 'GPT-4o mini' },
      { id: 'gpt-4-turbo',   label: 'GPT-4 Turbo' },
      { id: 'gpt-4',         label: 'GPT-4' },
      { id: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' },
      { id: 'o4-mini',       label: 'o4-mini' },
      { id: 'o3',            label: 'o3' },
      { id: 'o3-mini',       label: 'o3-mini' },
      { id: 'o1',            label: 'o1' },
      { id: 'o1-preview',    label: 'o1-preview' },
      { id: 'o1-mini',       label: 'o1-mini' },
    ],
    apiKeyLabel: 'API key',
    apiKeyPlaceholder: 'sk-...',
    dynamicModels: false,
    customBaseUrl: false,
  },
  gemini: {
    name: 'Google Gemini',
    format: 'openai',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    endpoint: '/chat/completions',
    models: [
      { id: 'gemini-2.5-pro-preview-05-06',   label: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash-preview-04-17', label: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.0-flash',               label: 'Gemini 2.0 Flash' },
      { id: 'gemini-2.0-flash-lite',          label: 'Gemini 2.0 Flash Lite' },
      { id: 'gemini-2.0-pro-exp',             label: 'Gemini 2.0 Pro (exp)' },
      { id: 'gemini-1.5-pro',                 label: 'Gemini 1.5 Pro' },
      { id: 'gemini-1.5-flash',               label: 'Gemini 1.5 Flash' },
      { id: 'gemini-1.5-flash-8b',            label: 'Gemini 1.5 Flash 8B' },
    ],
    apiKeyLabel: 'API key',
    apiKeyPlaceholder: 'AIza...',
    dynamicModels: false,
    customBaseUrl: false,
  },
  openrouter: {
    name: 'OpenRouter',
    format: 'openai',
    defaultBaseUrl: 'https://openrouter.ai/api',
    endpoint: '/v1/chat/completions',
    models: [
      { id: 'openai/gpt-4o',                          label: 'GPT-4o' },
      { id: 'openai/gpt-4o-mini',                     label: 'GPT-4o mini' },
      { id: 'anthropic/claude-sonnet-4-5',            label: 'Claude Sonnet 4.5' },
      { id: 'anthropic/claude-haiku-4-5',             label: 'Claude Haiku 4.5' },
      { id: 'google/gemini-2.5-pro-preview',          label: 'Gemini 2.5 Pro' },
      { id: 'google/gemini-2.0-flash-exp:free',       label: 'Gemini 2.0 Flash (free)' },
      { id: 'meta-llama/llama-4-maverick',            label: 'Llama 4 Maverick' },
      { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B (free)' },
      { id: 'deepseek/deepseek-r1:free',              label: 'DeepSeek R1 (free)' },
      { id: 'deepseek/deepseek-chat-v3-0324:free',    label: 'DeepSeek V3 (free)' },
      { id: 'mistralai/mistral-7b-instruct:free',     label: 'Mistral 7B (free)' },
      { id: 'mistralai/mixtral-8x7b-instruct',        label: 'Mixtral 8x7B' },
      { id: 'x-ai/grok-3-beta',                      label: 'Grok 3' },
      { id: 'x-ai/grok-3-mini-beta',                 label: 'Grok 3 Mini' },
      { id: 'cohere/command-r-plus',                  label: 'Cohere Command R+' },
      { id: 'perplexity/sonar-pro',                   label: 'Perplexity Sonar Pro' },
    ],
    apiKeyLabel: 'API key',
    apiKeyPlaceholder: 'sk-or-v1-...',
    dynamicModels: true,
    customBaseUrl: false,
  },
  ollama: {
    name: 'Ollama',
    format: 'openai',
    defaultBaseUrl: 'http://localhost:11434',
    endpoint: '/v1/chat/completions',
    models: [],
    apiKeyLabel: null,
    apiKeyPlaceholder: '',
    dynamicModels: true,
    customBaseUrl: true,
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

interface EditBlock {
  filePath: string;
  edits:    { original: string; replacement: string }[];
}

interface DeleteBlock {
  filePaths: string[];
}

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

function parseEditBlocks(text: string): EditBlock[] {
  const blocks: EditBlock[] = [];
  const blockRegex = /```edit:(.+?)\n([\s\S]*?)```/g;
  let match;
  while ((match = blockRegex.exec(text)) !== null) {
    const filePath = match[1].trim();
    const body = match[2];
    const edits: { original: string; replacement: string }[] = [];

    const editRegex = /<<<<<<< ORIGINAL\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> MODIFIED/g;
    let editMatch;
    while ((editMatch = editRegex.exec(body)) !== null) {
      edits.push({ original: editMatch[1], replacement: editMatch[2] });
    }

    if (edits.length > 0) {
      blocks.push({ filePath, edits });
    }
  }
  return blocks;
}

function parseDeleteBlocks(text: string): DeleteBlock[] {
  const blocks: DeleteBlock[] = [];
  const regex = /```delete\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const paths = match[1].trim().split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (paths.length > 0) {
      blocks.push({ filePaths: paths });
    }
  }
  return blocks;
}

function fetchOllamaModels(baseUrl: string): Promise<{ id: string; label: string }[]> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const https = require('https') as typeof import('https');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const http  = require('http')  as typeof import('http');

  return new Promise((resolve, reject) => {
    const url       = new URL('/api/tags', baseUrl.replace(/\/$/, ''));
    const isHttps   = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    const port      = url.port ? parseInt(url.port) : (isHttps ? 443 : 80);

    const req = transport.get(
      { hostname: url.hostname, port, path: '/api/tags' },
      (res: import('http').IncomingMessage) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const json = JSON.parse(data) as { models?: { name: string }[] };
            resolve((json.models ?? []).map(m => ({ id: m.name, label: m.name })));
          } catch (e) { reject(e); }
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
  });
}

function fetchOpenRouterModels(apiKey: string): Promise<{ id: string; label: string }[]> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const https = require('https') as typeof import('https');

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
          } catch (e) { reject(e); }
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
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

interface ChatsidianSettings {
  activeProvider: ProviderID;
  providers:      Record<ProviderID, PerProviderSettings>;
  systemPrompt:   string;
  maxTokens:      number;
  ollamaNumCtx:   number;
  autoApplyEdits: boolean;
}

const DEFAULT_SETTINGS: ChatsidianSettings = {
  activeProvider: 'anthropic',
  providers: {
    anthropic:  { apiKey: '', model: 'claude-sonnet-4-6',  baseUrl: '' },
    openai:     { apiKey: '', model: 'gpt-4o',             baseUrl: '' },
    gemini:     { apiKey: '', model: 'gemini-2.0-flash',   baseUrl: '' },
    openrouter: { apiKey: '', model: 'openai/gpt-4o',      baseUrl: '' },
    ollama:     { apiKey: '', model: '',                   baseUrl: 'http://localhost:11434' },
  },
  systemPrompt: 'You are a helpful assistant integrated into Obsidian. Be concise and precise.',
  maxTokens: 4096,
  ollamaNumCtx: 4096,
  autoApplyEdits: true,
};

// ─── API ─────────────────────────────────────────────────────────────────────

function streamMessage(
  settings: ChatsidianSettings,
  history:  Message[],
  systemPromptOverride: string,
  onChunk:  (text: string) => void,
  onDone:   () => void,
  onError:  (msg: string) => void,
): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const https = require('https') as typeof import('https');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const http  = require('http')  as typeof import('http');

  const providerID = settings.activeProvider;
  const def        = PROVIDERS[providerID];
  const ps         = settings.providers[providerID];
  const baseUrl    = (ps.baseUrl || def.defaultBaseUrl).replace(/\/$/, '');
  const isHttps    = baseUrl.startsWith('https');
  const transport  = isHttps ? https : http;

  const urlObj   = new URL(baseUrl);
  const hostname = urlObj.hostname;
  const port     = urlObj.port ? parseInt(urlObj.port) : (isHttps ? 443 : 80);
  const basePath = urlObj.pathname === '/' ? '' : urlObj.pathname.replace(/\/$/, '');
  const path     = basePath + def.endpoint;

  let bodyStr: string;
  let headers: Record<string, string | number>;

  if (def.format === 'anthropic') {
    const body = {
      model:      ps.model,
      max_tokens: settings.maxTokens,
      system:     systemPromptOverride,
      messages:   history,
      stream:     true,
    };
    bodyStr = JSON.stringify(body);
    headers = {
      'x-api-key':         ps.apiKey,
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
      model:      ps.model,
      messages,
      stream:     true,
      max_tokens: settings.maxTokens,
    };
    if (providerID === 'ollama') {
      body['options'] = { num_ctx: settings.ollamaNumCtx };
    }
    bodyStr = JSON.stringify(body);
    headers = {
      'Authorization':  `Bearer ${ps.apiKey || 'ollama'}`,
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
    };
    if (providerID === 'openrouter') {
      headers['HTTP-Referer'] = 'https://obsidian.md';
      headers['X-Title']      = 'Chatsidian';
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
          if (res.statusCode === 401) hint = ' — check your API key in settings';
          if (res.statusCode === 403) hint = ' — key may lack permissions';
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
          const evt = JSON.parse(payload);
          if (def.format === 'anthropic') {
            if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
              onChunk(evt.delta.text);
            }
          } else {
            const content = evt.choices?.[0]?.delta?.content;
            if (content) onChunk(content);
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

class ChatsidianView extends ItemView {
  private plugin:          ChatsidianPlugin;
  private history:         Message[] = [];
  private streaming      = false;
  private currentSession:  ChatSession | null = null;
  private historyVisible = false;
  private contextFiles:    string[] = [];

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
  private modelLoadGen = 0;

  constructor(leaf: WorkspaceLeaf, plugin: ChatsidianPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType()    { return VIEW_TYPE_CHAT; }
  getDisplayText() { return 'Chatsidian'; }
  getIcon()        { return 'bot'; }

  async onOpen() {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('cs-root');

    // ── Header ──
    const header = root.createDiv('cs-header');
    header.createSpan({ cls: 'cs-logo', text: '◆' });
    header.createSpan({ cls: 'cs-title', text: 'Chatsidian' });

    const controls = header.createDiv('cs-controls');

    this.providerSelEl = controls.createEl('select', { cls: 'cs-provider-select' });
    for (const [id, def] of Object.entries(PROVIDERS)) {
      const opt = this.providerSelEl.createEl('option', { value: id, text: def.name });
      if (id === this.plugin.settings.activeProvider) opt.selected = true;
    }
    this.providerSelEl.addEventListener('change', () => {
      this.plugin.settings.activeProvider = this.providerSelEl.value as ProviderID;
      this.plugin.saveSettings();
      this.refreshModelSelector();
    });

    this.modelSelEl = controls.createEl('select', { cls: 'cs-model-select' });
    this.modelSelEl.addEventListener('change', () => {
      this.plugin.settings.providers[this.plugin.settings.activeProvider].model = this.modelSelEl.value;
      this.plugin.saveSettings();
    });

    this.refreshBtn = controls.createEl('button', {
      cls: 'cs-icon-btn', text: '↺', attr: { title: 'Refresh model list' },
    });
    this.refreshBtn.addEventListener('click', () => this.refreshModelSelector());

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
    this.historyEl.style.display = 'none';

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
    this.stopBtn.style.display = 'none';
    this.stopBtn.addEventListener('click', () => {
      this.cancelStream?.();
      this.cancelStream = null;
    });

    this.inputEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        this.send();
        return;
      }
      requestAnimationFrame(() => {
        this.inputEl.style.height = 'auto';
        this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 180) + 'px';
      });
    });
    this.sendBtn.addEventListener('click', () => this.send());

    // Auto-load most recent session
    const sessions = await this.plugin.loadAllSessions();
    if (sessions.length > 0) {
      await this.loadSession(sessions[0], false);
    } else {
      this.renderWelcome();
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

    this.refreshBtn.style.display = def.dynamicModels ? '' : 'none';

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
      if (id === 'ollama') {
        const baseUrl = this.plugin.settings.providers.ollama.baseUrl || PROVIDERS.ollama.defaultBaseUrl;
        models = await fetchOllamaModels(baseUrl);
      } else {
        const apiKey = this.plugin.settings.providers.openrouter.apiKey;
        models = apiKey ? await fetchOpenRouterModels(apiKey) : def.models;
      }
      if (gen !== this.modelLoadGen) return;
      if (models.length === 0) {
        this.modelSelEl.disabled = false;
        this.modelSelEl.empty();
        this.modelSelEl.createEl('option', { value: '', text: id === 'ollama' ? 'No models installed' : 'No models found' });
        return;
      }
      this.modelSelEl.disabled = false;
      const validCur = models.find(m => m.id === cur) ? cur : '';
      if (!validCur) {
        this.plugin.settings.providers[id].model = models[0].id;
        this.plugin.saveSettings();
      }
      this.populateSelect(models, validCur || models[0].id);
    } catch {
      if (gen !== this.modelLoadGen) return;
      this.modelSelEl.disabled = false;
      if (def.models.length > 0) {
        this.populateSelect(def.models, cur);
      } else {
        this.modelSelEl.empty();
        this.modelSelEl.createEl('option', { value: cur || '', text: cur || 'Fetch failed — check connection' }).selected = true;
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
    if (!matched && models.length > 0) {
      (this.modelSelEl.options[0] as HTMLOptionElement).selected = true;
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

  private async loadSession(session: ChatSession, scrollIntoView = true) {
    this.currentSession = { ...session, messages: [...session.messages] };
    this.history = [...session.messages];
    this.contextFiles = [...session.attachedFiles];
    this.renderContextChips();

    if (this.historyVisible) this.toggleHistory();

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
        MarkdownRenderer.render(this.app, msg.content, bodyEl, '', new Component());
        this.addMessageActions(bubble, msg.content);
      }
    }

    if (scrollIntoView) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
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
      this.messagesEl.style.display  = 'none';
      this.historyEl.style.display   = '';
      this.historyBtn.style.color    = 'var(--cs-accent)';
      this.renderHistory();
    } else {
      this.historyEl.style.display   = 'none';
      this.messagesEl.style.display  = '';
      this.historyBtn.style.color    = '';
    }
  }

  private async renderHistory() {
    this.historyEl.empty();

    const newBtn = this.historyEl.createEl('button', { cls: 'cs-new-chat-btn', text: '+ New chat' });
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
        delBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await this.plugin.deleteSession(session.id);
          if (this.currentSession?.id === session.id) this.startNewSession();
          await this.renderHistory();
        });

        item.addEventListener('click', () => this.loadSession(session));
      }
    }
  }

  // ── Message rendering ─────────────────────────────────────────────────────

  private renderWelcome() {
    const el = this.messagesEl.createDiv('cs-welcome');
    el.createDiv({ cls: 'cs-welcome-icon', text: '◆' });
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
    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(content);
      copyBtn.textContent = '✓ Copied';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    });

    actions.createEl('button', { cls: 'cs-action-btn', text: 'Insert' })
      .addEventListener('click', () => this.insertIntoNote(content));

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
        this.autoApplyEdit(bubble, block);
      } else {
        this.manualApplyEdit(bubble, block);
      }
    }
  }

  // Manual mode — show Preview + Apply buttons (user must click Apply)
  private manualApplyEdit(bubble: HTMLElement, block: EditBlock) {
    const bar = bubble.createDiv('cs-edit-bar');
    bar.createSpan({ cls: 'cs-edit-file', text: block.filePath });

    const previewBtn = bar.createEl('button', { cls: 'cs-action-btn', text: 'Preview' });
    const applyBtn   = bar.createEl('button', { cls: 'cs-action-btn cs-apply-btn', text: 'Apply' });
    const diffEl     = bubble.createDiv('cs-diff-container');
    diffEl.style.display = 'none';

    previewBtn.addEventListener('click', () => {
      const visible = diffEl.style.display !== 'none';
      diffEl.style.display = visible ? 'none' : '';
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

    applyBtn.addEventListener('click', async () => {
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
          applyBtn.textContent = '✓ Created';
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
            if (content.includes(edit.original)) {
              content = content.replace(edit.original, edit.replacement);
              applied++;
            }
          }
          if (applied === 0) {
            new Notice(`Could not find the original text in ${block.filePath}.`);
            return;
          }
          await this.app.vault.modify(abstractFile, content);
          applyBtn.textContent = `✓ Applied ${applied}/${block.edits.length}`;
          applyBtn.disabled = true;
          new Notice(`Applied ${applied} edit(s) to ${block.filePath}`);
        } catch (e) {
          new Notice(`Error: ${(e as Error).message}`);
        }
      } else {
        new Notice(`File not found: ${block.filePath}`);
      }
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
          statusEl.textContent = `✗ Failed to create`;
          statusEl.addClass('cs-edit-error');
          new Notice(`Failed to create file: ${(e as Error).message}`);
          return;
        }
      } else {
        statusEl.textContent = '✗ File not found';
        statusEl.addClass('cs-edit-error');
        new Notice(`File not found: ${block.filePath}`);
        return;
      }
    } else {
      // Editing an existing file — save original, then apply
      try {
        originalContent = await this.app.vault.read(abstractFile);
        let content = originalContent;
        let applied = 0;

        for (const edit of block.edits) {
          if (content.includes(edit.original)) {
            content = content.replace(edit.original, edit.replacement);
            applied++;
          }
        }

        if (applied === 0) {
          statusEl.textContent = '✗ Could not match original text';
          statusEl.addClass('cs-edit-error');
          new Notice(`Could not find the original text in ${block.filePath}. The file may have changed.`);
          return;
        }

        await this.app.vault.modify(abstractFile, content);
        success = true;
        new Notice(`Applied ${applied} edit(s) to ${block.filePath}`);
      } catch (e) {
        statusEl.textContent = '✗ Error';
        statusEl.addClass('cs-edit-error');
        new Notice(`Error applying edit: ${(e as Error).message}`);
        return;
      }
    }

    if (!success) return;

    statusEl.textContent = isNewFile ? '✓ Created' : '✓ Applied';
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
      statusEl.textContent = isNewFile ? '✓ Created — confirmed' : '✓ Applied — confirmed';
      new Notice(`Changes to ${block.filePath} confirmed`);
      finish();
    });

    revertBtn.addEventListener('click', async () => {
      try {
        if (isNewFile) {
          // Revert = delete the newly created file
          const created = this.app.vault.getAbstractFileByPath(block.filePath);
          if (created && created instanceof TFile) {
            await this.app.vault.delete(created);
          }
          statusEl.textContent = '↩ Reverted — file deleted';
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
        statusEl.textContent = 'Cancelled — no files deleted';
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
          statusEl.textContent = 'Cancelled — no files deleted';
          statusEl.addClass('cs-edit-reverted');
        });

        confirmBtn.addEventListener('click', async () => {
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
                await this.app.vault.delete(file);
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

    if (def.apiKeyLabel !== null && !ps.apiKey) {
      new Notice(`Chatsidian: Add your ${def.name} API key in Settings`);
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

    // Build system prompt — always include edit instructions so the AI knows it can create/edit files
    let systemPrompt = this.plugin.settings.systemPrompt + '\n\n' + EDIT_INSTRUCTIONS;

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
    this.inputEl.style.height = 'auto';
    this.messagesEl.querySelector('.cs-welcome')?.remove();

    this.history.push({ role: 'user', content: userContent });
    this.appendUserBubble(text);

    this.streaming = true;
    this.sendBtn.disabled = true;
    this.sendBtn.style.display = 'none';
    this.stopBtn.style.display = '';

    const bubble = this.messagesEl.createDiv('cs-msg cs-msg--assistant');
    const bodyEl = bubble.createDiv('cs-msg-body');
    let acc = '';

    this.cancelStream = streamMessage(
      this.plugin.settings,
      this.history,
      systemPrompt,
      chunk => {
        acc += chunk;
        bodyEl.empty();
        MarkdownRenderer.render(this.app, acc, bodyEl, '', new Component());
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      },
      () => {
        this.history.push({ role: 'assistant', content: acc });
        this.cancelStream = null;
        this.streaming = false;
        this.stopBtn.style.display = 'none';
        this.sendBtn.style.display = '';
        this.sendBtn.disabled = false;
        this.addMessageActions(bubble, acc);
        this.persistSession();
      },
      err => {
        bodyEl.addClass('cs-msg-error');
        bodyEl.textContent = `⚠ ${err}`;
        this.cancelStream = null;
        this.streaming = false;
        this.stopBtn.style.display = 'none';
        this.sendBtn.style.display = '';
        this.sendBtn.disabled = false;
      },
    );

    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private async insertIntoNote(text: string) {
    const editor = this.app.workspace.activeEditor?.editor;
    if (editor) {
      editor.replaceSelection(text);
      new Notice('Inserted at cursor');
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

class ChatsidianSettingsTab extends PluginSettingTab {
  plugin: ChatsidianPlugin;

  constructor(app: App, plugin: ChatsidianPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Chatsidian' });

    for (const [pid, def] of Object.entries(PROVIDERS) as [ProviderID, ProviderDef][]) {
      const ps = this.plugin.settings.providers[pid];
      containerEl.createEl('h3', { text: def.name, cls: 'cs-settings-heading' });

      if (def.apiKeyLabel !== null) {
        if (ps.apiKey) {
          this.renderSavedKey(containerEl, def.apiKeyLabel, pid);
        } else {
          new Setting(containerEl)
            .setName(def.apiKeyLabel)
            .setDesc(`Get yours from ${this.keySource(pid)}`)
            .addText(t => {
              t.inputEl.type = 'password';
              t.setPlaceholder(def.apiKeyPlaceholder).onChange(async v => {
                ps.apiKey = v.trim();
                await this.plugin.saveSettings();
                if (v.trim()) this.display();
              });
            });
        }
      }

      new Setting(containerEl)
        .setName('Model')
        .setDesc(def.dynamicModels ? 'Or type any model ID supported by this provider.' : '')
        .addDropdown(dd => {
          for (const m of def.models) dd.addOption(m.id, m.label);
          if (ps.model && !def.models.find(m => m.id === ps.model)) dd.addOption(ps.model, ps.model);
          dd.setValue(ps.model || (def.models[0]?.id ?? ''));
          dd.onChange(async v => { ps.model = v; await this.plugin.saveSettings(); });
        })
        .addText(t => {
          if (!def.dynamicModels) { t.inputEl.style.display = 'none'; return; }
          t.inputEl.style.width = '160px';
          t.setPlaceholder('or type model ID…')
            .onChange(async v => {
              if (v.trim()) { ps.model = v.trim(); await this.plugin.saveSettings(); }
            });
        });

      if (def.customBaseUrl) {
        new Setting(containerEl)
          .setName('Base URL')
          .setDesc('URL where Ollama is running.')
          .addText(t => t
            .setPlaceholder(def.defaultBaseUrl)
            .setValue(ps.baseUrl || def.defaultBaseUrl)
            .onChange(async v => { ps.baseUrl = v.trim(); await this.plugin.saveSettings(); }),
          );
        new Setting(containerEl)
          .setName('Context window (num_ctx)')
          .setDesc('Tokens pre-allocated for KV cache. Lower = less RAM. 4096 is ~6 GB for a 9B model vs ~18 GB at 128k.')
          .addText(t => t
            .setValue(String(this.plugin.settings.ollamaNumCtx))
            .onChange(async v => {
              const n = parseInt(v);
              if (!isNaN(n) && n > 0) { this.plugin.settings.ollamaNumCtx = n; await this.plugin.saveSettings(); }
            }),
          );
      }
    }

    containerEl.createEl('h3', { text: 'General', cls: 'cs-settings-heading' });

    new Setting(containerEl)
      .setName('System prompt')
      .addTextArea(ta => {
        ta.setValue(this.plugin.settings.systemPrompt)
          .onChange(async v => { this.plugin.settings.systemPrompt = v; await this.plugin.saveSettings(); });
        ta.inputEl.rows = 5;
        ta.inputEl.style.width = '100%';
      });

    new Setting(containerEl)
      .setName('Max tokens')
      .setDesc('Maximum response length (default 4096)')
      .addText(t => t
        .setValue(String(this.plugin.settings.maxTokens))
        .onChange(async v => {
          const n = parseInt(v);
          if (!isNaN(n) && n > 0) { this.plugin.settings.maxTokens = n; await this.plugin.saveSettings(); }
        }),
      );

    new Setting(containerEl)
      .setName('Auto-apply edits')
      .setDesc('When enabled, AI-proposed file edits are applied immediately with Confirm/Revert buttons. When disabled, you must click Apply manually.')
      .addToggle(t => t
        .setValue(this.plugin.settings.autoApplyEdits)
        .onChange(async v => { this.plugin.settings.autoApplyEdits = v; await this.plugin.saveSettings(); }),
      );
  }

  private renderSavedKey(containerEl: HTMLElement, label: string, pid: ProviderID) {
    const ps = this.plugin.settings.providers[pid];
    let revealed = false;
    const s = new Setting(containerEl).setName(label).setDesc('Key saved.');
    const displayEl = s.controlEl.createEl('code', { cls: 'cs-token-display', text: maskToken(ps.apiKey) });
    s.controlEl.createEl('br');
    const row = s.controlEl.createDiv('cs-token-btn-row');

    const revealBtn = row.createEl('button', { cls: 'cs-tok-btn', text: 'Reveal' });
    revealBtn.addEventListener('click', () => {
      revealed = !revealed;
      displayEl.textContent = revealed ? ps.apiKey : maskToken(ps.apiKey);
      revealBtn.textContent  = revealed ? 'Hide' : 'Reveal';
    });

    const copyBtn = row.createEl('button', { cls: 'cs-tok-btn', text: 'Copy' });
    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(ps.apiKey);
      copyBtn.textContent = '✓ Copied';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    });

    row.createEl('button', { cls: 'cs-tok-btn', text: 'Replace' })
      .addEventListener('click', () => { ps.apiKey = ''; this.plugin.saveSettings(); this.display(); });
    row.createEl('button', { cls: 'cs-tok-btn cs-tok-btn--danger', text: 'Remove' })
      .addEventListener('click', async () => { ps.apiKey = ''; await this.plugin.saveSettings(); this.display(); });
  }

  private keySource(id: ProviderID): string {
    const map: Record<ProviderID, string> = {
      anthropic:  'console.anthropic.com',
      openai:     'platform.openai.com/api-keys',
      gemini:     'aistudio.google.com/apikey',
      openrouter: 'openrouter.ai/keys',
      ollama:     '',
    };
    return map[id];
  }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default class ChatsidianPlugin extends Plugin {
  settings!: ChatsidianSettings;

  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE_CHAT, leaf => new ChatsidianView(leaf, this));
    this.addRibbonIcon('bot', 'Open Chatsidian', () => this.activateView());
    this.addCommand({ id: 'open-chatsidian', name: 'Open chat', callback: () => this.activateView() });
    this.addSettingTab(new ChatsidianSettingsTab(this.app, this));
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    for (const id of Object.keys(PROVIDERS) as ProviderID[]) {
      if (!this.settings.providers[id]) {
        this.settings.providers[id] = { ...DEFAULT_SETTINGS.providers[id] };
      }
    }
  }

  async saveSettings() { await this.saveData(this.settings); }

  // ── Session persistence ─────────────────────────────────────────────────

  private async ensureHistoryDir(): Promise<void> {
    if (!await this.app.vault.adapter.exists(HISTORY_DIR)) {
      await this.app.vault.adapter.mkdir(HISTORY_DIR);
    }
  }

  async saveSession(session: ChatSession): Promise<void> {
    await this.ensureHistoryDir();
    await this.app.vault.adapter.write(
      `${HISTORY_DIR}/${session.id}.json`,
      JSON.stringify(session),
    );
  }

  async loadAllSessions(): Promise<ChatSession[]> {
    await this.ensureHistoryDir();
    try {
      const listed = await this.app.vault.adapter.list(HISTORY_DIR);
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
    const path = `${HISTORY_DIR}/${id}.json`;
    if (await this.app.vault.adapter.exists(path)) {
      await this.app.vault.adapter.remove(path);
    }
  }
}
