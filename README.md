# Chatsidian

Multi-provider AI chat inside Obsidian with file reading, editing, creation, and deletion. Supports Anthropic (Claude), OpenAI, Google Gemini, OpenRouter, and Ollama.

> **API keys:** You need a standard API key from each provider you want to use. Claude Code OAuth tokens (`sk-ant-oat01-...`) do not work — Anthropic blocks them from third-party API calls.

---

## Features

- **Multi-provider** — switch between Anthropic, OpenAI, Gemini, OpenRouter, and Ollama from a single dropdown
- **File reading** — attach any vault file to the conversation with the **+** button; the AI sees the full contents
- **File editing** — the AI proposes edits in a diff format; auto-applied with Confirm/Revert, or manual Apply (configurable)
- **File creation** — ask the AI to create new notes in any folder
- **File deletion** — the AI can propose file deletions with a double-confirmation safety prompt
- **Chat history** — persistent sessions stored per-vault, grouped by date, searchable, and resumable
- **Stop button** — cancel any streaming response mid-generation
- **Include current note** — one-click toggle to send your active note as context
- **Streaming** — real-time token streaming from all providers
- **Dynamic model lists** — Ollama shows installed models; OpenRouter fetches all available models

## Providers

| Provider      | API key source        | Notes                           |
| ------------- | --------------------- | ------------------------------- |
| Anthropic     | console.anthropic.com | Uses `x-api-key` header         |
| OpenAI        | platform.openai.com   | Bearer token                    |
| Google Gemini | aistudio.google.com   | OpenAI-compatible endpoint      |
| OpenRouter    | openrouter.ai         | Access 100+ models with one key |
| Ollama        | No key needed         | Runs locally; set your base URL |

## Installation

This plugin is not yet listed in the Obsidian community plugin registry. Install manually.

**Requirements**

- Node.js v18+
- Obsidian 1.0+

**Build from source**

```bash
git clone https://github.com/kpulik/chatsidian
cd chatsidian
npm install
npm run build
```

**Install into your vault**

```bash
mkdir -p /path/to/your/vault/.obsidian/plugins/chatsidian
cp main.js manifest.json styles.css /path/to/your/vault/.obsidian/plugins/chatsidian/
```

Then add `"chatsidian"` to your vault's `.obsidian/community-plugins.json`:

```json
[
  "...other plugins...",
  "chatsidian"
]
```

Restart Obsidian. The plugin will appear in **Settings > Community Plugins**.

## Ollama setup

Ollama lets you run models locally — no API key, no cost, no data leaving your machine.

**1. Install Ollama**

Download from [ollama.com](https://ollama.com) and run the installer. On Mac it runs as a menu bar app that starts automatically.

**2. Pull a model**

Open Terminal and run one of these:

```bash
ollama pull llama3.2        # 2GB, good general purpose
ollama pull llama3.2:1b     # 1GB, fastest/smallest
ollama pull mistral         # 4GB, strong reasoning
ollama pull codellama       # 4GB, code-focused
ollama pull gemma3          # 5GB, Google's open model
ollama pull qwen2.5         # 4GB, strong at multilingual
```

To see what you have installed: `ollama list`

**3. Open Chatsidian**

Select **Ollama** from the provider dropdown. The model list will auto-populate from your installed models. The base URL defaults to `http://localhost:11434` — only change it if you're running Ollama on a different machine.

**Note:** Ollama must be running for the model list to load. If the dropdown shows "Fetch failed", open the Ollama app or run `ollama serve` in Terminal, then hit the refresh button.

---

## Usage

- Click the **bot icon** in the left ribbon to open the chat panel
- Select your **provider** and **model** from the dropdowns in the header
- Use the **+** button to attach vault files as context — the AI reads their full contents
- Check **Include current note** to also send your active note
- Press **Enter** to send, **Cmd+Enter** for a new line
- Click **Stop** to cancel a streaming response at any time
- Hover over any assistant message to see **Copy** and **Insert** buttons
- When the AI proposes file edits, you'll see a diff with **Confirm/Revert** (auto-apply mode) or **Preview/Apply** (manual mode)
- File deletions always require a **double confirmation** before anything is removed
- Click the **clock icon** to open chat history — sessions are grouped by date and show attached files

## Settings

Go to **Settings > Chatsidian** to configure:

- **API keys** for each provider (stored locally, obfuscated after entry)
- **Default model** per provider
- **Custom base URL** per provider (for proxies or self-hosted endpoints)
- **Context window (num_ctx)** for Ollama — controls RAM usage (default 4096 tokens)
- **System prompt** — customize the AI's behavior
- **Max tokens** — maximum response length
- **Auto-apply edits** — toggle between auto-apply (with Confirm/Revert) and manual Apply mode

## Development

```bash
npm run dev   # watch mode, rebuilds on every save
```

For live reloading inside Obsidian, install the [Hot Reload](https://github.com/pjeby/hot-reload) community plugin and symlink the project folder into your vault's plugins directory:

```bash
ln -s /path/to/chatsidian /path/to/vault/.obsidian/plugins/chatsidian
```

Open Obsidian's developer tools with **Cmd+Option+I** to debug.

## License

MIT
