export function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)         return 'just now';
  if (s < 3600)       return `${Math.floor(s / 60)}m ago`;
  if (s < 86400)      return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function sessionTitle(firstUserMessage: string): string {
  const stripped = stripFileBlocks(firstUserMessage);
  return stripped.length > 60 ? stripped.slice(0, 57) + '…' : stripped;
}

// The attached-note blocks a turn was sent with, as one leading run.
const FILE_BLOCK_PREFIX = /^(?:<file[^>]*>[\s\S]*?<\/file>\n\n|<note[^>]*>[\s\S]*?<\/note>\n\n)*/;

/**
 * The `<file>` preamble of a user turn, without the question itself.
 *
 * Editing a message re-sends it, and the edited version has to carry the same
 * attachments -- otherwise a follow-up question silently loses the notes the
 * original was asked about.
 */
export function fileBlockPrefix(content: string): string {
  return FILE_BLOCK_PREFIX.exec(content)?.[0] ?? '';
}

export function stripFileBlocks(content: string): string {
  return content
    .replace(/<file[^>]*>[\s\S]*?<\/file>\n\n/g, '')
    .replace(/<note[^>]*>[\s\S]*?<\/note>\n\n/, '')
    .trim();
}

export function maskToken(token: string): string {
  if (token.length <= 16) return '●'.repeat(token.length);
  return token.slice(0, 12) + '  ●●●●●●●●●●●●●●●●●●●●  ' + token.slice(-4);
}
