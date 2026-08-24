// The wire format between the model and the vault (§17, §43).
//
// Pure: text in, structured calls out; structured results in, text out. No
// Obsidian, so the parser -- which is the boundary untrusted model output
// crosses -- is fully testable.
//
// A fenced JSON block is used rather than provider-native function calling
// because this plugin is local-first: many local servers expose no tool API at
// all, and a protocol only some providers support is not a protocol.

import type { ToolCall, ToolResult } from './types';

const TOOL_BLOCK = /```tool\s*\n([\s\S]*?)```/g;
const TEXT_TOOL_PREFIX = /<\|tool_call\|?>\s*(?:call:)?([A-Za-z][A-Za-z0-9_-]*)\s*/g;

function jsonObjectAt(text: string, start: number): { value: Record<string, unknown>; end: number } | null {
  let cursor = start;
  while (/\s/.test(text[cursor] ?? '')) cursor++;
  if (text[cursor] !== '{') return null;

  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = cursor; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try {
        const value = parseModelObject(text.slice(cursor, i + 1));
        return typeof value === 'object' && value !== null && !Array.isArray(value)
          ? { value: value as Record<string, unknown>, end: i + 1 }
          : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Parses JSON emitted by a model without executing it.  Gemma's LM Studio
 * template occasionally omits quotes around otherwise valid identifier keys
 * (`{query: "..."}`), so normalize that narrow deviation before JSON.parse.
 */
function parseModelObject(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    let normalized = '';
    let quoted = false;
    let escaped = false;

    for (let i = 0; i < raw.length; i++) {
      const char = raw[i];
      if (quoted) {
        normalized += char;
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') {
        quoted = true;
        normalized += char;
        continue;
      }
      if ((char === '{' || char === ',') && /\s/.test(raw[i + 1] ?? '')) {
        normalized += char;
        continue;
      }
      if ((char === '{' || char === ',') || /\s/.test(char)) {
        const keyStart = i + 1;
        const match = raw.slice(keyStart).match(/^\s*([A-Za-z_$][A-Za-z0-9_$-]*)\s*:/);
        if (match) {
          normalized += char + match[0].slice(0, match[0].indexOf(match[1]))
            + JSON.stringify(match[1]) + match[0].slice(match[0].indexOf(match[1]) + match[1].length);
          i = keyStart + match[0].length - 1;
          continue;
        }
      }
      normalized += char;
    }
    return JSON.parse(normalized) as unknown;
  }
}

function standaloneToolObject(text: string): { tool: string; args: Record<string, unknown> } | null {
  let trimmed = text.trim();
  // Gemma sometimes obeys the JSON part of the requested format but labels
  // the fence `json` instead of `tool`. Only unwrap a whole response, never an
  // object embedded in prose or a code example with another language.
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/i);
  if (fenced) trimmed = fenced[1].trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;

  try {
    const value = parseModelObject(trimmed);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const rec = value as Record<string, unknown>;
    const tool = typeof rec.tool === 'string' ? rec.tool
      : typeof rec.name === 'string' ? rec.name
      : null;
    if (!tool) return null;
    const rawArgs = rec.args ?? rec.arguments ?? {};
    if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) return null;
    return { tool, args: rawArgs as Record<string, unknown> };
  } catch {
    return null;
  }
}

/**
 * Extracts tool calls from a model response.
 *
 * Malformed blocks are skipped rather than thrown on: a model that emits half a
 * JSON object should get the rest of its calls executed and be told about the
 * broken one, not have the whole turn fail.
 */
export function parseToolCalls(text: string, newId: (i: number) => string): ToolCall[] {
  const calls: ToolCall[] = [];
  let index = 0;

  for (let m = TOOL_BLOCK.exec(text); m !== null; m = TOOL_BLOCK.exec(text)) {
    const raw = m[0];
    const body = m[1].trim();
    if (body === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }

    // A single object, or an array of them.
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue;
      const rec = item as Record<string, unknown>;
      const tool = typeof rec.tool === 'string' ? rec.tool
                 : typeof rec.name === 'string' ? rec.name
                 : null;
      if (tool === null || tool === '') continue;

      const rawArgs = rec.args ?? rec.arguments ?? {};
      const args = typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs)
        ? rawArgs as Record<string, unknown>
        : {};

      calls.push({ id: newId(index++), tool, args, raw });
    }
  }

  // Some local-model templates expose tool calls as text even when the server
  // does not return provider-native tool_calls. Gemma via LM Studio emits:
  // <|tool_call>call:search_vault{"query":"..."}
  TEXT_TOOL_PREFIX.lastIndex = 0;
  for (let m = TEXT_TOOL_PREFIX.exec(text); m !== null; m = TEXT_TOOL_PREFIX.exec(text)) {
    const parsed = jsonObjectAt(text, TEXT_TOOL_PREFIX.lastIndex);
    if (!parsed) continue;
    calls.push({
      id: newId(index++),
      tool: m[1],
      args: parsed.value,
      raw: text.slice(m.index, parsed.end),
    });
    TEXT_TOOL_PREFIX.lastIndex = parsed.end;
  }

  // Gemma may also answer with a bare tool object, despite being asked for a
  // fenced block. Accept it only when it is the entire response so ordinary
  // prose and JSON examples cannot turn into tool work.
  const bare = standaloneToolObject(text);
  if (bare) calls.push({ id: newId(index++), ...bare, raw: text });

  return calls;
}

/** True when the response asks for work, so the agent loop should continue. */
export function hasToolCalls(text: string): boolean {
  TOOL_BLOCK.lastIndex = 0;
  if (TOOL_BLOCK.test(text)) return true;
  TEXT_TOOL_PREFIX.lastIndex = 0;
  return TEXT_TOOL_PREFIX.test(text) || standaloneToolObject(text) !== null;
}

/**
 * The turn fed back to the model after tools run.
 *
 * Results are JSON rather than prose so the model reads facts instead of
 * re-parsing English, and are truncated per result so one enormous file cannot
 * crowd the rest of the conversation out of the context window (§43).
 */
export function formatToolResults(results: ToolResult[], maxCharsEach = 6000): string {
  const parts = results.map(r => {
    const head = `[${r.tool}]`;
    if (!r.ok) {
      return `${head} ERROR ${r.error.kind}: ${r.error.message}`
        + (r.error.candidates?.length
            ? `\ncandidates:\n${r.error.candidates.map(c => `  - ${c.path} (${c.reason})`).join('\n')}`
            : '');
    }
    let body = JSON.stringify(r.data, null, 2);
    if (body.length > maxCharsEach) {
      body = body.slice(0, maxCharsEach) + `\n… truncated, ${body.length - maxCharsEach} more characters`;
    }
    return `${head}\n${body}`;
  });

  return `<tool_results>\n${parts.join('\n\n')}\n</tool_results>`;
}
