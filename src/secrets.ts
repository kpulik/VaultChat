import type { App, SecretStorage } from 'obsidian';

// API key storage.
//
// Keys used to live in the plugin's data.json in plain text, which sits inside the
// vault and therefore inside whatever the user syncs. Obsidian's SecretStorage
// arrived in 1.11.4, below which this plugin still runs, so probe for it at
// runtime instead of trusting the typings to match the running app.
//
// Feature probe kept as belt and braces even though minAppVersion now guarantees
// SecretStorage exists, so a force-installed copy on an older app degrades to the
// plain-text path rather than throwing.
export function secureStore(app: App): SecretStorage | null {
  const s = (app as { secretStorage?: SecretStorage }).secretStorage;
  return s && typeof s.setSecret === 'function' ? s : null;
}
