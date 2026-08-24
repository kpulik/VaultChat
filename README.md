# VaultChat

A local-first AI chat for Obsidian that can actually **edit your vault**.

Point it at Ollama, LM Studio, or any OpenAI-compatible server and the model can read your notes, propose edits as a reviewable diff, create new notes, and delete files behind a double confirmation. Nothing leaves your machine unless you choose a hosted provider.

Plenty of Obsidian plugins talk to local models, and a couple of the largest can edit your vault too. Three things are different here:

- **Local is the default**, not a provider you go and configure. A fresh install points at `127.0.0.1` and never asks for a key.
- **Every write stays reviewable.** There is no "accept all future edits" switch to flip, so a proposal can never apply itself.
- **An ambiguous edit is refused, not guessed.** If the text the model wants to replace appears more than once, nothing is written and it is asked for more context.

Hosted providers are supported too and are entirely optional: Anthropic (Claude), OpenAI, Google Gemini, and OpenRouter.

> **Local needs no API key.** Hosted providers each need their own standard key. Claude Code OAuth tokens (`sk-ant-oat01-...`) do not work, and using them in a third-party tool violates Anthropic's terms.

---

## Features

- **Runs fully local** - Ollama, LM Studio, llama.cpp, vLLM, LocalAI, Jan, or anything else speaking the OpenAI API. No key, no cost, no data leaving your machine
- **Multi-provider** - switch between local models, Anthropic, OpenAI, Gemini, and OpenRouter from a single dropdown
- **File reading** - attach any vault file to the conversation with the **+** button; the AI sees the full contents
- **File editing** - the AI proposes edits in a diff format; review each one with Preview/Apply, or turn on auto-apply (with Confirm/Revert) from the chat footer or settings
- **Path safety** - edit and delete blocks that point outside the vault are refused
- **Ambiguous edits refused** - if the text to replace appears more than once, nothing is written
- **No executable code from the model** - Obsidian runs code-block processors registered by other plugins, so a `dataviewjs` fence would execute JavaScript with vault access. Fences that known executors claim are rewritten before rendering; the code stays readable, it just cannot run
- **API keys in Obsidian secret storage** - moved out of the plugin's `data.json`, with existing keys migrated automatically
- **File creation** - ask the AI to create new notes in any folder
- **File deletion** - the AI can propose file deletions with a double-confirmation safety prompt
- **Vault awareness** - the AI sees your full file tree so it uses correct paths
- **Vault index** - aliases, tags, headings, links, embeds and properties read from Obsidian's own metadata cache and kept current incrementally
- **Natural-language note search** - `Search vault` in the command palette ranks notes by name, alias, tag and heading, and shows *why* each one matched
- **Agent tools** - the model can search, read notes and folders, and inspect metadata, links, backlinks and unresolved links, then answer from what it actually read
- **Ambiguity is refused, not guessed** - when a description matches two notes, the agent is handed the candidates and must ask you which you meant
- **Adapts to narrow panes** - the header, controls and context row wrap and reflow when the sidebar is dragged narrow
- **Branching conversations** - edit and resend any question, or regenerate any reply, without losing what was there before. Alternatives get a `2/3` stepper you can page through
- **Message actions** - copy, edit, regenerate, insert into a note, and delete a message with its replies. Copy returns the original Markdown, not the rendered HTML
- **Chat history** - persistent sessions stored per-vault, grouped by date, searchable, and resumable
- **Stop button** - cancel any streaming response mid-generation
- **Composable context** - current note, current folder, and any number of chosen files and folders, all at once. Not a single either/or mode
- **Entire-vault mode** - indexed search and on-demand note reads, with no blind concatenation of the whole vault
- **Context inspector** - a one-line summary of exactly what the chat can see (`3 files · ~8,410 tokens`), clickable for the full list with the reason each file is included
- **Context budget** - large folders are capped rather than silently truncated; anything that did not fit is reported, with why
- **Protected folders** - destructive operations refuse to touch your config folder, `Templates`, or `.trash`. Configurable
- **Reviewable plans** - every change the agent proposes is collected into one plan you preview and approve; deletions need a second, deliberate click
- **Undo** - applied changes are recorded with the information needed to reverse them, and offered as Undo only when that information was actually captured
- **Activity log** - `Show activity and undo changes` lists what VaultChat has changed and what can still be taken back
- **Batch organization** - move, rename or edit many notes in one reviewed plan; batch renames use literal find/replace, never a pattern
- **Duplicate detection** - notes sharing a filename, identical notes, and near-identical notes. Reported for you to consolidate, never deleted automatically
- **Link health** - links pointing at nothing, and notes nothing links to
- **Presets** - Research, Summarize, Obsidian editor and Vault organizer, plus your own. A preset changes only the settings it names
- **Commands** - new chat, ask about / summarize the current note, organize the current folder, and explain, rewrite or turn a selection into a note
- **Chat sidebar** - search across titles and message text, plus pin, archive, rename, duplicate, export and delete
- **Import** - bring a VaultChat Markdown export back into persistent chat history
- **Streaming** - real-time token streaming from all providers
- **Dynamic model lists** - local servers report their loaded models; OpenRouter fetches all available models. Refresh from the chat header or from settings

## Providers

| Provider      | API key source        | Notes                           |
| ------------- | --------------------- | ------------------------------- |
| **Local**     | **None needed**       | **Default.** Any OpenAI-compatible server; saved as named endpoint profiles |
| Anthropic     | console.anthropic.com | Uses `x-api-key` header         |
| OpenAI        | platform.openai.com   | Bearer token                    |
| Google Gemini | aistudio.google.com   | OpenAI-compatible endpoint      |
| OpenRouter    | openrouter.ai         | Access 100+ models with one key |

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

Select **Local (OpenAI-compatible)** from the provider dropdown, then pick the server you want from the endpoint dropdown beside it.

### Endpoint profiles

Local servers are saved as named profiles rather than a single base URL, so you can keep Ollama, LM Studio and a remote proxy configured at once and switch between them from the chat header.

In **Settings → OpenAI-compatible endpoints**, each profile has its own:

- **Name** - defaults to the server the port suggests (`11434` becomes "Ollama", `1234` becomes "LM Studio", and so on)
- **Base URL** - validated as you type; a malformed URL is reported inline and not saved
- **API key** - optional, held in Obsidian's secret storage, never written to `data.json`. Needed for vLLM started with `--api-key`, a LiteLLM proxy, and similar
- **Model** - read from the server's `/v1/models` endpoint
- **Enabled** toggle, plus duplicate and delete

The refresh button next to **Model** doubles as a connection test: it reads `/v1/models` and reports how many models came back, or why the server could not be reached. Nothing claims "connected" without having read a real response.

**Use `127.0.0.1` rather than `localhost`.** Most local servers listen on IPv4 only, while `localhost` can resolve to IPv6 first and fail with a connection-refused error. VaultChat substitutes the address automatically, but typing it directly avoids the whole class of problem.

Upgrading from an older version: your existing local base URL, model and API key are migrated into your first endpoint profile automatically, and the saved key keeps working without being re-entered.

## Context

What the model can see is built from sources that combine, rather than one mode that excludes the others:

| Source | What it sends |
| ------ | ------------- |
| **Entire vault** | Enables indexed search and on-demand reads; it does not send every note automatically |
| **Current note** | The note open in the editor |
| **Current folder** | Every note under the open note's folder, recursively |
| **+ file** | Individual notes, chosen from a searchable picker |
| **+ folder** | Whole folders, chosen from a searchable picker |

Each source becomes a removable chip. Below them, one line says what the chat can actually see:

```
Context: 12 files · ~8,410 tokens · 2 skipped        inspect
```

Counts come from resolving the sources and reading the files, not from counting chips — one folder chip can be forty notes. Click **inspect** for the exact paths, the reason each is included, and its size.

**Entire vault** is a separate capability source. When enabled, the agent can search indexed paths and read only notes relevant to the request. The context inspector states that vault search is enabled, while the file count reports only content actually read into the current prompt.

Current-note context is snapshotted to the note selected when it is added, so changing tabs cannot silently change an existing chat's context. Enable **Dynamic current note** in settings if that source should follow the active editor note instead.

Context is capped at an estimated token budget (30,000 by default). A folder bigger than the budget is **not** quietly trimmed: the files that did not fit are listed in the inspector and a notice says how many, so a short answer is never the result of a prompt you did not know was shortened.

Folders in the **ignored** list stay out of context and search; folders in the **protected** list additionally refuse destructive operations. Both lists are editable in settings, one path pattern per line. Your vault's configuration folder is always protected, under whatever name it actually has.

## Agent tools

The model reaches the vault through tools rather than guessing from a file list. It calls one in a fenced block, gets a structured JSON result back, and may chain several before answering — capped at five rounds per question so it cannot loop.

Read tools available now:

| Tool | What it does |
| ---- | ------------ |
| `search_vault` | Rank notes matching a description, with a reason and confidence for each |
| `find_file` | Resolve one note — or refuse, and hand back the candidates |
| `read_file` | Read a note in full |
| `list_folder` / `read_folder` | List or read a folder, capped so one call cannot fill the context |
| `get_note_metadata` | Aliases, tags, headings, properties, size |
| `get_links` / `get_backlinks` / `get_unresolved_links` | What a note points at, what points at it, and what is broken |

Every path the model sends is normalised and checked before anything runs; one that escapes the vault is refused, and in a batch a single bad path rejects the whole call.

Write and destructive tools do not execute inline. Creating, editing, renaming, moving, copying and deleting are collected into a reviewable plan. Protected paths are removed before the preview, destructive plans require an additional deliberate confirmation, and the plan is offered for undo only when the required before-state was captured. A model-generated tool call can never bypass those application-level checks.

What the agent read is shown under a collapsed **Tool results** block on each turn. Hiding it would make the answers unauditable.

## Commands

| Command | What it does |
| ------- | ------------ |
| Open chat / New chat | Opens or resets the chat pane |
| Add current note to context | Attaches the open note |
| Ask about current note | Seeds a question with the note attached |
| Summarize current note | Seeds a summary prompt |
| Organize current folder | Attaches the folder and asks for a plan |
| Explain / Rewrite selection | Sends the selected text as the question |
| Create note from selection | Proposes a note, filename and folder from a selection |
| Search vault | Ranked natural-language note search |
| Show activity and undo changes | The activity log |

Selection commands only appear when text is actually selected. **None of these send on their own** — each seeds the composer so you can adjust the wording first.

## Presets

A preset bundles a system prompt and, optionally, a provider, endpoint, model and token limit. Four are built in — Research, Summarize, Obsidian editor, Vault organizer — and you can save your own.

A preset changes **only the fields it names**. Picking *Summarize* will not silently move you off the model you chose.

## Plans, confirmation and undo

Tool calls that write never take effect when the model makes them. They are collected into a single **plan**, shown as a preview, and applied only when you say so.

```
Vault changes                          [ DESTRUCTIVE — READ CAREFULLY ]

CREATE FOLDER
  School/Networking

MOVE 5 files
  Old/TCP.md → School/Networking/TCP.md
  Old/IP.md  → School/Networking/IP.md
  …

DELETE
  Old/duplicate.md

6 operations, 7 files · 8 links in 3 other notes will be updated by Obsidian

                                    [ Apply changes ]  [ Cancel ]
```

- **Risk tiers.** Any deletion makes a plan destructive on its own. So does a batch of more than five writes — reviewing thirty moves one notice at a time is not review. A destructive plan takes **two** deliberate clicks, and the second button says exactly what it will do.
- **Protected paths are removed before the preview**, and listed as refused, so what you see is what will actually run.
- **Every deletion is named**, however long the list. The one thing you should never have to expand a summary to discover is what is about to be destroyed.
- **Link consequences are predicted before you decide**, not reported afterwards. Moves go through Obsidian's own link-aware rename, so links follow exactly as they would if you had dragged the file yourself.
- **A failure stops the run** and reports how far it got, what failed, and what was not attempted. A half-applied reorganisation is never rounded up to success.

### Undo

Everything needed to reverse a plan is captured *before* it runs, so a failure halfway cannot leave some steps reversible and others not.

Undo is offered **only** when every completed step is genuinely reversible. If a file's previous contents could not be read, the receipt says so and shows no button, rather than offering an Undo that would quietly do nothing. Deletions go to the system trash, so they remain recoverable through Obsidian even when the plugin's own undo is unavailable.

## Branching

A conversation is a tree rather than a list, so nothing you have already said is overwritten:

- **Edit** a question and choose **Save and resend** - the original wording, and the reply it got, stay on their own branch. Attached notes carry over to the edited version
- **Regenerate** a reply - the new answer becomes an alternative alongside the old one
- Where alternatives exist, a **`2/3` stepper** appears on the message; paging through it switches the whole conversation below to that branch
- **Delete** removes a message and every reply underneath it, and says how many before it does

**Copy conversation** in the header exports the branch currently on screen as Markdown.

Existing chats from before 2.0 are read back as a single-branch tree, so no history is lost and nothing has to be re-created.

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
- Click the **menu icon** in the header to open chat history. Sessions are grouped by date, searchable by title or message text, and can be pinned, archived, renamed, duplicated, exported, imported, sorted or deleted

## Settings

Go to **Settings > VaultChat** to configure:

- **API keys** for each provider (stored locally, obfuscated after entry). The key for a local server is optional; leave it blank unless the server was started with one
- **Default model** per provider, with a refresh button for providers that report their own model list
- **Endpoint profiles** for OpenAI-compatible servers: name, base URL, optional key, model, enable/disable, duplicate, delete, and a connection test
- **Context window (num_ctx)** for local servers - controls RAM usage on Ollama. Leave at 0 (the default) to let the server choose; servers that do not support the option ignore it
- **System prompt** - customize the AI's behavior
- **Max tokens** - maximum response length. Leave at 0 (the default) to let the model decide. Anthropic's API requires the field, so 0 sends 4096 there
- **Dynamic current note** - choose whether a current-note source stays on the selected note or follows the active editor tab
- **Context budget** - maximum estimated tokens read from attached notes and folders; skipped files are reported in the context inspector
- **Ignored and protected paths** - keep notes out of search/context or refuse destructive plans for matching paths
- **Presets** - edit your own saved prompts and duplicate the built-in Research, Summarize, Obsidian editor and Vault organizer presets
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

## Support

If VaultChat is useful to you, consider [buying me a coffee](https://buymeacoffee.com/kpulik).

## License

MIT
