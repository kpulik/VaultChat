import * as http from 'http';
import * as https from 'https';
import { apiBasePath, resolveHost } from '../core';
import type { ModelDefinition } from './catalog';

// Reads the OpenAI-compatible /v1/models endpoint, which Ollama, LM Studio,
// llama.cpp, vLLM, LocalAI and Jan all serve.
export function fetchLocalModels(baseUrl: string, apiKey: string): Promise<ModelDefinition[]> {
  return new Promise((resolve, reject) => {
    const trimmed   = baseUrl.replace(/\/$/, '');
    const url       = new URL(trimmed);
    const isHttps   = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    const port      = url.port ? parseInt(url.port) : (isHttps ? 443 : 80);
    const basePath  = apiBasePath(url);
    // Servers started without a key ignore the header; ones started with a key
    // reject the request without it.
    const headers   = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;

    const req = transport.get(
      { hostname: resolveHost(url.hostname), port, path: `${basePath}/v1/models`, headers },
      (res: import('http').IncomingMessage) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const json = JSON.parse(data) as { data?: { id: string }[] };
            resolve((json.data ?? []).map(m => ({ id: m.id, label: m.id })));
          } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
        });
        res.on('error', (err: Error) => reject(err));
      },
    );
    req.on('error', (err: Error) => reject(err));
  });
}

export function fetchOpenRouterModels(apiKey: string): Promise<ModelDefinition[]> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: 'openrouter.ai',
        port: 443,
        path: '/api/v1/models',
        headers: { 'Authorization': `Bearer ${apiKey}` },
      },
      (res: import('http').IncomingMessage) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const json = JSON.parse(data) as { data?: { id: string; name: string }[] };
            resolve(
              (json.data ?? [])
                .map(m => ({ id: m.id, label: m.name || m.id }))
                .sort((a, b) => a.id.localeCompare(b.id)),
            );
          } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
        });
        res.on('error', (err: Error) => reject(err));
      },
    );
    req.on('error', (err: Error) => reject(err));
  });
}
