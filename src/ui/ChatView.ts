import {
  Component,
  ItemView,
  MarkdownRenderer,
  Modal,
  Notice,
  TFile,
  TFolder,
  normalizePath,
  setIcon,
} from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
import { buildFileTreeContext, neutralizeExecutableFences } from '../core';
import { FILE_TREE_MAX_FILES, VIEW_TYPE_CHAT } from '../constants';
import { AGENT_INSTRUCTIONS, EDIT_INSTRUCTIONS } from '../prompts';
import { formatToolResults, parseToolCalls } from '../agent/protocol';
import { ToolExecutor } from '../agent/executor';
import { validateCall } from '../agent/registry';
import { affectedFiles, operationsFromCall, pruneNoOps } from '../agent/plan';
import { PlanExecutor } from '../agent/PlanExecutor';
import { PlanModal } from './PlanModal';
import { PROVIDERS } from '../providers/catalog';
import { fetchLocalModels, fetchOpenRouterModels } from '../providers/models';
import { streamMessage } from '../providers/stream';
import { diagnoseEmptyResponse } from '../providers/diagnose';
import { parseDeleteBlocks, parseEditBlocks } from '../vault/blocks';
import { resolveActiveEndpoint, updateEndpoint } from '../endpoints/manager';
import { allPresets, findPreset, presetEffect } from '../settings/presets';
import {
  activePath,
  appendMessage,
  branchFrom,
  branchPosition,
  conversationToMarkdown,
  deleteSubtree,
  descendantIds,
  pathToRoot,
  repairActiveLeaf,
  siblingsOf,
  switchToBranch,
  toWireMessages,
} from '../chat/messageTree';
import { generateId } from '../ids';
import { parseConversationMarkdown } from '../chat/import';
import { gatherContext } from '../context/gather';
import { estimateTokens, renderContextBlocks } from '../context/resolve';
import { FileSuggestModal } from './FileSuggestModal';
import { FolderSuggestModal } from './FolderSuggestModal';
import { SessionRenameModal } from './SessionRenameModal';
import { ImportChatModal } from './ImportChatModal';
import { VaultEditActions } from './VaultEditActions';
import { fileBlockPrefix, sessionTitle, stripFileBlocks, timeAgo } from './format';
import type { ChatSession, Message } from '../chat/types';
import type { ToolResult } from '../agent/types';
import type { VaultOperation, VaultPlan } from '../agent/plan';
import type { ContextBudget, ContextSource } from '../context/types';
import type { OpenAICompatibleEndpoint } from '../endpoints/types';
import type { VaultChatHost } from '../host';
import type { ModelDefinition, ProviderID } from '../providers/catalog';

/** How many tool rounds one user turn may use before it must answer. */
const MAX_TOOL_ROUNDS = 5;

/** Everything one generation needs, resolved once before the request goes out. */
interface GenerationConfig {
  apiKey:       string;
  model:        string;
  endpoint:     OpenAICompatibleEndpoint | null;
  systemPrompt: string;
  maxTokens:    number;
}

export class VaultchatView extends ItemView {
  private plugin:          VaultChatHost;
  private streaming      = false;
  private currentSession:  ChatSession | null = null;
  private historyVisible = false;
  private historyFilter  = '';
  private historySort    : 'recent' | 'oldest' | 'title' = 'recent';
  private contextSources:  ContextSource[] = [{ kind: 'entire-vault' }];
  private vaultFileTree  = '';

  private messagesEl!:     HTMLElement;
  private historyEl!:      HTMLElement;
  private inputEl!:        HTMLTextAreaElement;
  private sendBtn!:        HTMLButtonElement;
  private stopBtn!:        HTMLButtonElement;
  private historyBtn!:     HTMLButtonElement;
  private includeNoteEl!:  HTMLInputElement;
  private includeFolderEl!: HTMLInputElement;
  private includeVaultEl!: HTMLInputElement;
  private contextChipsEl!: HTMLElement;
  private contextSummaryEl!: HTMLElement;
  private presetSelEl!:    HTMLSelectElement;
  private providerSelEl!:  HTMLSelectElement;
  private endpointSelEl!:  HTMLSelectElement;
  private modelSelEl!:     HTMLSelectElement;
  private refreshBtn!:     HTMLButtonElement;

  private cancelStream: (() => void) | null = null;
  private stoppedByUser = false;
  private modelLoadGen = 0;
  private renderComponents: Component[] = [];
  private editActions:      VaultEditActions;
  private tools:            ToolExecutor;
  private planExecutor:     PlanExecutor;
  /** Tool rounds used by the turn in flight, so a loop cannot run away. */
  private toolRounds = 0;

  constructor(leaf: WorkspaceLeaf, plugin: VaultChatHost) {
    super(leaf);
    this.plugin = plugin;
    this.editActions = new VaultEditActions(this.app, () => this.plugin.settings.autoApplyEdits);
    this.tools = new ToolExecutor(this.app, plugin.index);
    this.planExecutor = new PlanExecutor(this.app);
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

    this.presetSelEl = controls.createEl('select', {
      cls: 'cs-preset-select', attr: { title: 'Preset' },
    });
    this.renderPresetSelector();
    this.presetSelEl.addEventListener('change', () => {
      void this.applyPreset(this.presetSelEl.value);
    });

    this.providerSelEl = controls.createEl('select', { cls: 'cs-provider-select' });
    for (const [id, def] of Object.entries(PROVIDERS)) {
      const opt = this.providerSelEl.createEl('option', { value: id, text: def.name });
      if (id === this.plugin.settings.activeProvider) opt.selected = true;
    }
    this.providerSelEl.addEventListener('change', () => {
      this.plugin.settings.activeProvider = this.providerSelEl.value as ProviderID;
      void this.plugin.saveSettings();
      this.renderEndpointSelector();
      void this.refreshModelSelector().then(() => { this.saveSessionSelection(); });
    });

    // Which OpenAI-compatible server the 'local' provider talks to. Hidden for
    // the hosted providers, which have one fixed address each.
    this.endpointSelEl = controls.createEl('select', {
      cls: 'cs-endpoint-select', attr: { title: 'OpenAI-compatible server' },
    });
    this.endpointSelEl.addEventListener('change', () => {
      this.plugin.settings.activeEndpointId = this.endpointSelEl.value;
      void this.plugin.saveSettings();
      void this.refreshModelSelector().then(() => { this.saveSessionSelection(); });
    });
    this.renderEndpointSelector();

    this.modelSelEl = controls.createEl('select', { cls: 'cs-model-select' });
    this.modelSelEl.addEventListener('change', () => {
      this.setCurrentModel(this.modelSelEl.value);
      void this.plugin.saveSettings();
      this.saveSessionSelection();
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

    const copyAllBtn = controls.createEl('button', {
      cls: 'cs-icon-btn', text: '⧉', attr: { title: 'Copy conversation as Markdown' },
    });
    copyAllBtn.addEventListener('click', () => {
      if (!this.currentSession) { new Notice('Nothing to copy yet.'); return; }
      void navigator.clipboard.writeText(conversationToMarkdown(this.currentSession)).then(() => {
        new Notice('Conversation copied as Markdown.');
      });
    });

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

    // Context row: source toggles + pickers
    const ctxRow = footer.createDiv('cs-ctx-row');
    const vaultOption = ctxRow.createDiv('cs-ctx-option');
    this.includeVaultEl = vaultOption.createEl('input', { type: 'checkbox', cls: 'cs-ctx-check' });
    this.includeVaultEl.id = 'cs-include-vault';
    vaultOption.createEl('label', {
      text: 'Entire vault',
      attr: { for: 'cs-include-vault', title: 'Allow indexed search and on-demand note reads' },
      cls:  'cs-ctx-label',
    });
    this.includeVaultEl.addEventListener('change', () => {
      this.toggleSource({ kind: 'entire-vault' }, this.includeVaultEl.checked);
    });

    const noteOption = ctxRow.createDiv('cs-ctx-option');
    this.includeNoteEl = noteOption.createEl('input', { type: 'checkbox', cls: 'cs-ctx-check' });
    this.includeNoteEl.id = 'cs-include-note';
    noteOption.createEl('label', {
      text: 'Current note',
      attr: { for: 'cs-include-note' },
      cls:  'cs-ctx-label',
    });
    this.includeNoteEl.addEventListener('change', () => {
      this.toggleSource({ kind: 'current-note' }, this.includeNoteEl.checked);
    });

    const folderOption = ctxRow.createDiv('cs-ctx-option');
    this.includeFolderEl = folderOption.createEl('input', { type: 'checkbox', cls: 'cs-ctx-check' });
    this.includeFolderEl.id = 'cs-include-folder';
    folderOption.createEl('label', {
      text: 'Current folder',
      attr: { for: 'cs-include-folder', title: 'Every note in the open note\u2019s folder, recursively' },
      cls:  'cs-ctx-label',
    });
    this.includeFolderEl.addEventListener('change', () => {
      this.toggleSource({ kind: 'current-folder', recursive: true }, this.includeFolderEl.checked);
    });

    const autoOption = ctxRow.createDiv('cs-ctx-option');
    const autoEl = autoOption.createEl('input', { type: 'checkbox', cls: 'cs-ctx-check' });
    autoEl.id = 'cs-auto-apply';
    autoEl.checked = this.plugin.settings.autoApplyEdits;
    autoOption.createEl('label', {
      text: 'Auto-apply edits',
      attr: { for: 'cs-auto-apply', title: 'Apply file edits without clicking apply first' },
      cls:  'cs-ctx-label',
    });
    autoEl.addEventListener('change', () => {
      this.plugin.settings.autoApplyEdits = autoEl.checked;
      void this.plugin.saveSettings();
    });

    ctxRow.createEl('button', {
      cls: 'cs-add-file-btn', text: '+ file', attr: { title: 'Add files to context' },
    }).addEventListener('click', () => {
      new FileSuggestModal(this.app, this.sourcePaths('file'), (file: TFile, added: boolean) => {
        this.toggleSource({ kind: 'file', path: file.path }, added);
      }).open();
    });

    ctxRow.createEl('button', {
      cls: 'cs-add-file-btn', text: '+ folder', attr: { title: 'Add folders to context' },
    }).addEventListener('click', () => {
      new FolderSuggestModal(this.app, this.sourcePaths('folder'), (folder: TFolder, added: boolean) => {
        this.toggleSource({ kind: 'folder', path: folder.path, recursive: true }, added);
      }).open();
    });

    // Chips, then the one-line summary that opens the inspector
    this.contextChipsEl   = footer.createDiv('cs-ctx-chips');
    this.contextSummaryEl = footer.createDiv('cs-ctx-summary');
    this.contextSummaryEl.addEventListener('click', () => { void this.openContextInspector(); });
    this.syncContextToggles();
    this.renderContextChips();

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

  // ── Public API, used by the command palette ───────────────────────────────

  /**
   * Seeds the composer with a prompt and optional context, ready to send.
   *
   * Deliberately does not send on its own: a command that fires a request the
   * moment it is invoked gives the user no chance to adjust the wording, and
   * every one of these commands is a starting point rather than a finished
   * question.
   */
  seedPrompt(text: string, sources: ContextSource[] = []): void {
    for (const source of sources) this.toggleSource(source, true);
    this.syncContextToggles();
    this.inputEl.value = text;
    this.inputEl.focus();
    // Caret at the end so typing continues the prompt instead of overwriting it.
    this.inputEl.setSelectionRange(text.length, text.length);
    this.inputEl.setCssStyles({ height: 'auto' });
    this.inputEl.setCssStyles({ height: Math.min(this.inputEl.scrollHeight, 180) + 'px' });
  }

  /** Attaches a source without touching the composer. */
  addContext(source: ContextSource): void {
    this.toggleSource(source, true);
    this.syncContextToggles();
  }

  newChat(): void {
    this.startNewSession();
  }

  private rebuildFileTree() {
    const files = this.app.vault.getFiles()
      .filter(f => !f.path.startsWith(this.app.vault.configDir + '/'))
      .map(f => ({ path: f.path, mtime: f.stat.mtime }));
    this.vaultFileTree = buildFileTreeContext(files, FILE_TREE_MAX_FILES);
  }


  // ── Context chips ──────────────────────────────────────────────────────────

  /** Paths already attached for a given source kind, for the picker's checkmarks. */
  private sourcePaths(kind: 'file' | 'folder'): string[] {
    return this.contextSources
      .filter((s): s is Extract<ContextSource, { path: string }> => s.kind === kind)
      .map(s => s.path);
  }

  private sameSource(a: ContextSource, b: ContextSource): boolean {
    if (a.kind !== b.kind) return false;
    if ('path' in a && 'path' in b) return a.path === b.path;
    return true;
  }

  private toggleSource(source: ContextSource, on: boolean) {
    const without = this.contextSources.filter(s => !this.sameSource(s, source));
    const selected = source.kind === 'current-note' && !this.plugin.settings.dynamicCurrentNote
      ? { kind: 'current-note' as const, path: this.app.workspace.getActiveFile()?.path }
      : source;
    this.contextSources = on ? [...without, selected] : without;
    this.renderContextChips();
    if (this.currentSession) {
      this.currentSession.contextSources = this.contextSources.map(item => ({ ...item }));
      void this.persistSession();
    }
  }

  private chipLabel(source: ContextSource): { text: string; title: string } {
    switch (source.kind) {
      case 'entire-vault':
        return { text: 'Entire vault', title: 'Indexed search and on-demand note reads' };
      case 'current-note':
        return {
          text: 'Current note',
          title: this.plugin.settings.dynamicCurrentNote
            ? 'The note currently open in the editor'
            : `The note selected when this source was added${source.path ? `: ${source.path}` : ''}`,
        };
      case 'current-folder':
        return { text: 'Current folder', title: 'Every note under the open note\u2019s folder' };
      case 'file':
        return { text: source.path.split('/').pop() ?? source.path, title: source.path };
      case 'folder':
        return { text: `${source.path}/`, title: `Every note under ${source.path}` };
    }
  }

  private renderContextChips() {
    this.contextChipsEl.empty();
    for (const source of this.contextSources) {
      const { text, title } = this.chipLabel(source);
      const chip = this.contextChipsEl.createDiv('cs-ctx-chip');
      chip.createSpan({ text, attr: { title } });
      chip.createEl('button', { cls: 'cs-chip-remove', text: '×' })
        .addEventListener('click', () => {
          this.toggleSource(source, false);
          this.syncContextToggles();
        });
    }
    void this.refreshContextSummary();
  }

  /** Keeps the two checkboxes agreeing with the source list after a chip is removed. */
  private syncContextToggles() {
    this.includeVaultEl.checked  = this.contextSources.some(s => s.kind === 'entire-vault');
    this.includeNoteEl.checked   = this.contextSources.some(s => s.kind === 'current-note');
    this.includeFolderEl.checked = this.contextSources.some(s => s.kind === 'current-folder');
  }

  private async currentContext(): Promise<ContextBudget> {
    const sources = this.plugin.settings.dynamicCurrentNote
      ? this.contextSources.map(source => source.kind === 'current-note'
        ? { kind: 'current-note' as const }
        : source)
      : this.contextSources;
    return gatherContext(
      this.app,
      sources,
      this.app.workspace.getActiveFile()?.path ?? null,
      this.plugin.settings.ignoredPaths,
      this.plugin.settings.contextMaxTokens,
    );
  }

  /**
   * The one-line "what can this chat see" summary (§28).
   *
   * Counts come from actually resolving and reading the files, not from the
   * number of chips: a folder chip can be one chip and forty notes, and the
   * whole point of the line is to say so before the request goes out.
   */
  private async refreshContextSummary() {
    if (this.contextSources.length === 0) {
      this.contextSummaryEl.empty();
      this.contextSummaryEl.addClass('cs-hidden');
      return;
    }
    this.contextSummaryEl.removeClass('cs-hidden');
    this.contextSummaryEl.setText('Context: reading\u2026');

    const budget = await this.currentContext();
    const parts: string[] = [];
    if (this.contextSources.some(source => source.kind === 'entire-vault')) {
      parts.push('vault search enabled');
    }
    parts.push(`${budget.included.length} file${budget.included.length === 1 ? '' : 's'}`,
      `~${budget.estimatedTokens.toLocaleString()} tokens`);
    if (budget.skipped.length > 0) parts.push(`${budget.skipped.length} skipped`);

    this.contextSummaryEl.empty();
    this.contextSummaryEl.createSpan({ text: `Context: ${parts.join(' \u00b7 ')}` });
    this.contextSummaryEl.createSpan({ cls: 'cs-ctx-inspect', text: 'inspect' });
    this.contextSummaryEl.toggleClass('cs-ctx-over', budget.skipped.length > 0);
  }

  /** Exact paths and the reason each one is included or was left out. */
  private async openContextInspector() {
    if (this.contextSources.length === 0) return;
    const budget = await this.currentContext();
    const modal  = new Modal(this.app);
    modal.setTitle('Context');

    const { contentEl } = modal;
    if (this.contextSources.some(source => source.kind === 'entire-vault')) {
      contentEl.createDiv({
        cls: 'cs-inspect-total',
        text: 'Entire vault: indexed search and on-demand note reads enabled.',
      });
    }
    contentEl.createDiv({
      cls: 'cs-inspect-total',
      text: `${budget.included.length} file${budget.included.length === 1 ? '' : 's'} \u00b7 `
          + `~${budget.estimatedTokens.toLocaleString()} of `
          + `${this.plugin.settings.contextMaxTokens.toLocaleString()} tokens`,
    });

    for (const file of budget.included) {
      const row = contentEl.createDiv('cs-inspect-row');
      row.createSpan({ cls: 'cs-inspect-path', text: file.path });
      row.createSpan({ cls: 'cs-inspect-why',  text: file.reason });
      row.createSpan({ cls: 'cs-inspect-size', text: `~${estimateTokens(file.content).toLocaleString()}` });
    }

    if (budget.skipped.length > 0) {
      contentEl.createDiv({ cls: 'cs-inspect-heading', text: 'Not sent' });
      for (const file of budget.skipped) {
        const row = contentEl.createDiv('cs-inspect-row cs-inspect-row--skipped');
        row.createSpan({ cls: 'cs-inspect-path', text: file.path });
        row.createSpan({ cls: 'cs-inspect-why',  text: file.reason });
      }
    }
    modal.open();
  }

  // ── Presets ───────────────────────────────────────────────────────────────

  private renderPresetSelector(): void {
    const presets = allPresets(this.plugin.settings.presets);
    this.presetSelEl.empty();
    this.presetSelEl.createEl('option', { value: '', text: 'No preset' });
    for (const preset of presets) {
      const opt = this.presetSelEl.createEl('option', { value: preset.id, text: preset.name });
      if (preset.id === this.plugin.settings.activePresetId) opt.selected = true;
    }
  }

  /**
   * Applies a preset, changing only the settings it actually names.
   *
   * Choosing "Summarize" must not silently move the user off the model they
   * picked, so anything the preset leaves undefined is left exactly as it was.
   */
  private async applyPreset(id: string): Promise<void> {
    const settings = this.plugin.settings;
    settings.activePresetId = id === '' ? null : id;

    const preset = findPreset(allPresets(settings.presets), settings.activePresetId);
    if (preset) {
      const effect = presetEffect(preset);
      if (effect.systemPrompt !== undefined) settings.systemPrompt = effect.systemPrompt;
      if (effect.provider     !== undefined) settings.activeProvider = effect.provider;
      if (effect.endpointId   !== undefined) settings.activeEndpointId = effect.endpointId;
      if (effect.maxTokens    !== undefined) settings.maxTokens = effect.maxTokens;
      if (effect.model !== undefined) {
        this.setCurrentModel(effect.model);
      }
      if (effect.includeCurrentNote) {
        this.toggleSource({ kind: 'current-note' }, true);
        this.syncContextToggles();
      }
      if (this.currentSession) {
        if (effect.systemPrompt !== undefined) this.currentSession.systemPrompt = effect.systemPrompt;
        if (effect.maxTokens !== undefined) this.currentSession.maxTokens = effect.maxTokens;
        this.saveSessionSelection();
      }
      new Notice(`Preset: ${preset.name}`);
    }

    await this.plugin.saveSettings();
    // The header may now be pointing somewhere else entirely.
    for (const opt of Array.from(this.providerSelEl.options)) {
      opt.selected = opt.value === settings.activeProvider;
    }
    this.renderEndpointSelector();
    await this.refreshModelSelector();
  }

  // ── Endpoint selector ─────────────────────────────────────────────────────

  /** The saved server the local provider currently points at, if any. */
  private activeEndpoint(): OpenAICompatibleEndpoint | null {
    return resolveActiveEndpoint(this.plugin.settings.endpoints, this.plugin.settings.activeEndpointId);
  }

  private renderEndpointSelector() {
    const isLocal = this.plugin.settings.activeProvider === 'local';
    this.endpointSelEl.toggleClass('cs-hidden', !isLocal);
    if (!isLocal) return;

    const enabled = this.plugin.settings.endpoints.filter(e => e.enabled);
    this.endpointSelEl.empty();
    if (enabled.length === 0) {
      this.endpointSelEl.createEl('option', { value: '', text: 'No endpoints -add one in settings' });
      this.endpointSelEl.disabled = true;
      return;
    }
    this.endpointSelEl.disabled = false;
    const active = this.activeEndpoint();
    for (const e of enabled) {
      const opt = this.endpointSelEl.createEl('option', { value: e.id, text: e.name });
      if (e.id === active?.id) opt.selected = true;
    }
  }

  // ── Model selector ────────────────────────────────────────────────────────

  /**
   * The model in force right now. For the local provider that is a property of
   * the selected endpoint, so switching servers switches models with it rather
   * than carrying one server's model id over to another that has never heard
   * of it.
   */
  private currentModel(): string {
    const id = this.plugin.settings.activeProvider;
    if (id === 'local') return this.activeEndpoint()?.defaultModel ?? '';
    return this.plugin.settings.providers[id].model;
  }

  private setCurrentModel(model: string): void {
    const id = this.plugin.settings.activeProvider;
    if (id !== 'local') {
      this.plugin.settings.providers[id].model = model;
      return;
    }
    const ep = this.activeEndpoint();
    if (!ep) return;
    this.plugin.settings.endpoints =
      updateEndpoint(this.plugin.settings.endpoints, ep.id, { defaultModel: model });
  }

  private async refreshModelSelector() {
    const gen = ++this.modelLoadGen;
    const id  = this.plugin.settings.activeProvider;
    const def = PROVIDERS[id];
    const cur = this.currentModel();

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
      let models: ModelDefinition[];
      if (id === 'local') {
        const ep = this.activeEndpoint();
        if (!ep) {
          this.modelSelEl.disabled = false;
          this.modelSelEl.empty();
          this.modelSelEl.createEl('option', { value: '', text: 'No endpoint selected' });
          return;
        }
        models = await fetchLocalModels(ep.baseUrl, this.plugin.getEndpointApiKey(ep.id));
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
        this.setCurrentModel(models[0].id);
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

  private populateSelect(models: ModelDefinition[], current: string) {
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

  /** The branch currently on screen. */
  private path(): Message[] {
    return this.currentSession ? activePath(this.currentSession) : [];
  }

  private startNewSession() {
    this.currentSession = null;
    this.contextSources = [{ kind: 'entire-vault' }];
    this.syncContextToggles();
    this.renderContextChips();
    if (this.historyVisible) this.toggleHistory();
    this.messagesEl.empty();
    this.renderWelcome();
  }

  /** Header choices are per-chat once a conversation exists; globals remain defaults for new chats. */
  private saveSessionSelection(): void {
    if (!this.currentSession) return;
    this.currentSession.provider = this.plugin.settings.activeProvider;
    this.currentSession.endpointId = this.plugin.settings.activeProvider === 'local'
      ? this.activeEndpoint()?.id ?? null
      : null;
    this.currentSession.model = this.currentModel();
    void this.persistSession();
  }

  private loadSession(session: ChatSession, scrollIntoView = true) {
    this.currentSession = { ...session, messages: [...session.messages] };
    this.contextSources = session.contextSources?.map(source => ({ ...source }))
      // Pre-2.0 chats only know the concrete files they sent.
      ?? session.attachedFiles.map(path => ({ kind: 'file' as const, path }));
    if (!this.plugin.settings.dynamicCurrentNote) {
      const activePath = this.app.workspace.getActiveFile()?.path;
      this.contextSources = this.contextSources.map(source =>
        source.kind === 'current-note' && source.path === undefined
          ? { ...source, path: activePath }
          : source);
    }
    this.syncContextToggles();
    this.renderContextChips();

    this.plugin.settings.activeProvider = session.provider;
    this.providerSelEl.value = session.provider;
    if (session.provider === 'local' && session.endpointId) {
      this.plugin.settings.activeEndpointId = session.endpointId;
    }
    this.renderEndpointSelector();
    if (session.model) this.setCurrentModel(session.model);
    void this.plugin.saveSettings();
    void this.refreshModelSelector();

    if (this.historyVisible) this.toggleHistory();

    this.renderConversation(scrollIntoView);
  }

  /** Rebuilds the message list from the tree. The single source of truth. */
  private renderConversation(scrollIntoView = true) {
    this.cleanupRenderComponents();
    this.messagesEl.empty();

    const branch = this.path();
    if (branch.length === 0) {
      this.renderWelcome();
      return;
    }

    for (const msg of branch) this.renderMessage(msg);

    if (scrollIntoView) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private renderMessage(msg: Message) {
    if (msg.metadata?.toolResults === true) {
      // Shown, because hiding what the agent actually read would make its
      // answers unauditable -- but collapsed, because it is not conversation.
      const details = this.messagesEl.createEl('details', { cls: 'cs-tool-turn' });
      details.createEl('summary', { text: 'Tool results' });
      details.createEl('pre').createEl('code', { text: msg.content });
      return;
    }
    const requestedTools = parseToolCalls(msg.content, i => `${msg.id}-render-${i}`);
    if (requestedTools.length > 0) {
      const details = this.messagesEl.createEl('details', { cls: 'cs-tool-turn' });
      details.createEl('summary', {
        text: `Tool request: ${requestedTools.map(call => call.tool).join(', ')}`,
      });
      details.createEl('pre').createEl('code', { text: msg.content });
      return;
    }
    if (msg.role === 'user') {
      const bubble = this.messagesEl.createDiv('cs-msg cs-msg--user');
      bubble.createDiv({ cls: 'cs-msg-body', text: stripFileBlocks(msg.content) });
      this.addMessageActions(bubble, msg);
      return;
    }

    const bubble = this.messagesEl.createDiv('cs-msg cs-msg--assistant');
    const bodyEl = bubble.createDiv('cs-msg-body');
    const comp = new Component();
    comp.load();
    this.renderComponents.push(comp);
    void MarkdownRenderer.render(this.app, neutralizeExecutableFences(msg.content), bodyEl, '', comp);
    this.addMessageActions(bubble, msg);
  }

  private cleanupRenderComponents() {
    for (const comp of this.renderComponents) {
      comp.unload();
    }
    this.renderComponents = [];
  }

  private async persistSession() {
    if (!this.currentSession) return;
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

    const top = this.historyEl.createDiv('cs-history-top');
    const newBtn = top.createEl('button', { cls: 'cs-new-chat-btn', text: '+ new chat' });
    newBtn.addEventListener('click', () => this.startNewSession());
    const importBtn = top.createEl('button', {
      cls: 'cs-history-import-btn',
      text: 'Import',
      attr: { title: 'Import a vaultchat Markdown export' },
    });
    importBtn.addEventListener('click', () => {
      new ImportChatModal(this.app, file => { void this.importSession(file); }).open();
    });

    const sort = top.createEl('select', {
      cls: 'cs-history-sort',
      attr: { title: 'Sort chat history', 'aria-label': 'Sort chat history' },
    });
    for (const [value, label] of [
      ['recent', 'Recent'],
      ['oldest', 'Oldest'],
      ['title', 'Title'],
    ] as const) {
      sort.createEl('option', { value, text: label });
    }
    sort.value = this.historySort;
    sort.addEventListener('change', () => {
      if (sort.value === 'oldest' || sort.value === 'title') this.historySort = sort.value;
      else this.historySort = 'recent';
      void this.renderHistory();
    });

    const search = this.historyEl.createEl('input', {
      cls: 'cs-history-search',
      attr: { type: 'search', placeholder: 'Search chats…' },
    });
    search.value = this.historyFilter;
    search.addEventListener('input', () => {
      this.historyFilter = search.value;
      void this.renderHistory().then(() => {
        // Re-rendering replaces the input, so focus and caret are restored.
        const next = this.historyEl.querySelector('.cs-history-search');
        if (next instanceof HTMLInputElement) {
          next.focus();
          next.setSelectionRange(next.value.length, next.value.length);
        }
      });
    });

    const all = await this.plugin.loadAllSessions();
    const needle = this.historyFilter.trim().toLowerCase();
    // Titles and message text both, so a chat is findable by what was said in
    // it and not only by the first line the title was cut from.
    const filtered = needle === '' ? all : all.filter(session =>
      session.title.toLowerCase().includes(needle)
      || session.messages.some(m => m.content.toLowerCase().includes(needle)));
    const sessions = [...filtered].sort((a, b) => {
      if (this.historySort === 'title') {
        return (a.title || 'Untitled chat').localeCompare(b.title || 'Untitled chat')
          || b.updatedAt - a.updatedAt;
      }
      return this.historySort === 'oldest'
        ? a.updatedAt - b.updatedAt
        : b.updatedAt - a.updatedAt;
    });

    if (sessions.length === 0) {
      this.historyEl.createDiv({
        cls: 'cs-history-empty',
        text: needle === '' ? 'No chat history yet.' : `Nothing matches "${this.historyFilter}".`,
      });
      return;
    }

    const now = Date.now();
    const day = 86_400_000;
    const groups: { label: string; items: ChatSession[] }[] = [
      { label: 'Pinned',      items: [] },
      { label: 'Today',       items: [] },
      { label: 'Yesterday',   items: [] },
      { label: 'Last 7 days', items: [] },
      { label: 'Older',       items: [] },
      { label: 'Archived',    items: [] },
    ];
    for (const s of sessions) {
      if (s.archived) { groups[5].items.push(s); continue; }
      if (s.pinned) { groups[0].items.push(s); continue; }
      const age = now - s.updatedAt;
      if      (age < day)       groups[1].items.push(s);
      else if (age < 2 * day)   groups[2].items.push(s);
      else if (age < 7 * day)   groups[3].items.push(s);
      else                      groups[4].items.push(s);
    }

    for (const group of groups) {
      if (group.items.length === 0) continue;
      this.historyEl.createDiv({ cls: 'cs-history-group-label', text: group.label });
      for (const session of group.items) this.renderSessionRow(session);
    }
  }

  private async importSession(file: TFile): Promise<void> {
    try {
      const imported = parseConversationMarkdown(
        await this.app.vault.read(file), generateId,
      );
      if (!imported) {
        new Notice('Vaultchat: that note is not a vaultchat Markdown export.');
        return;
      }
      const endpoint = this.activeEndpoint();
      const now = Date.now();
      const session: ChatSession = {
        version: 2,
        id: generateId(),
        createdAt: now,
        updatedAt: now,
        title: imported.title,
        provider: this.plugin.settings.activeProvider,
        model: this.currentModel(),
        endpointId: endpoint?.id ?? null,
        attachedFiles: [],
        contextSources: [],
        systemPrompt: this.plugin.settings.systemPrompt,
        maxTokens: this.plugin.settings.maxTokens,
        messages: imported.messages,
        activeLeafId: imported.messages.at(-1)?.id ?? null,
      };
      await this.plugin.saveSession(session);
      this.loadSession(session);
      new Notice(`Imported "${session.title}".`);
    } catch (error) {
      new Notice(`Vaultchat: could not import that note: ${(error as Error).message}`);
    }
  }

  private renderSessionRow(session: ChatSession): void {
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

    const actions = item.createDiv('cs-session-actions');
    const act = (text: string, title: string, fn: () => void) => {
      const b = actions.createEl('button', { cls: 'cs-session-act', text, attr: { title } });
      b.addEventListener('click', e => { e.stopPropagation(); fn(); });
      return b;
    };

    act(session.pinned ? '★' : '☆', session.pinned ? 'Unpin' : 'Pin', () => {
      void (async () => {
        await this.plugin.saveSession({ ...session, pinned: !session.pinned });
        await this.renderHistory();
      })();
    });

    act(session.archived ? '↥' : '⌁', session.archived ? 'Unarchive' : 'Archive', () => {
      void (async () => {
        await this.plugin.saveSession({
          ...session,
          archived: !session.archived,
          // An archived chat is not also pinned. Unarchiving leaves it in the
          // normal date groups until the user explicitly pins it again.
          pinned: false,
        });
        await this.renderHistory();
      })();
    });

    act('✎', 'Rename', () => {
      new SessionRenameModal(this.app, session.title, async title => {
        await this.plugin.saveSession({ ...session, title });
        if (this.currentSession?.id === session.id) this.currentSession.title = title;
        await this.renderHistory();
      }).open();
    });

    act('⧉', 'Duplicate', () => {
      void (async () => {
        // A new id and creation time, so the copy is a chat in its own right
        // rather than a second view of the same one.
        const copy: ChatSession = {
          ...session,
          id: generateId(),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          title: `${session.title || 'Untitled chat'} copy`,
          pinned: false,
          archived: false,
          messages: session.messages.map(m => ({ ...m })),
        };
        await this.plugin.saveSession(copy);
        await this.renderHistory();
      })();
    });

    act('↓', 'Export as Markdown', () => {
      void this.exportSession(session);
    });

    act('×', 'Delete', () => {
      void (async () => {
        await this.plugin.deleteSession(session.id);
        if (this.currentSession?.id === session.id) this.startNewSession();
        await this.renderHistory();
      })();
    });

    item.addEventListener('click', () => { this.loadSession(session); });
  }

  /** Writes the visible branch to a note in the vault (§29). */
  private async exportSession(session: ChatSession): Promise<void> {
    const safeName = (session.title || 'Untitled chat')
      .replace(/[\\/:*?"<>|#^[\]]/g, '-')
      .slice(0, 80)
      .trim() || 'Untitled chat';
    const path = normalizePath(`${safeName}.md`);
    try {
      const existing = this.app.vault.getAbstractFileByPath(path);
      const target = existing ? normalizePath(`${safeName} ${Date.now()}.md`) : path;
      await this.app.vault.create(target, conversationToMarkdown(session));
      new Notice(`Exported to ${target}`);
    } catch (e) {
      new Notice(`Could not export: ${(e as Error).message}`);
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

  private addMessageActions(bubble: HTMLElement, msg: Message) {
    const actions = bubble.createDiv('cs-msg-actions');
    this.renderBranchNav(actions, msg);

    // What goes on the clipboard is the message text, never the rendered HTML:
    // the user gets back the Markdown the model wrote, not Obsidian's DOM.
    const copyText = msg.role === 'user' ? stripFileBlocks(msg.content) : msg.content;
    const copyBtn = actions.createEl('button', { cls: 'cs-action-btn', text: 'Copy' });
    copyBtn.addEventListener('click', () => {
      void navigator.clipboard.writeText(copyText).then(() => {
        copyBtn.textContent = '✓ copied';
        window.setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      });
    });

    if (msg.role === 'user') {
      actions.createEl('button', { cls: 'cs-action-btn', text: 'Edit' })
        .addEventListener('click', () => { this.beginEdit(bubble, msg); });
      actions.createEl('button', { cls: 'cs-action-btn', text: 'Resend' })
        .addEventListener('click', () => { this.resendEdited(msg, stripFileBlocks(msg.content)); });
    } else {
      actions.createEl('button', { cls: 'cs-action-btn', text: 'Regenerate' })
        .addEventListener('click', () => { this.regenerate(msg); });
      actions.createEl('button', { cls: 'cs-action-btn', text: 'Insert' })
        .addEventListener('click', () => { void this.insertIntoNote(msg.content); });
    }

    actions.createEl('button', { cls: 'cs-action-btn', text: 'Branch' })
      .addEventListener('click', () => { this.branchFromMessage(msg); });

    const delBtn = actions.createEl('button', { cls: 'cs-action-btn', text: 'Delete' });
    delBtn.addEventListener('click', () => { this.confirmDelete(delBtn, msg); });

    if (msg.role !== 'assistant') return;

    // Render edit actions if the response contains edit blocks
    const editBlocks = parseEditBlocks(msg.content);
    if (editBlocks.length > 0) {
      this.editActions.renderEdits(bubble, editBlocks);
    }

    // Render delete actions if the response contains delete blocks
    const deleteBlocks = parseDeleteBlocks(msg.content);
    if (deleteBlocks.length > 0) {
      this.editActions.renderDeletes(bubble, deleteBlocks);
    }
  }

  // ── Branching ─────────────────────────────────────────────────────────────

  /** A "2/3" stepper, shown only where an alternative actually exists. */
  private renderBranchNav(actions: HTMLElement, msg: Message) {
    if (!this.currentSession) return;
    const { index, count } = branchPosition(this.currentSession.messages, msg.id);
    if (count < 2) return;

    const sibs = siblingsOf(this.currentSession.messages, msg.id);
    const nav  = actions.createDiv('cs-branch-nav');

    const prev = nav.createEl('button', {
      cls: 'cs-branch-btn', text: '‹', attr: { title: 'Previous version' },
    });
    nav.createSpan({ cls: 'cs-branch-count', text: `${index + 1}/${count}` });
    const next = nav.createEl('button', {
      cls: 'cs-branch-btn', text: '›', attr: { title: 'Next version' },
    });

    prev.disabled = index === 0;
    next.disabled = index === count - 1;
    prev.addEventListener('click', () => { this.showBranch(sibs[index - 1].id); });
    next.addEventListener('click', () => { this.showBranch(sibs[index + 1].id); });
  }

  private showBranch(id: string) {
    if (!this.currentSession) return;
    this.currentSession = switchToBranch(this.currentSession, id);
    this.renderConversation();
    void this.persistSession();
  }

  /** Continues from this message while leaving every later branch intact. */
  private branchFromMessage(msg: Message): void {
    if (this.busy() || !this.currentSession) return;
    this.currentSession.activeLeafId = msg.id;
    this.renderConversation();
    this.inputEl.focus();
    void this.persistSession();
  }

  private busy(): boolean {
    if (this.streaming) {
      new Notice('Wait for the current reply to finish.');
      return true;
    }
    return false;
  }

  /** Turns a user bubble into an editor. Saving branches rather than overwrites. */
  private beginEdit(bubble: HTMLElement, msg: Message) {
    if (this.busy()) return;
    const body = bubble.querySelector('.cs-msg-body');
    if (!(body instanceof HTMLElement)) return;

    const original = stripFileBlocks(msg.content);
    body.empty();
    const ta = body.createEl('textarea', { cls: 'cs-edit-input' });
    ta.value = original;
    ta.rows  = Math.min(12, original.split('\n').length + 1);

    const row = body.createDiv('cs-edit-confirm-row');
    row.createEl('button', { cls: 'cs-action-btn cs-apply-btn', text: 'Save and resend' })
      .addEventListener('click', () => { this.resendEdited(msg, ta.value.trim()); });
    row.createEl('button', { cls: 'cs-action-btn', text: 'Cancel' })
      .addEventListener('click', () => { this.renderConversation(false); });
    ta.focus();
  }

  private resendEdited(msg: Message, text: string) {
    if (this.busy()) return;
    if (!this.currentSession || !text) return;
    const cfg = this.resolveGeneration();
    if (!cfg) return;

    // The original turn's attachments are carried over, so an edited question
    // still sees the notes it was asked about.
    const content = fileBlockPrefix(msg.content) + text;
    const { messages, created } = branchFrom(this.currentSession.messages, msg.id, {
      id: generateId(), role: 'user', content, createdAt: Date.now(), status: 'complete',
    });
    if (!created) return;

    this.currentSession.messages     = messages;
    this.currentSession.activeLeafId = created.id;
    this.renderConversation();
    this.runGeneration(created.id, cfg);
  }

  private regenerate(msg: Message) {
    if (this.busy()) return;
    if (!this.currentSession || !msg.parentId) return;
    const cfg = this.resolveGeneration();
    if (!cfg) return;

    // Rewinding to the parent makes the new reply a sibling of this one, so the
    // answer being replaced stays reachable on its own branch.
    this.currentSession.activeLeafId = msg.parentId;
    this.renderConversation(false);
    this.runGeneration(msg.parentId, cfg);
  }

  /**
   * Deleting a message takes every reply below it, so anything with descendants
   * asks first. The confirmation is the button itself rather than a dialog,
   * which is how vault deletions already confirm in this plugin.
   */
  private confirmDelete(btn: HTMLButtonElement, msg: Message) {
    if (this.busy()) return;
    if (!this.currentSession) return;

    const below = descendantIds(this.currentSession.messages, msg.id).size;
    if (below === 0 || btn.hasClass('cs-confirming')) {
      this.deleteMessage(msg);
      return;
    }

    btn.addClass('cs-confirming');
    btn.textContent = `Delete ${below + 1}?`;
    // Reverts on its own so a half-pressed delete does not stay armed.
    window.setTimeout(() => {
      btn.removeClass('cs-confirming');
      btn.textContent = 'Delete';
    }, 4000);
  }

  private deleteMessage(msg: Message) {
    if (!this.currentSession) return;
    const next = { ...this.currentSession, messages: deleteSubtree(this.currentSession.messages, msg.id) };
    this.currentSession = repairActiveLeaf(next);
    this.renderConversation();
    void this.persistSession();
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  private async send() {
    const text = this.inputEl.value.trim();
    if (!text || this.streaming) return;

    const cfg = this.resolveGeneration();
    if (!cfg) return;
    const id = this.plugin.settings.activeProvider;
    const { endpoint, model } = cfg;

    // Resolve context sources into actual file contents, within the budget.
    const budget   = await this.currentContext();
    const allPaths = budget.included.map(f => f.path);

    // Anything that did not fit is reported rather than silently dropped: the
    // user asked for those notes, so a quietly shorter prompt is a wrong answer
    // waiting to happen (§52).
    if (budget.skipped.length > 0) {
      new Notice(
        `Vaultchat: ${budget.skipped.length} file(s) were not sent \u2014 open the context inspector to see why.`,
      );
    }

    const userContent = renderContextBlocks(budget.included) + text;

    // Create session on first message
    if (!this.currentSession) {
      this.currentSession = {
        version:       2,
        id:            generateId(),
        createdAt:     Date.now(),
        updatedAt:     Date.now(),
        title:         sessionTitle(text),
        provider:      id,
        model,
        endpointId:    endpoint?.id ?? null,
        attachedFiles: [...allPaths],
        contextSources: this.contextSources.map(source => ({ ...source })),
        systemPrompt:   this.plugin.settings.systemPrompt,
        maxTokens:      this.plugin.settings.maxTokens,
        messages:      [],
        activeLeafId:  null,
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

    // The new turn hangs off whatever branch is on screen, so sending from a
    // branch continues that branch rather than the one it was forked from.
    const userMessage: Message = {
      id:        generateId(),
      parentId:  this.currentSession.activeLeafId,
      role:      'user',
      content:   userContent,
      createdAt: Date.now(),
      status:    'complete',
    };
    this.currentSession.messages = appendMessage(this.currentSession.messages, userMessage);
    this.currentSession.activeLeafId = userMessage.id;

    this.appendUserBubble(text);
    this.toolRounds = 0;
    this.runGeneration(userMessage.id, cfg);
  }

  /**
   * Everything one request needs, or null with the reason already shown.
   *
   * Resolved once per generation rather than read from settings mid-stream, so
   * changing provider or model while a reply is arriving cannot retarget the
   * request that is already in flight.
   */
  private resolveGeneration(): GenerationConfig | null {
    const id  = this.plugin.settings.activeProvider;
    const def = PROVIDERS[id];

    if (def.apiKeyRequired && !this.plugin.getApiKey(id)) {
      new Notice(`vaultchat: Add your ${def.name} API key in Settings`);
      return null;
    }

    // The local provider needs a server chosen before anything can be sent.
    // Saying so beats a connection error against a URL the user never picked.
    const endpoint = id === 'local' ? this.activeEndpoint() : null;
    if (id === 'local' && !endpoint) {
      new Notice('Vaultchat: add an OpenAI-compatible endpoint in settings first.');
      return null;
    }

    const vaultInstructions = this.contextSources.some(source => source.kind === 'entire-vault')
      ? `\n\n${AGENT_INSTRUCTIONS}\n\n${this.vaultFileTree}`
      : '';
    return {
      apiKey:   endpoint ? this.plugin.getEndpointApiKey(endpoint.id) : this.plugin.getApiKey(id),
      model:    this.currentModel(),
      endpoint,
      maxTokens: this.currentSession?.maxTokens ?? this.plugin.settings.maxTokens,
      systemPrompt: (this.currentSession?.systemPrompt ?? this.plugin.settings.systemPrompt)
        + vaultInstructions
        + '\n\n' + EDIT_INSTRUCTIONS,
    };
  }

  /**
   * Streams one assistant reply as a child of `parentId`.
   *
   * Sending, regenerating and resending an edited message are the same
   * operation with a different parent, so the request, the empty-response
   * handling and the append-on-success live here rather than three times over.
   */
  private runGeneration(parentId: string, cfg: GenerationConfig): void {
    if (!this.currentSession) return;
    const { apiKey, model, endpoint, systemPrompt, maxTokens } = cfg;
    const wireHistory = toWireMessages(pathToRoot(this.currentSession.messages, parentId));

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
      { ...this.plugin.settings, maxTokens },
      apiKey,
      wireHistory,
      systemPrompt,
      {
        onChunk: chunk => {
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
        onDone: summary => {
          thinkingEl?.remove();
          thinkingEl = null;
          this.cancelStream = null;
          this.streaming = false;
          this.stopBtn.addClass('cs-hidden');
          this.sendBtn.removeClass('cs-hidden');
          this.sendBtn.disabled = false;
          if (!acc) {
            // A 200 that carries no visible content. Why matters: a token limit,
            // a filter and a dead route all look identical here, and only one of
            // them is fixed by picking another model.
            const why = diagnoseEmptyResponse(model, summary, this.stoppedByUser);
            bodyEl.addClass('cs-msg-error');
            bodyEl.setText(`\u26a0 ${why.message}`);
            if (why.kind === 'reasoning-only') {
              // The chain of thought is all the model produced, so showing it
              // beats discarding it and reporting nothing.
              bodyEl.removeClass('cs-msg-error');
              bodyEl.createDiv({ cls: 'cs-reasoning-only', text: why.reasoning });
            }
            return;
          }
          if (this.currentSession) {
            const reply: Message = {
              id:        generateId(),
              parentId,
              role:      'assistant',
              content:   acc,
              createdAt: Date.now(),
              status:    'complete',
              ...(model ? { model } : {}),
              ...(endpoint ? { endpointId: endpoint.id } : {}),
            };
            this.currentSession.messages = appendMessage(this.currentSession.messages, reply);
            this.currentSession.activeLeafId = reply.id;
            // Dispatch from the parsed calls rather than a separate detector.
            // The renderer uses this same parser, so a call visible as a tool
            // request can never be left as inert assistant text.
            if (parseToolCalls(acc, i => `${reply.id}-detect-${i}`).length > 0) {
              void this.runTools(reply.id, cfg);
              return;
            }
          }
          // Re-rendered from the tree rather than decorated in place, so branch
          // counters and actions always describe what is actually stored.
          this.renderConversation();
          void this.persistSession();
        },
        onError: err => {
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
        onReasoning: () => {
          // Reasoning tokens are arriving. Show that the model is working rather
          // than leaving an empty bubble; the chain of thought itself is not shown.
          if (!thinkingEl && !acc) {
            thinkingEl = bubble.createDiv('cs-thinking');
            thinkingEl.textContent = 'Thinking…';
            this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
          }
        },
      },
      endpoint,
    );

    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  /**
   * Runs the tools a reply asked for, then lets the model continue with the
   * results.
   *
   * Results are appended as a user-role turn rather than a dedicated tool role,
   * because the local servers this plugin targets do not all implement one, and
   * a protocol only some providers support is not a protocol.
   */
  private async runTools(parentId: string, cfg: GenerationConfig): Promise<void> {
    if (!this.currentSession) return;

    const session = this.currentSession;
    const reply = session.messages.find(m => m.id === parentId);
    if (!reply) return;

    // A model that keeps calling tools without answering would otherwise loop
    // until the user force-quits, so the budget is per user turn, not per call.
    if (this.toolRounds >= MAX_TOOL_ROUNDS) {
      this.appendToolTurn(parentId,
        `<tool_results>\nStopped: ${MAX_TOOL_ROUNDS} rounds of tool calls without an answer. `
        + `Answer with what you already have, or tell the user what you still need.\n</tool_results>`);
      this.renderConversation();
      void this.persistSession();
      return;
    }
    this.toolRounds++;

    const calls = parseToolCalls(reply.content, i => `${reply.id}-t${i}`);
    if (calls.length === 0) { this.renderConversation(); return; }

    const status = this.messagesEl.createDiv('cs-tool-status');
    status.setText(`Running ${calls.length} tool${calls.length === 1 ? '' : 's'}\u2026`);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;

    // Sequential: a later call routinely depends on an earlier one's result,
    // and reads are cheap enough that parallelism buys nothing here.
    const results: ToolResult[] = [];
    const writes: VaultOperation[] = [];

    try {
      for (const call of calls) {
        if (!this.contextSources.some(source => source.kind === 'entire-vault')) {
          results.push({
            ok: false,
            id: call.id,
            tool: call.tool,
            error: {
              kind: 'failed',
              message: 'Entire vault access is disabled for this chat. Ask the user to enable it first.',
            },
          });
          continue;
        }
        // Writes never execute inline. They are collected into one plan so the
        // user reviews the whole change at once rather than approving it a
        // notice at a time (§24).
        const checked = validateCall(call, normalizePath);
        if (checked.ok) {
          const ops = operationsFromCall(call.tool, checked.args);
          if (ops !== null) {
            writes.push(...ops);
            results.push({ ok: true, id: call.id, tool: call.tool,
              data: { queued: true, note: 'Queued for the user to review. Do not assume it has been applied.' } });
            continue;
          }
        }
        results.push(await this.tools.execute(call));
      }
      status.remove();

      this.appendToolTurn(parentId, formatToolResults(results));
      this.renderConversation();

      if (writes.length > 0) {
        const request = pathToRoot(session.messages, reply.id)
          .reverse()
          .find(message => message.role === 'user' && message.metadata?.toolResults !== true);
        this.proposePlan(
          pruneNoOps(writes),
          request ? stripFileBlocks(request.content) : 'AI-proposed vault changes',
        );
        void this.persistSession();
        return;
      }

      const next = this.currentSession.activeLeafId;
      if (next) this.runGeneration(next, cfg);
    } catch (error) {
      status.remove();
      const message = error instanceof Error ? error.message : String(error);
      this.appendToolTurn(parentId, `<tool_results>\n[agent] ERROR failed: ${message}\n</tool_results>`);
      this.renderConversation();
      void this.persistSession();
    }
  }

  /** Shows a plan for review. Nothing reaches the vault until it is applied. */
  private proposePlan(operations: VaultOperation[], description: string): void {
    if (operations.length === 0) return;
    const plan: VaultPlan = {
      id:          generateId(),
      createdAt:   Date.now(),
      description: stripFileBlocks(description).slice(0, 200),
      operations,
    };
    new PlanModal(
      this.app, plan, this.planExecutor, this.plugin.settings.protectedPaths,
      runnable => { void this.applyPlan(runnable); },
    ).open();
  }

  private async applyPlan(plan: VaultPlan): Promise<void> {
    const report = await this.planExecutor.execute(plan);

    // A partial run is reported as one, never rounded up to success (§23).
    if (report.failed) {
      new Notice(
        `Stopped after ${report.completed.length} of ${plan.operations.length}: `
        + `${report.failed.error}. ${report.notAttempted.length} not attempted.`,
        10000);
    } else {
      new Notice(`Applied ${report.completed.length} operation(s).`);
    }

    if (report.completed.length === 0) return;

    const entry = {
      id:             generateId(),
      at:             Date.now(),
      description:    plan.description || `${report.completed.length} operation(s)`,
      operationCount: report.completed.length,
      affected:       affectedFiles({ ...plan, operations: report.completed }),
      undo:           report.undo,
      undoable:       report.undoable,
      undoBlockedBy:  report.undoBlockedBy,
    };
    await this.plugin.history.record(entry);

    this.renderPlanReceipt(entry.id, report.completed.length, report.undoable, report.undoBlockedBy);
  }

  /** The applied-changes strip, with Undo only when undo is genuinely possible. */
  private renderPlanReceipt(
    entryId: string,
    count: number,
    undoable: boolean,
    blockedBy: string | null,
  ): void {
    const strip = this.messagesEl.createDiv('cs-plan-receipt');
    strip.createSpan({ text: `\u2713 Applied ${count} operation${count === 1 ? '' : 's'}` });

    if (undoable) {
      const undoBtn = strip.createEl('button', { cls: 'cs-action-btn', text: 'Undo' });
      undoBtn.addEventListener('click', () => {
        undoBtn.disabled = true;
        void (async () => {
          const entries = await this.plugin.history.all();
          const entry = entries.find(e => e.id === entryId);
          if (!entry) { new Notice('That change is no longer in the history.'); return; }
          const result = await this.plugin.planExecutor.undo(entry.undo);
          await this.plugin.history.markUndone(entryId);
          if (result.errors.length > 0) {
            new Notice(`Undid ${result.undone}, but ${result.errors.length} step(s) failed: ${result.errors[0]}`, 10000);
          } else {
            new Notice(`Undid ${result.undone} operation(s).`);
          }
          strip.setText(`\u21a9 Undone (${result.undone})`);
        })();
      });
    } else {
      // §26: never offer an undo the plugin cannot actually perform.
      strip.createSpan({
        cls: 'cs-plan-noundo',
        text: `Cannot be undone \u2014 ${blockedBy ?? 'the original state was not captured'}`,
      });
    }

    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private appendToolTurn(parentId: string, content: string): void {
    if (!this.currentSession) return;
    const turn: Message = {
      id:        generateId(),
      parentId,
      role:      'user',
      content,
      createdAt: Date.now(),
      status:    'complete',
      metadata:  { toolResults: true },
    };
    this.currentSession.messages = appendMessage(this.currentSession.messages, turn);
    this.currentSession.activeLeafId = turn.id;
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
