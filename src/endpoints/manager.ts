// Endpoint CRUD, naming, URL validation and header sanitising.
//
// Pure: no Obsidian imports, so every rule here is unit testable outside the app.
// The id generator is injected rather than imported so tests are deterministic.

import { secretId } from '../core';
import {
  DEFAULT_LOCAL_BASE_URL,
  LEGACY_LOCAL_ENDPOINT_ID,
} from './types';
import type { OpenAICompatibleEndpoint } from './types';

/**
 * SecretStorage id for an endpoint's API key.
 *
 * The migrated legacy endpoint keeps the pre-2.0 `vaultchat-local` id, so an
 * existing local server's key survives the upgrade without being read, copied
 * and rewritten -- an operation that would put the key back in memory for no
 * reason and lose it entirely if it failed halfway.
 */
export function endpointSecretId(endpointId: string): string {
  return endpointId === LEGACY_LOCAL_ENDPOINT_ID
    ? secretId('local')
    : `vaultchat-endpoint-${endpointId}`;
}

/** Ports that identify a local server, so a new endpoint gets a useful name. */
const KNOWN_PORTS: Record<string, string> = {
  '11434': 'Ollama',
  '1234':  'LM Studio',
  '8080':  'llama.cpp',
  '8000':  'vLLM',
  '1337':  'Jan',
  '3000':  'Open WebUI',
  '4000':  'LiteLLM',
};

export function endpointNameFromUrl(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    const known = u.port ? KNOWN_PORTS[u.port] : undefined;
    if (known) return known;
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return 'New endpoint';
  }
}

export type UrlCheck =
  | { ok: true;  url: string }
  | { ok: false; reason: string };

/**
 * Endpoints are typed by hand, so a malformed one must fail here with something
 * a user can act on rather than throwing out of `new URL` deep inside a request.
 */
export function validateBaseUrl(raw: string): UrlCheck {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return { ok: false, reason: 'Enter a base URL.' };
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'Not a valid URL. Include the scheme, for example http://127.0.0.1:11434' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `Unsupported scheme "${u.protocol.replace(':', '')}". Use http or https.` };
  }
  if (!u.hostname) return { ok: false, reason: 'The URL has no host.' };
  return { ok: true, url: trimmed };
}

// Header names are written into the raw request, where an illegal character
// throws from Node's http layer and takes the whole send down. Anything that is
// not a valid HTTP token, and anything that would override a header this plugin
// sets itself, is dropped rather than passed through.
const RESERVED_HEADERS = new Set([
  'authorization', 'content-type', 'content-length', 'host',
]);

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

export function sanitizeHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim();
    if (!HEADER_NAME.test(name)) continue;
    if (RESERVED_HEADERS.has(name.toLowerCase())) continue;
    // A newline in a value is header injection; drop the whole header.
    const value = String(rawValue);
    if (/[\r\n]/.test(value)) continue;
    out[name] = value;
  }
  return out;
}

// ── CRUD ────────────────────────────────────────────────────────────────────
//
// Every operation returns a new array. Endpoints are persisted settings, and
// mutating the saved array in place made it impossible to tell whether a change
// had been written yet.

export function createEndpoint(
  list: OpenAICompatibleEndpoint[],
  fields: Partial<OpenAICompatibleEndpoint> & { baseUrl: string },
  newId: string,
): OpenAICompatibleEndpoint[] {
  const endpoint: OpenAICompatibleEndpoint = {
    id:      newId,
    name:    fields.name?.trim() || endpointNameFromUrl(fields.baseUrl),
    baseUrl: fields.baseUrl.trim().replace(/\/+$/, ''),
    enabled: fields.enabled ?? true,
    ...(fields.defaultModel  ? { defaultModel:  fields.defaultModel }  : {}),
    ...(fields.customHeaders ? { customHeaders: fields.customHeaders } : {}),
    ...(fields.timeoutMs     ? { timeoutMs:     fields.timeoutMs }     : {}),
  };
  return [...list, endpoint];
}

export function updateEndpoint(
  list: OpenAICompatibleEndpoint[],
  id: string,
  patch: Partial<OpenAICompatibleEndpoint>,
): OpenAICompatibleEndpoint[] {
  return list.map(e => (e.id === id ? { ...e, ...patch, id: e.id } : e));
}

export function deleteEndpoint(
  list: OpenAICompatibleEndpoint[],
  id: string,
): OpenAICompatibleEndpoint[] {
  return list.filter(e => e.id !== id);
}

/** Copies an endpoint under a new id. The clone is named "<name> copy". */
export function duplicateEndpoint(
  list: OpenAICompatibleEndpoint[],
  id: string,
  newId: string,
): OpenAICompatibleEndpoint[] {
  const source = list.find(e => e.id === id);
  if (!source) return list;
  const clone: OpenAICompatibleEndpoint = { ...source, id: newId, name: `${source.name} copy` };
  const at = list.findIndex(e => e.id === id);
  return [...list.slice(0, at + 1), clone, ...list.slice(at + 1)];
}

export function findEndpoint(
  list: OpenAICompatibleEndpoint[],
  id: string | null | undefined,
): OpenAICompatibleEndpoint | null {
  if (!id) return null;
  return list.find(e => e.id === id) ?? null;
}

/**
 * The endpoint a chat should actually use.
 *
 * Falls back to the first enabled endpoint when the selected one has been
 * deleted or disabled, so a stale saved id never silently sends a request to
 * the wrong server -- or to none at all.
 */
export function resolveActiveEndpoint(
  list: OpenAICompatibleEndpoint[],
  activeId: string | null | undefined,
): OpenAICompatibleEndpoint | null {
  const selected = findEndpoint(list, activeId);
  if (selected?.enabled) return selected;
  return list.find(e => e.enabled) ?? null;
}

// ── Migration ───────────────────────────────────────────────────────────────

/** The subset of saved settings the endpoint migration reads and writes. */
export interface LegacyLocalShape {
  endpoints?:        OpenAICompatibleEndpoint[];
  activeEndpointId?: string | null;
  providers?:        Record<string, { model?: string; baseUrl?: string } | undefined>;
}

/**
 * Turns a pre-2.0 install's single local server into the first endpoint profile.
 *
 * Runs on load and is idempotent: once `endpoints` exists it does nothing, so a
 * user who deletes every endpoint does not get the old one resurrected on the
 * next launch.
 */
export function migrateLocalEndpoint(saved: LegacyLocalShape | null | undefined): void {
  if (!saved) return;
  if (Array.isArray(saved.endpoints)) return;

  const legacy  = saved.providers?.local;
  const baseUrl = legacy?.baseUrl?.trim() || DEFAULT_LOCAL_BASE_URL;

  saved.endpoints = [{
    id:      LEGACY_LOCAL_ENDPOINT_ID,
    name:    endpointNameFromUrl(baseUrl),
    baseUrl: baseUrl.replace(/\/+$/, ''),
    enabled: true,
    ...(legacy?.model ? { defaultModel: legacy.model } : {}),
  }];
  saved.activeEndpointId = LEGACY_LOCAL_ENDPOINT_ID;
}
