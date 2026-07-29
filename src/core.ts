// Pure logic with no Obsidian imports, so it can be unit tested outside the app.
// Anything here that needs Obsidian's normalizePath takes it as an argument
// rather than importing it.

export interface EditBlock {
  filePath: string;
  edits:    { original: string; replacement: string }[];
}

export interface DeleteBlock {
  filePaths: string[];
}

export type Normalizer = (p: string) => string;

// A base URL is accepted both bare (http://host:port) and with the /v1 suffix
// that most OpenAI-compatible servers document, so the caller can paste either
// without ending up requesting /v1/v1/....
export function apiBasePath(url: URL): string {
  const p = url.pathname.replace(/\/$/, '');
  return p === '' ? '' : p.replace(/\/v1$/, '');
}

// Node resolves "localhost" to ::1 first, while most local model servers listen
// on IPv4 only. Connecting by address turns a confusing ECONNREFUSED ::1 into a
// working request. Remote providers never hit this branch.
export function resolveHost(hostname: string): string {
  return hostname === 'localhost' ? '127.0.0.1' : hostname;
}

// Paths in edit and delete blocks come from the model, so they are untrusted.
// Obsidian resolves '..' against the vault root, which would let a response write
// outside the vault entirely. Anything with a '..' segment is refused.
export function isSafeVaultPath(p: string, normalize: Normalizer): boolean {
  const norm = normalize(p);
  return norm.length > 0 && norm !== '/' && !norm.split('/').includes('..');
}

export function parseEditBlocks(text: string, normalize: Normalizer): EditBlock[] {
  const blocks: EditBlock[] = [];
  const blockRegex = /```edit:(.+?)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(text)) !== null) {
    const filePath = match[1].trim();
    const body = match[2];
    const edits: { original: string; replacement: string }[] = [];

    // The newline before the markers is optional so that an empty ORIGINAL (the
    // documented way to create a new file) and an empty MODIFIED both parse.
    const editRegex = /<<<<<<< ORIGINAL\n([\s\S]*?)\n?=======\n([\s\S]*?)\n?>>>>>>> MODIFIED/g;
    let editMatch: RegExpExecArray | null;
    while ((editMatch = editRegex.exec(body)) !== null) {
      edits.push({ original: editMatch[1], replacement: editMatch[2] });
    }

    if (edits.length > 0 && isSafeVaultPath(filePath, normalize)) {
      blocks.push({ filePath: normalize(filePath), edits });
    }
  }
  return blocks;
}

export function parseDeleteBlocks(text: string, normalize: Normalizer): DeleteBlock[] {
  const blocks: DeleteBlock[] = [];
  const regex = /```delete\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const paths = match[1].trim().split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0 && isSafeVaultPath(l, normalize))
      .map(l => normalize(l));
    if (paths.length > 0) {
      blocks.push({ filePaths: paths });
    }
  }
  return blocks;
}

export type ApplyResult =
  | { status: 'applied';   content: string }
  | { status: 'not_found' }
  | { status: 'ambiguous'; count: number };

export function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

// Applies one ORIGINAL/MODIFIED pair.
//
// Two things this guards that a bare String.replace does not:
//   - The replacement is passed as a function, so `$&`, `` $` ``, `$'`, `$1` and
//     `$$` in the model's text stay literal. They are otherwise expanded as
//     replacement patterns, which silently corrupts any note containing `$` -
//     and Obsidian writes inline and display maths as `$...$` and `$$...$$`.
//   - An ORIGINAL that appears more than once is refused rather than applied to
//     whichever copy happens to come first.
export function applyEdit(content: string, original: string, replacement: string): ApplyResult {
  const count = countOccurrences(content, original);
  if (count === 0) return { status: 'not_found' };
  if (count > 1) return { status: 'ambiguous', count };
  return { status: 'applied', content: content.replace(original, () => replacement) };
}

// Obsidian's MarkdownRenderer runs every code-block post-processor a plugin has
// registered. Several popular plugins register ones that EXECUTE the block: a
// ```dataviewjs fence runs JavaScript with access to `app`, and therefore to
// vault.modify, vault.create and vault.delete. Assistant output is model-authored
// and note contents are fed back into the prompt, so a poisoned note could reach
// code execution and bypass every confirmation in this plugin. Rewriting the
// language of those fences before rendering leaves the text fully readable while
// making sure nothing claims it for execution.
//
// This is a denylist, so it cannot be complete. It covers the executors that are
// widely installed; anything unknown still renders as an ordinary code block.
const EXECUTABLE_FENCE_LANGS = new Set([
  'dataviewjs', 'dataview',
  'js-engine', 'jsengine',
  'templater-js', 'templater',
  'customjs',
  'meta-bind-js', 'meta-bind-button', 'meta-bind-embed',
  'quickadd',
  'pyscript',
  'jsx', 'tsx',
]);

export function isExecutableFenceLang(lang: string): boolean {
  const l = lang.trim().toLowerCase();
  // The Execute Code plugin registers run-<language> for a long list.
  return EXECUTABLE_FENCE_LANGS.has(l) || l.startsWith('run-');
}

export function neutralizeExecutableFences(markdown: string): string {
  return markdown.replace(
    /^([ \t]{0,3})(`{3,}|~{3,})([^\n]*)$/gm,
    (whole: string, indent: string, fence: string, info: string) => {
      const lang = info.trim().split(/\s+/)[0] ?? '';
      if (!lang || !isExecutableFenceLang(lang)) return whole;
      return `${indent}${fence}text`;
    },
  );
}

// Secret ids must be lowercase alphanumeric with optional dashes.
export function secretId(providerId: string): string {
  return `vaultchat-${providerId}`;
}

// Extracts the visible answer from one OpenAI-shaped SSE line. Reasoning models
// stream their chain of thought as reasoning_content and only the answer as
// content, so the two are reported separately.
export function parseSseLine(line: string): { done: boolean; content?: string; reasoning?: boolean } {
  if (!line.startsWith('data: ')) return { done: false };
  const payload = line.slice(6).trim();
  if (payload === '[DONE]') return { done: true };
  try {
    const evt = JSON.parse(payload) as {
      choices?: { delta?: { content?: string; reasoning_content?: string } }[];
    };
    const delta = evt.choices?.[0]?.delta;
    if (delta?.content) return { done: false, content: delta.content };
    if (delta?.reasoning_content) return { done: false, reasoning: true };
  } catch { /* ignore SSE parse errors */ }
  return { done: false };
}
