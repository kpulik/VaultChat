# Contributing to VaultChat

Thanks for your interest in VaultChat. Bug reports, feature requests, and pull requests are all welcome.

## Reporting bugs

Open an issue at https://github.com/kpulik/VaultChat/issues and include:

- Obsidian version and operating system
- VaultChat version (Settings > Community plugins)
- Which AI provider you were using (Anthropic, OpenAI, Gemini, OpenRouter, or Ollama)
- What you expected to happen and what happened instead
- Steps to reproduce, and any errors from the developer console (Ctrl/Cmd + Shift + I)

Never paste an API key into an issue. Redact it first.

## Requesting features

Open an issue describing the problem you are trying to solve rather than only the solution you have in mind. That makes it easier to find an approach that fits the rest of the plugin.

## Development setup

Requires Node.js 18 or later.

```bash
git clone https://github.com/kpulik/VaultChat.git
cd VaultChat
npm install
```

Commands:

| Command | What it does |
| --- | --- |
| `npm run dev` | esbuild in watch mode, rebuilds `main.js` on save |
| `npm run build` | Type check with `tsc --noEmit`, then a production bundle |
| `npm run lint` | ESLint with the official `eslint-plugin-obsidianmd` rules |

To test inside Obsidian, point the plugin folder of a test vault at this repo:

```bash
ln -s "$(pwd)" /path/to/vault/.obsidian/plugins/vaultchat
```

Obsidian loads `main.js`, `manifest.json`, and `styles.css`. Reload the plugin (or use the Hot Reload plugin) after each build.

Use a scratch vault, not your real notes. VaultChat can create, modify, and delete files.

## Pull requests

Before opening a pull request:

1. `npm run lint` reports no errors.
2. `npm run build` succeeds.
3. You have loaded the plugin in a test vault and exercised the code path you changed.

Keep pull requests focused on a single change. Unrelated refactors and formatting churn make review harder.

### Code style

- TypeScript, no `any` where a real type is available. The ESLint config enforces the `no-unsafe-*` rules, so untyped values will fail the lint.
- No `!important` in `styles.css`. Raise selector specificity instead. State utilities live at the end of the file where source order settles ties.
- Use Obsidian theme CSS variables (`var(--text-normal)`, `var(--background-secondary)`) so the plugin follows the user's theme. The plugin's own palette uses OKLCH.
- Use `window.setTimeout` and `window.requestAnimationFrame` rather than the bare globals, so timers work in popout windows.
- UI text uses sentence case, matching the rest of Obsidian.
- If you use an Obsidian API newer than the current `minAppVersion` in `manifest.json`, raise `minAppVersion` in the same pull request.

### Commit messages

Short imperative subject lines, for example `Fix model dropdown not refreshing for Ollama`. No AI or tool attribution in commit messages.

## Safety rules for vault access

VaultChat can read, create, edit, and delete files in the user's vault. These behaviors are deliberate and must not be weakened:

- Every path that reaches a vault write comes from model output and is untrusted. `parseEditBlocks` and `parseDeleteBlocks` drop any path that fails `isSafeVaultPath`, which rejects `..` segments. Obsidian resolves `..` against the vault root, so without that check a response can write anywhere on disk. Do not add a new write path that skips it.
- Auto-apply defaults to off. File edits are shown as a diff with Preview and Apply before anything is written, unless the user has explicitly turned auto-apply on.
- File deletion requires a second confirmation.
- Deletion goes through `FileManager.trashFile` so the user's trash preference is respected, never a permanent unlink.

A pull request that removes or bypasses a confirmation step, or that widens what paths are accepted, will not be merged.

## API keys

Keys are stored in the plugin's own settings data and are sent only to the provider endpoint they belong to. Do not add telemetry, analytics, or any request to a host that is not the user's chosen provider.

Claude Code OAuth tokens (`sk-ant-oat01-...`) do not work here. Anthropic blocks them for third-party API calls. Use a standard API key.

## Releases

Releases are cut by the maintainer. The version in `manifest.json` must match the git tag, and the release must attach `main.js`, `manifest.json`, and `styles.css`.

## License

By contributing, you agree that your contributions are licensed under the MIT License, the same as the rest of the project.
