import * as http from 'http';
import * as https from 'https';
import { apiBasePath, resolveHost } from '../core';
import { ANTHROPIC_DEFAULT_MAX_TOKENS, PROVIDERS } from './catalog';
import { sanitizeHeaders } from '../endpoints/manager';
import type { WireMessage } from '../chat/messageTree';
import type { OpenAICompatibleEndpoint } from '../endpoints/types';
import type { VaultchatSettings } from '../settings/types';

interface StreamEvent {
  type?: string;
  delta?: { type?: string; text?: string; stop_reason?: string };
  // Reasoning models stream their chain of thought as reasoning_content and only
  // the answer as content. Both arrive on the same delta.
  choices?: {
    delta?: { content?: string; reasoning_content?: string; reasoning?: string };
    finish_reason?: string | null;
  }[];
}

/**
 * What the stream did, reported alongside onDone.
 *
 * A run that produces no visible text is not self-explanatory: it can be a
 * truncated output, a content filter, a dead route, or a reasoning model that
 * emitted nothing but chain of thought. Telling those apart is the difference
 * between useful advice and "try a different model".
 */
export interface StreamSummary {
  finishReason:  string | null;
  /** Reasoning text seen. Retained only so an otherwise-empty run can show it. */
  reasoningText: string;
}

// Enough to explain an empty answer without holding a whole chain of thought.
const MAX_RETAINED_REASONING = 4000;

export interface StreamHandlers {
  onChunk:     (text: string) => void;
  onDone:      (summary: StreamSummary) => void;
  onError:     (msg: string) => void;
  onReasoning: () => void;
}

/** Returns a cancel function that aborts the request and fires onDone once. */
export function streamMessage(
  settings: VaultchatSettings,
  // Resolved by the caller, because the key may live in SecretStorage rather
  // than in settings.
  apiKey:   string,
  // Already reduced to role and content by the caller: the tree's own fields
  // must never reach a provider.
  history:  WireMessage[],
  systemPromptOverride: string,
  handlers: StreamHandlers,
  // The saved OpenAI-compatible server to talk to. Only consulted for the
  // 'local' provider; the hosted providers have fixed addresses of their own.
  endpoint?: OpenAICompatibleEndpoint | null,
): () => void {
  const { onChunk, onDone, onError, onReasoning } = handlers;
  const providerID = settings.activeProvider;
  const def        = PROVIDERS[providerID];
  const ps         = settings.providers[providerID];
  const useEndpoint = providerID === 'local' && endpoint ? endpoint : null;
  const model      = useEndpoint?.defaultModel || ps.model;
  const baseUrl    = (useEndpoint?.baseUrl || ps.baseUrl || def.defaultBaseUrl).replace(/\/$/, '');
  const isHttps    = baseUrl.startsWith('https');
  const transport  = isHttps ? https : http;

  const urlObj   = new URL(baseUrl);
  const hostname = resolveHost(urlObj.hostname);
  const port     = urlObj.port ? parseInt(urlObj.port) : (isHttps ? 443 : 80);
  const basePath = apiBasePath(urlObj);
  const path     = basePath + def.endpoint;

  let bodyStr: string;
  let headers: Record<string, string | number>;

  if (def.format === 'anthropic') {
    const body = {
      model,
      // Anthropic requires max_tokens, so 0 cannot mean "omit it" here the way
      // it does for the OpenAI-shaped providers. It falls back instead.
      max_tokens: settings.maxTokens > 0 ? settings.maxTokens : ANTHROPIC_DEFAULT_MAX_TOKENS,
      system:     systemPromptOverride,
      messages:   history,
      stream:     true,
    };
    bodyStr = JSON.stringify(body);
    headers = {
      'x-api-key':         apiKey,
      'Content-Type':      'application/json',
      'anthropic-version': '2023-06-01',
      'Content-Length':    Buffer.byteLength(bodyStr),
    };
  } else {
    const messages = [
      { role: 'system', content: systemPromptOverride },
      ...history,
    ];
    const body: Record<string, unknown> = {
      model,
      messages,
      stream:   true,
    };
    // Both of these are omitted at 0 so the provider applies its own default,
    // which is what a router or a local server is usually better at deciding.
    if (settings.maxTokens > 0) {
      body['max_tokens'] = settings.maxTokens;
    }
    if (providerID === 'local' && settings.ollamaNumCtx > 0) {
      // Ollama-style hint. Servers that don't understand it ignore it.
      body['options'] = { num_ctx: settings.ollamaNumCtx };
    }
    bodyStr = JSON.stringify(body);
    headers = {
      // Local servers started without a key ignore this; some still require the
      // header to be present, so send a placeholder rather than omitting it.
      'Authorization':  `Bearer ${apiKey || 'no-key'}`,
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
    };
    if (providerID === 'openrouter') {
      headers['HTTP-Referer'] = 'https://obsidian.md';
      headers['X-Title']      = 'vaultchat';
    }
    // Endpoint headers are applied last but cannot reach Authorization,
    // Content-Type, Content-Length or Host: sanitizeHeaders drops those, so a
    // custom header can add to the request but never rewrite how it is framed.
    Object.assign(headers, sanitizeHeaders(useEndpoint?.customHeaders));
  }

  let finished = false;
  let cancelled = false;
  let finishReason: string | null = null;
  let reasoningText = '';

  const summary = (): StreamSummary => ({ finishReason, reasoningText });

  const req = transport.request(
    { hostname, port, path, method: 'POST', headers },
    (res: import('http').IncomingMessage) => {
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', (chunk: Buffer) => { errBody += chunk.toString(); });
        res.on('end', () => {
          let hint = '';
          if (res.statusCode === 401) hint = ' -check your API key in settings';
          if (res.statusCode === 403) hint = ' -key may lack permissions';
          onError(`API ${res.statusCode}${hint}: ${errBody}`);
        });
        return;
      }

      let buf = '';

      const handleLine = (line: string) => {
        if (!line.startsWith('data: ')) return;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') { finished = true; onDone(summary()); return; }
        try {
          const evt = JSON.parse(payload) as StreamEvent;
          if (def.format === 'anthropic') {
            if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
              onChunk(evt.delta.text);
            }
            if (evt.delta?.stop_reason) finishReason = evt.delta.stop_reason;
          } else {
            const choice = evt.choices?.[0];
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            const delta = choice?.delta;
            if (delta?.content) onChunk(delta.content);
            else {
              // Servers disagree on the field name for chain of thought.
              const thought = delta?.reasoning_content ?? delta?.reasoning;
              if (thought) {
                // Kept, not discarded: when a model emits only reasoning, that
                // text is the whole of what it produced, and throwing it away
                // leaves the user staring at a blank bubble.
                if (reasoningText.length < MAX_RETAINED_REASONING) reasoningText += thought;
                onReasoning();
              }
            }
          }
        } catch { /* ignore SSE parse errors */ }
      };

      res.on('data', (chunk: Buffer) => {
        if (finished) return;
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        lines.forEach(handleLine);
      });
      res.on('end',   () => { if (!finished) onDone(summary()); });
      res.on('error', (err: Error) => {
        if (!cancelled) onError(`Stream error: ${err.message}`);
      });
    },
  );

  req.on('error', (err: Error) => {
    if (cancelled || (err as NodeJS.ErrnoException).code === 'ECONNRESET') return;
    onError(`Network error: ${err.message}`);
  });
  req.write(bodyStr);
  req.end();

  return () => {
    if (!finished) {
      cancelled = true;
      finished = true;
      req.destroy();
      onDone(summary());
    }
  };
}
