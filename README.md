# VaultChat

Multi-provider AI chat inside Obsidian with file reading, editing, creation, and deletion. Supports Anthropic (Claude), OpenAI, Google Gemini, OpenRouter, and any local OpenAI-compatible server such as Ollama or LM Studio.

> **API keys:** You need a standard API key from each provider you want to use. Claude Code OAuth tokens (`sk-ant-oat01-...`) do not work. Anthropic blocks them from third-party API calls.

---

## Features

- **Multi-provider** - switch between Anthropic, OpenAI, Gemini, OpenRouter, and local models from a single dropdown
- **File reading** - attach any vault file to the conversation with the **+** button; the AI sees the full contents
- **File editing** - the AI proposes edits in a diff format; review each one with Preview/Apply, or turn on auto-apply (with Confirm/Revert) from the chat footer or settings
- **Path safety** - edit and delete blocks that point outside the vault are refused
- **File creation** - ask the AI to create new notes in any folder
- **File deletion** - the AI can propose file deletions with a double-confirmation safety prompt
- **Vault awareness** - the AI sees your full file tree so it uses correct paths
- **Chat history** - persistent sessions stored per-vault, grouped by date, searchable, and resumable
- **Stop button** - cancel any streaming response mid-generation
- **Include current note** - one-click toggle to send your active note as context
- **Streaming** - real-time token streaming from all providers
- **Dynamic model lists** - local servers report their loaded models; OpenRouter fetches all available models. Refresh from the chat header or from settings

## Providers

| Provider      | API key source        | Notes                           |
| ------------- | --------------------- | ------------------------------- |
| Anthropic     | console.anthropic.com | Uses `x-api-key` header         |
| OpenAI        | platform.openai.com   | Bearer token                    |
| Google Gemini | aistudio.google.com   | OpenAI-compatible endpoint      |
| OpenRouter    | openrouter.ai         | Access 100+ models with one key |
| Local         | No key needed         | Any OpenAI-compatible server; set your base URL |

## Installation

**From Obsidian (recommended)**

1. Open **Settings > Community Plugins**
2. Click **Browse** and search for **VaultChat**
3. Click **Install**, then **Enable**

**Build from source**

If you prefer to install manually or want to contribute:

```bash
git clone https://github.com/kpulik/VaultChat
cd VaultChat
npm install
npm run build
```

Then copy the built files into your vault:

```bash
mkdir -p /path/to/your/vault/.obsidian/plugins/VaultChat
cp main.js manifest.json styles.css /path/to/your/vault/.obsidian/plugins/VaultChat/
```

Restart Obsidian. The plugin will appear in **Settings > Community Plugins**.

## Local model setup

The **Local (OpenAI-compatible)** provider works with any server that exposes the OpenAI chat-completions API. No API key, no cost, no data leaving your machine. Tested with Ollama and LM Studio; llama.cpp, vLLM, LocalAI, and Jan expose the same API and should work too.

**1. Install a server**

| Server | Where | Default base URL |
| ------ | ----- | ---------------- |
| Ollama | [ollama.com](https://ollama.com) | `http://localhost:11434` |
| LM Studio | [lmstudio.ai](https://lmstudio.ai) | `http://localhost:1234` |

**2. Get a model**

With Ollama, pull one from the terminal:

```bash
ollama pull llama3.2        # 2GB, good general purpose
ollama pull llama3.2:1b     # 1GB, fastest and smallest
ollama pull mistral         # 4GB, strong reasoning
ollama pull qwen2.5         # 4GB, strong at multilingual
```

With LM Studio, download a model from its in-app browser and start the local server from the **Developer** tab.

**3. Open VaultChat**

Select **Local (OpenAI-compatible)** from the provider dropdown and set the base URL to match your server. The model list populates from the server's `/v1/models` endpoint, so it shows whatever that server has available.

If your server needs an API key (vLLM started with `--api-key`, a LiteLLM proxy, and similar), put it in the **API key** field for this provider. Leave it blank when the server does not use one.

**Note:** the server must be running for the model list to load. If the dropdown shows "Fetch failed", start the server, confirm the base URL and port, then hit the refresh button.

**Use `127.0.0.1` rather than `localhost`.** Most local servers listen on IPv4 only, while `localhost` can resolve to IPv6 first and fail with a connection-refused error. VaultChat now substitutes the address automatically, but typing it directly avoids the whole class of problem.

Upgrading from an older version: your Ollama base URL and model carry over automatically.

### Reasoning models

Reasoning models stream their chain of thought separately from their answer. VaultChat shows a "Thinking…" indicator while that is happening and then renders the answer when it arrives. The chain of thought is not added to the transcript.

### Empty responses

If a model or router accepts the request but sends nothing back, VaultChat says so rather than leaving a blank message. This usually means the route you picked has no working upstream, so try a different model.

---

## Usage

- Click the **bot icon** in the left ribbon to open the chat panel
- Select your **provider** and **model** from the dropdowns in the header
- Use the **+** button to attach vault files as context. The AI reads their full contents
- Check **Include current note** to also send your active note
- Press **Enter** to send, **Cmd+Enter** for a new line
- Click **Stop** to cancel a streaming response at any time
- Hover over any assistant message to see **Copy** and **Insert** buttons
- When the AI proposes file edits, you'll see a diff with **Confirm/Revert** (auto-apply mode) or **Preview/Apply** (manual mode)
- File deletions always require a **double confirmation** before anything is removed
- Click the **menu icon** in the header to open chat history. Sessions are grouped by date and show attached files

## Settings

Go to **Settings > VaultChat** to configure:

- **API keys** for each provider (stored locally, obfuscated after entry). The key for a local server is optional; leave it blank unless the server was started with one
- **Default model** per provider, with a refresh button for providers that report their own model list
- **Custom base URL** per provider (for proxies or self-hosted endpoints)
- **Context window (num_ctx)** for local servers - controls RAM usage on Ollama. Leave at 0 (the default) to let the server choose; servers that do not support the option ignore it
- **System prompt** - customize the AI's behavior
- **Max tokens** - maximum response length. Leave at 0 (the default) to let the model decide. Anthropic's API requires the field, so 0 sends 4096 there
- **Auto-apply edits** - toggle between auto-apply (with Confirm/Revert) and manual Apply mode. Off by default, and also togglable from the chat footer so you can flip it without leaving the conversation

## Development

```bash
npm run dev   # watch mode, rebuilds on every save
```

For live reloading inside Obsidian, install the [Hot Reload](https://github.com/pjeby/hot-reload) community plugin and symlink the project folder into your vault's plugins directory:

```bash
ln -s /path/to/VaultChat /path/to/vault/.obsidian/plugins/VaultChat
```

Open Obsidian's developer tools with **Cmd+Option+I** to debug.

## License

MIT
