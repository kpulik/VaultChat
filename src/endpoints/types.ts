/**
 * A saved OpenAI-compatible server: Ollama, LM Studio, Open WebUI, vLLM,
 * LocalAI, llama.cpp, Jan, LiteLLM, or any self-hosted or proxied equivalent.
 *
 * The API key is never stored here. Only its SecretStorage id is derivable from
 * the endpoint id, so an exported or synced data.json can never carry a key.
 */
export interface OpenAICompatibleEndpoint {
  id:             string;
  name:           string;
  baseUrl:        string;
  enabled:        boolean;
  defaultModel?:  string;
  customHeaders?: Record<string, string>;
  timeoutMs?:     number;
}

// The endpoint that a pre-2.0 install's single local server is migrated into.
// Fixed rather than generated so its stored API key keeps the same secret id and
// does not have to be copied across on upgrade.
export const LEGACY_LOCAL_ENDPOINT_ID = 'local-default';

export const DEFAULT_LOCAL_BASE_URL = 'http://127.0.0.1:11434';
