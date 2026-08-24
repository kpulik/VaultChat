import { Notice, PluginSettingTab, Setting } from 'obsidian';
import type { App, Plugin, SettingDefinitionItem, SettingGroupItem } from 'obsidian';
import { PROVIDERS, keySource } from '../providers/catalog';
import { fetchLocalModels, fetchOpenRouterModels } from '../providers/models';
import { secureStore } from '../secrets';
import {
  createEndpoint,
  deleteEndpoint,
  duplicateEndpoint,
  updateEndpoint,
  validateBaseUrl,
} from '../endpoints/manager';
import { DEFAULT_LOCAL_BASE_URL } from '../endpoints/types';
import { generateId } from '../ids';
import { maskToken } from './format';
import {
  allPresets,
  createPreset,
  deletePreset,
  isBuiltin,
  updatePreset,
} from '../settings/presets';
import type { ModelDefinition, ProviderDef, ProviderID } from '../providers/catalog';
import type { OpenAICompatibleEndpoint } from '../endpoints/types';
import type { Preset } from '../settings/presets';
import type { VaultChatHost } from '../host';

export class VaultchatSettingsTab extends PluginSettingTab {
  private plugin: VaultChatHost;

  // Model lists pulled from a provider on demand, so the settings dropdown can
  // show them the same way the chat header does.
  private fetchedModels: Partial<Record<ProviderID, ModelDefinition[]>> = {};

  // Same, per endpoint, keyed by endpoint id.
  private fetchedEndpointModels: Record<string, ModelDefinition[]> = {};

  // Rebuilt in place when endpoints are added or removed, so the rest of the
  // tab is not torn down for a structural change to one section.
  private endpointsEl: HTMLElement | null = null;
  private presetsEl: HTMLElement | null = null;

  constructor(app: App, plugin: Plugin & VaultChatHost) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // display() and getSettingDefinitions() both drive the same row builders below,
  // so the imperative tab an older app renders and the declarative definitions
  // Obsidian 1.13 indexes for search can never describe different settings.
  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    for (const [pid, def] of Object.entries(PROVIDERS) as [ProviderID, ProviderDef][]) {
      // The local provider no longer has one address and one key of its own:
      // it selects from the saved endpoint list, which is rendered instead.
      if (pid === 'local') {
        this.endpointsEl = containerEl.createDiv();
        this.renderEndpoints();
        this.numCtxRow(new Setting(containerEl));
        continue;
      }
      new Setting(containerEl).setName(def.name).setHeading();
      if (def.apiKeyLabel !== null) this.keyRow(new Setting(containerEl), pid, def);
      this.modelRow(new Setting(containerEl), pid, def);
    }

    this.systemPromptRow(new Setting(containerEl));
    this.maxTokensRow(new Setting(containerEl));
    this.autoApplyRow(new Setting(containerEl));

    new Setting(containerEl).setName('Vault access and safety').setHeading();
    this.contextMaxTokensRow(new Setting(containerEl));
    this.dynamicCurrentNoteRow(new Setting(containerEl));
    this.pathListRow(new Setting(containerEl), 'ignored');
    this.pathListRow(new Setting(containerEl), 'protected');

    new Setting(containerEl).setName('Presets').setHeading();
    this.presetsEl = containerEl.createDiv('cs-presets');
    this.renderPresets(this.presetsEl);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const items: SettingDefinitionItem[] = [];

    for (const [pid, def] of Object.entries(PROVIDERS) as [ProviderID, ProviderDef][]) {
      const rows: SettingGroupItem[] = [];

      // Local is a list of saved servers, each with its own URL, key and model,
      // so it has no single key or model row to describe.
      if (pid === 'local') {
        rows.push({
          name: 'OpenAI-compatible endpoints',
          aliases: ['endpoint', 'base url', 'port', 'server', 'ollama', 'lm studio',
                    'open webui', 'vllm', 'localai', 'llama.cpp', 'jan', 'litellm'],
          render: s => {
            this.resetRow(s);
            this.endpointsEl = s.settingEl.createDiv();
            this.renderEndpoints();
          },
        });
        rows.push({
          name: 'Context window (num_ctx)',
          aliases: ['num_ctx', 'context window', 'memory'],
          render: s => { this.numCtxRow(s); },
        });
        items.push({ type: 'group', heading: def.name, items: rows });
        continue;
      }

      if (def.apiKeyLabel !== null) {
        rows.push({
          name: `${def.name} API key`,
          aliases: ['api key', 'token', 'secret', 'credential', def.name],
          render: s => { this.keyRow(s, pid, def); },
        });
      }
      rows.push({
        name: `${def.name} model`,
        aliases: ['model', def.name],
        render: s => { this.modelRow(s, pid, def); },
      });
      items.push({ type: 'group', heading: def.name, items: rows });
    }

    items.push(
      {
        name: 'System prompt',
        aliases: ['prompt', 'instructions', 'persona'],
        render: s => { this.systemPromptRow(s); },
      },
      {
        name: 'Max tokens',
        desc: 'Maximum response length. Leave at 0 to let the model decide. Anthropic requires a value, so 0 sends 4096 there.',
        aliases: ['max tokens', 'response length', 'limit'],
        control: { type: 'number', key: 'maxTokens', min: 0, placeholder: '0' },
      },
      {
        name: 'Auto-apply edits',
        desc: 'When enabled, file edits are applied immediately with confirm/revert buttons. Notes you attach are sent to the model, so a note containing instructions can cause edits you did not ask for. When disabled, you review each edit and click apply.',
        aliases: ['auto apply', 'confirm', 'revert', 'diff'],
        control: { type: 'toggle', key: 'autoApplyEdits' },
      },
      {
        name: 'Context budget',
        desc: 'Maximum estimated tokens read from attached notes and folders. Files that do not fit are reported instead of silently omitted.',
        aliases: ['context', 'vault context', 'context tokens', 'budget'],
        render: s => { this.contextMaxTokensRow(s); },
      },
      {
        name: 'Dynamic current note',
        desc: 'When enabled, a current-note context source follows the active editor note. When disabled, selecting it keeps the note that was selected.',
        aliases: ['current note', 'dynamic context', 'active note'],
        render: s => { this.dynamicCurrentNoteRow(s); },
      },
      {
        name: 'Ignored paths',
        desc: 'One vault folder or path pattern per line. Matching notes stay out of search and context.',
        aliases: ['ignore', 'excluded', 'hidden folders'],
        render: s => { this.pathListRow(s, 'ignored'); },
      },
      {
        name: 'Protected paths',
        desc: 'One vault folder or path pattern per line. Matching paths are refused by destructive plans.',
        aliases: ['protected', 'safe folders', 'destructive operations'],
        render: s => { this.pathListRow(s, 'protected'); },
      },
      {
        name: 'Presets',
        desc: 'Built-in and saved prompts for recurring tasks.',
        aliases: ['saved prompts', 'research', 'summarize', 'organizer'],
        render: s => {
          this.resetRow(s);
          this.presetsEl = s.settingEl.createDiv('cs-presets');
          this.renderPresets(this.presetsEl);
        },
      },
    );

    return items;
  }

  // ── Row builders, shared by both entry points ─────────────────────────────

  // Rows re-render themselves in place. A full display() rebuild is deprecated in
  // 1.13, and update() is 1.13-only, so neither is available while this plugin
  // still supports 1.11.4. Emptying the three elements a Setting exposes and
  // rebuilding is version independent, and cheaper than rebuilding the whole tab.
  private resetRow(s: Setting): void {
    s.nameEl.empty();
    s.descEl.empty();
    s.controlEl.empty();
  }

  private keyRow(s: Setting, pid: ProviderID, def: ProviderDef): void {
    this.resetRow(s);
    if (this.plugin.getApiKey(pid)) { this.renderSavedKey(s, pid, def); return; }
    s.setName(def.apiKeyLabel ?? 'API key')
      .setDesc(def.apiKeyRequired
        ? `Get yours from ${keySource(pid)}`
        : 'Only needed if your server was started with one. Leave blank otherwise.')
      .addText(t => {
        t.inputEl.type = 'password';
        t.setPlaceholder(def.apiKeyPlaceholder).onChange(v => {
          void this.plugin.setApiKey(pid, v.trim()).then(() => {
            if (v.trim()) this.keyRow(s, pid, def);
          });
        });
      });
  }

  private modelRow(s: Setting, pid: ProviderID, def: ProviderDef): void {
    this.resetRow(s);
    const ps = this.plugin.settings.providers[pid];
    const known = this.fetchedModels[pid] ?? def.models;
    s.setName('Model')
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
      s.addExtraButton(b => b
        .setIcon('refresh-cw')
        .setTooltip('Refresh model list')
        .onClick(() => { void this.refreshModels(pid, () => { this.modelRow(s, pid, def); }); }),
      );
    }
  }

  // ── Endpoints ─────────────────────────────────────────────────────────────

  private saveEndpoints(next: OpenAICompatibleEndpoint[]): void {
    this.plugin.settings.endpoints = next;
    void this.plugin.saveSettings();
  }

  private renderEndpoints(): void {
    const el = this.endpointsEl;
    if (!el) return;
    el.empty();

    new Setting(el)
      .setName('OpenAI-compatible endpoints')
      .setHeading();

    const list = this.plugin.settings.endpoints;
    if (list.length === 0) {
      el.createDiv({
        cls: 'cs-endpoints-empty',
        text: 'No endpoints yet. Add your Ollama, LM Studio, Open WebUI, vLLM, LocalAI, llama.cpp, Jan or LiteLLM server.',
      });
    }

    for (const endpoint of list) this.endpointBlock(el, endpoint);

    new Setting(el).addButton(b => b
      .setButtonText('Add endpoint')
      .setCta()
      .onClick(() => {
        this.saveEndpoints(
          createEndpoint(this.plugin.settings.endpoints, { baseUrl: DEFAULT_LOCAL_BASE_URL }, generateId()),
        );
        this.renderEndpoints();
      }),
    );
  }

  private endpointBlock(parent: HTMLElement, endpoint: OpenAICompatibleEndpoint): void {
    const block = parent.createDiv('cs-endpoint-block');

    // Name, enable toggle, duplicate and delete.
    new Setting(block)
      .setName(endpoint.name || 'Untitled endpoint')
      .setDesc(endpoint.baseUrl)
      .addToggle(t => t
        .setTooltip('Enabled')
        .setValue(endpoint.enabled)
        .onChange(v => {
          this.saveEndpoints(updateEndpoint(this.plugin.settings.endpoints, endpoint.id, { enabled: v }));
        }),
      )
      .addExtraButton(b => b
        .setIcon('copy')
        .setTooltip('Duplicate')
        .onClick(() => {
          this.saveEndpoints(duplicateEndpoint(this.plugin.settings.endpoints, endpoint.id, generateId()));
          this.renderEndpoints();
        }),
      )
      .addExtraButton(b => b
        .setIcon('trash-2')
        .setTooltip('Delete')
        .onClick(() => {
          this.saveEndpoints(deleteEndpoint(this.plugin.settings.endpoints, endpoint.id));
          // Deleting the selected endpoint must not leave the chat pointing at
          // an id that no longer exists.
          if (this.plugin.settings.activeEndpointId === endpoint.id) {
            this.plugin.settings.activeEndpointId = this.plugin.settings.endpoints[0]?.id ?? null;
            void this.plugin.saveSettings();
          }
          this.renderEndpoints();
        }),
      );

    new Setting(block)
      .setName('Name')
      .addText(t => t
        .setPlaceholder('My server')
        .setValue(endpoint.name)
        .onChange(v => {
          this.saveEndpoints(updateEndpoint(this.plugin.settings.endpoints, endpoint.id, { name: v.trim() }));
        }),
      );

    const urlSetting = new Setting(block)
      .setName('Base URL')
      .setDesc('Address of the server, including the port.');
    urlSetting.addText(t => t
      .setPlaceholder(DEFAULT_LOCAL_BASE_URL)
      .setValue(endpoint.baseUrl)
      .onChange(v => {
        const check = validateBaseUrl(v);
        // A half-typed URL is normal, so an invalid one is reported inline and
        // simply not saved, rather than rejected with a modal on every keystroke.
        urlSetting.setDesc(check.ok
          ? 'Address of the server, including the port.'
          : check.reason);
        if (!check.ok) return;
        this.saveEndpoints(updateEndpoint(this.plugin.settings.endpoints, endpoint.id, { baseUrl: check.url }));
      }),
    );

    this.endpointKeyRow(new Setting(block), endpoint);
    this.endpointModelRow(new Setting(block), endpoint, block);
  }

  private endpointKeyRow(s: Setting, endpoint: OpenAICompatibleEndpoint): void {
    this.resetRow(s);
    const existing = this.plugin.getEndpointApiKey(endpoint.id);
    if (existing) {
      s.setName('API key')
        .setDesc('Key saved to Obsidian secret storage.')
        .addButton(b => b
          .setButtonText('Remove')
          .onClick(() => {
            void this.plugin.setEndpointApiKey(endpoint.id, '').then(() => { this.endpointKeyRow(s, endpoint); });
          }),
        );
      return;
    }
    s.setName('API key')
      .setDesc('Only needed if this server was started with one. Leave blank otherwise.')
      .addText(t => {
        t.inputEl.type = 'password';
        t.setPlaceholder('Leave blank if not required').onChange(v => {
          const key = v.trim();
          if (!key) return;
          void this.plugin.setEndpointApiKey(endpoint.id, key).then(() => { this.endpointKeyRow(s, endpoint); });
        });
      });
  }

  private endpointModelRow(s: Setting, endpoint: OpenAICompatibleEndpoint, block: HTMLElement): void {
    this.resetRow(s);
    const known = this.fetchedEndpointModels[endpoint.id] ?? [];
    s.setName('Model')
      .setDesc('Refresh to read the model list from this server, or type an ID.')
      .addDropdown(dd => {
        for (const m of known) dd.addOption(m.id, m.label);
        if (endpoint.defaultModel && !known.find(m => m.id === endpoint.defaultModel)) {
          dd.addOption(endpoint.defaultModel, endpoint.defaultModel);
        }
        if (known.length === 0 && !endpoint.defaultModel) dd.addOption('', 'Not loaded');
        dd.setValue(endpoint.defaultModel ?? '');
        dd.onChange(v => {
          this.saveEndpoints(updateEndpoint(this.plugin.settings.endpoints, endpoint.id, { defaultModel: v }));
        });
      })
      .addText(t => {
        t.inputEl.addClass('cs-settings-model-input');
        t.setPlaceholder('Or type model ID…').onChange(v => {
          if (!v.trim()) return;
          this.saveEndpoints(updateEndpoint(this.plugin.settings.endpoints, endpoint.id, { defaultModel: v.trim() }));
        });
      })
      .addExtraButton(b => b
        .setIcon('refresh-cw')
        .setTooltip('Test connection and refresh models')
        .onClick(() => { void this.testEndpoint(endpoint, block, () => { this.endpointModelRow(s, endpoint, block); }); }),
      );
  }

  /**
   * Connection test and model refresh are the same request: reading /v1/models
   * is exactly what proves the server is reachable and speaking the right API,
   * so reporting "connected" without having read something back would be a
   * guess rather than a test.
   */
  private async testEndpoint(
    endpoint: OpenAICompatibleEndpoint,
    block: HTMLElement,
    rerender: () => void,
  ): Promise<void> {
    const status = block.querySelector('.cs-endpoint-status')
      ?? block.createDiv('cs-endpoint-status');
    status.setText('Testing…');
    status.removeClass('cs-edit-error', 'cs-edit-success');

    const check = validateBaseUrl(endpoint.baseUrl);
    if (!check.ok) {
      status.setText(check.reason);
      status.addClass('cs-edit-error');
      return;
    }

    try {
      const models = await fetchLocalModels(check.url, this.plugin.getEndpointApiKey(endpoint.id));
      if (models.length === 0) {
        status.setText('Connected, but the server listed no models.');
        status.addClass('cs-edit-error');
        return;
      }
      this.fetchedEndpointModels[endpoint.id] = models;
      if (!endpoint.defaultModel) {
        this.saveEndpoints(
          updateEndpoint(this.plugin.settings.endpoints, endpoint.id, { defaultModel: models[0].id }),
        );
      }
      status.setText(`Connected. ${models.length} model${models.length === 1 ? '' : 's'} available.`);
      status.addClass('cs-edit-success');
      rerender();
    } catch (e) {
      status.setText(`Could not reach the server: ${(e as Error).message}`);
      status.addClass('cs-edit-error');
    }
  }

  private numCtxRow(s: Setting): void {
    s.setName('Context window (num_ctx)')
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

  private systemPromptRow(s: Setting): void {
    s.setName('System prompt')
      .addTextArea(ta => {
        ta.setValue(this.plugin.settings.systemPrompt)
          .onChange(v => { this.plugin.settings.systemPrompt = v; void this.plugin.saveSettings(); });
        ta.inputEl.rows = 5;
        ta.inputEl.addClass('cs-settings-textarea');
      });
  }

  private maxTokensRow(s: Setting): void {
    s.setName('Max tokens')
      .setDesc('Maximum response length. Leave at 0 to let the model decide. Anthropic requires a value, so 0 sends 4096 there.')
      .addText(t => t
        .setPlaceholder('0')
        .setValue(String(this.plugin.settings.maxTokens))
        .onChange(v => {
          const n = v.trim() === '' ? 0 : parseInt(v);
          if (!isNaN(n) && n >= 0) { this.plugin.settings.maxTokens = n; void this.plugin.saveSettings(); }
        }),
      );
  }

  private autoApplyRow(s: Setting): void {
    s.setName('Auto-apply edits')
      .setDesc('When enabled, file edits are applied immediately with confirm/revert buttons. Notes you attach are sent to the model, so a note containing instructions can cause edits you did not ask for. When disabled, you review each edit and click apply.')
      .addToggle(t => t
        .setValue(this.plugin.settings.autoApplyEdits)
        .onChange(v => { this.plugin.settings.autoApplyEdits = v; void this.plugin.saveSettings(); }),
      );
  }

  private contextMaxTokensRow(s: Setting): void {
    this.resetRow(s);
    s.setName('Context budget')
      .setDesc('Maximum estimated tokens read from attached notes and folders. Files that do not fit are reported instead of silently omitted.')
      .addText(t => t
        .setPlaceholder('30000')
        .setValue(String(this.plugin.settings.contextMaxTokens))
        .onChange(v => {
          const n = v.trim() === '' ? 0 : parseInt(v, 10);
          if (Number.isFinite(n) && n >= 0) {
            this.plugin.settings.contextMaxTokens = n;
            void this.plugin.saveSettings();
          }
        }),
      );
  }

  private dynamicCurrentNoteRow(s: Setting): void {
    this.resetRow(s);
    s.setName('Dynamic current note')
      .setDesc('When enabled, a current-note context source follows the active editor note. When disabled, it stays on the note selected when the source was added.')
      .addToggle(t => t
        .setValue(this.plugin.settings.dynamicCurrentNote)
        .onChange(value => {
          this.plugin.settings.dynamicCurrentNote = value;
          void this.plugin.saveSettings();
        }),
      );
  }

  private pathListRow(s: Setting, kind: 'ignored' | 'protected'): void {
    this.resetRow(s);
    const protectedList = kind === 'protected';
    const paths = protectedList
      ? this.plugin.settings.protectedPaths
      : this.plugin.settings.ignoredPaths;
    s.setName(protectedList ? 'Protected paths' : 'Ignored paths')
      .setDesc(protectedList
        ? 'One path pattern per line. Destructive plans refuse these paths; the vault configuration folder is always protected.'
        : 'One path pattern per line. Matching notes stay out of search and context.')
      .addTextArea(ta => {
        ta.setValue(paths.join('\n'));
        ta.inputEl.rows = 4;
        ta.inputEl.addClass('cs-settings-textarea');
        ta.onChange(value => {
          const next = [...new Set(value.split(/\r?\n/)
            .map(path => path.trim())
            .filter(Boolean))];
          if (protectedList) this.plugin.settings.protectedPaths = next;
          else {
            this.plugin.settings.ignoredPaths = next;
            // Existing entries were filtered when they were indexed. Rebuild
            // now so an ignored-path edit takes effect without a file event.
            this.plugin.index.rebuild();
          }
          void this.plugin.saveSettings();
        });
      });
  }

  private savePresets(next: Preset[]): void {
    this.plugin.settings.presets = next;
    void this.plugin.saveSettings();
  }

  private patchPreset(id: string, patch: Partial<Preset>): void {
    if (isBuiltin(id)) return;
    this.savePresets(updatePreset(this.plugin.settings.presets, id, patch));
  }

  private duplicatePreset(preset: Preset): void {
    const copy = createPreset(this.plugin.settings.presets, {
      ...preset,
      name: `${preset.name} copy`,
    }, generateId());
    this.savePresets(copy);
    this.renderPresets(this.presetsEl);
  }

  private renderPresets(parent: HTMLElement | null): void {
    if (!parent) return;
    parent.empty();
    parent.createDiv({
      cls: 'cs-settings-note',
      text: 'Built-ins are read-only. Duplicate one to make an editable copy.',
    });

    for (const preset of allPresets(this.plugin.settings.presets)) {
      this.presetBlock(parent, preset);
    }

    new Setting(parent).addButton(b => b
      .setButtonText('Add preset')
      .setCta()
      .onClick(() => {
        this.savePresets(createPreset(this.plugin.settings.presets, {
          name: 'New preset',
          systemPrompt: '',
        }, generateId()));
        this.renderPresets(parent);
      }),
    );
  }

  private presetBlock(parent: HTMLElement, preset: Preset): void {
    const builtIn = isBuiltin(preset.id);
    const block = parent.createDiv('cs-preset-block');
    const header = new Setting(block)
      .setName(preset.name)
      .setDesc(builtIn ? 'Built-in preset' : 'Saved preset');

    if (builtIn) {
      header.addButton(b => b
        .setButtonText('Duplicate')
        .onClick(() => { this.duplicatePreset(preset); }),
      );
      return;
    }

    header.addButton(b => b
      .setButtonText('Delete')
      .onClick(() => {
        this.savePresets(deletePreset(this.plugin.settings.presets, preset.id));
        if (this.plugin.settings.activePresetId === preset.id) {
          this.plugin.settings.activePresetId = null;
          void this.plugin.saveSettings();
        }
        this.renderPresets(parent);
      }),
    );

    new Setting(block).setName('Name').addText(t => t
      .setValue(preset.name)
      .onChange(value => {
        this.patchPreset(preset.id, { name: value.trim() || 'New preset' });
      }),
    );

    new Setting(block).setName('System prompt').addTextArea(ta => {
      ta.setValue(preset.systemPrompt ?? '');
      ta.inputEl.rows = 4;
      ta.inputEl.addClass('cs-settings-textarea');
      ta.onChange(value => { this.patchPreset(preset.id, { systemPrompt: value }); });
    });

    new Setting(block).setName('Provider').addDropdown(dd => {
      dd.addOption('', 'Use chat provider');
      for (const [id, def] of Object.entries(PROVIDERS)) dd.addOption(id, def.name);
      dd.setValue(preset.provider ?? '');
      dd.onChange(value => {
        this.patchPreset(preset.id, value
          ? { provider: value as ProviderID }
          : { provider: undefined, endpointId: undefined });
      });
    });

    new Setting(block).setName('Endpoint').addDropdown(dd => {
      dd.addOption('', 'Use chat endpoint');
      for (const endpoint of this.plugin.settings.endpoints) {
        dd.addOption(endpoint.id, endpoint.name || endpoint.baseUrl);
      }
      dd.setValue(preset.endpointId ?? '');
      dd.onChange(value => {
        this.patchPreset(preset.id, { endpointId: value || undefined });
      });
    });

    new Setting(block).setName('Model').addText(t => t
      .setPlaceholder('Use chat model')
      .setValue(preset.model ?? '')
      .onChange(value => { this.patchPreset(preset.id, { model: value.trim() || undefined }); }),
    );

    new Setting(block).setName('Max tokens').addText(t => t
      .setPlaceholder('Use chat setting')
      .setValue(preset.maxTokens === undefined ? '' : String(preset.maxTokens))
      .onChange(value => {
        const raw = value.trim();
        if (raw === '') { this.patchPreset(preset.id, { maxTokens: undefined }); return; }
        const n = parseInt(raw, 10);
        if (Number.isFinite(n) && n >= 0) this.patchPreset(preset.id, { maxTokens: n });
      }),
    );

    new Setting(block).setName('Include current note').addToggle(t => t
      .setValue(preset.includeCurrentNote === true)
      .onChange(value => { this.patchPreset(preset.id, { includeCurrentNote: value }); }),
    );
  }

  private renderSavedKey(s: Setting, pid: ProviderID, def: ProviderDef) {
    const label = def.apiKeyLabel ?? 'API key';
    const key = this.plugin.getApiKey(pid);
    let revealed = false;
    const secure = secureStore(this.app) !== null;
    s.setName(label)
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
      .addEventListener('click', () => { void this.plugin.setApiKey(pid, '').then(() => { this.keyRow(s, pid, def); }); });
    row.createEl('button', { cls: 'cs-tok-btn cs-tok-btn--danger', text: 'Remove' })
      .addEventListener('click', () => { void this.plugin.setApiKey(pid, '').then(() => { this.keyRow(s, pid, def); }); });
  }

  // Only the hosted providers reach this now; each saved endpoint refreshes its
  // own model list through testEndpoint.
  private async refreshModels(pid: ProviderID, rerender: () => void): Promise<void> {
    const ps = this.plugin.settings.providers[pid];
    try {
      const models = await fetchOpenRouterModels(this.plugin.getApiKey(pid));
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
      rerender();
    } catch {
      new Notice('Could not load models. Check the base URL and key.');
    }
  }
}
