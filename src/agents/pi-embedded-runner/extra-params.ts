import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { SimpleStreamOptions } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import type { OpenAIResponsesPromptCacheRetention } from "../../config/types.models.js";
import { log } from "./logger.js";

const OPENROUTER_APP_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://openclaw.ai",
  "X-Title": "OpenClaw",
};
const ANTHROPIC_CONTEXT_1M_BETA = "context-1m-2025-08-07";
const ANTHROPIC_1M_MODEL_PREFIXES = ["claude-opus-4", "claude-sonnet-4"] as const;
// NOTE: We only force `store=true` for *direct* OpenAI Responses.
// Codex responses (chatgpt.com/backend-api/codex/responses) require `store=false`.
const OPENAI_RESPONSES_APIS = new Set(["openai-responses"]);
const OPENAI_RESPONSES_PROVIDERS = new Set(["openai"]);
const OPENAI_RESPONSES_TRACKED_IDS_MAX = 1024;
const OPENAI_RESPONSES_RESULT_WRAPPED = Symbol("openaiResponsesResultWrapped");

type OpenAIResponsesProvider = { api?: unknown; provider?: unknown; id?: unknown };
type OpenAIResponsesPayload = {
  prompt_cache_key?: unknown;
  prompt_cache_retention?: unknown;
  previous_response_id?: unknown;
  store?: unknown;
};

type OpenAIResponsesOptions = SimpleStreamOptions & {
  sessionId?: string;
  metadata?: Record<string, unknown>;
};

const openAIResponsesPreviousIdBySessionProvider = new Map<string, string>();

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isOpenAIResponsesApi(model: { api?: unknown }): boolean {
  return typeof model.api === "string" && OPENAI_RESPONSES_APIS.has(model.api);
}

function toOpenAIResponsesSessionProviderKey(sessionId: string, provider: string): string {
  return `${provider}:${sessionId}`;
}

function rememberOpenAIResponsesPreviousId(
  sessionId: string,
  provider: string,
  responseId: string,
): void {
  const key = toOpenAIResponsesSessionProviderKey(sessionId, provider);
  openAIResponsesPreviousIdBySessionProvider.delete(key);
  openAIResponsesPreviousIdBySessionProvider.set(key, responseId);
  if (openAIResponsesPreviousIdBySessionProvider.size <= OPENAI_RESPONSES_TRACKED_IDS_MAX) {
    return;
  }
  const oldestKey = openAIResponsesPreviousIdBySessionProvider.keys().next().value;
  if (typeof oldestKey === "string") {
    openAIResponsesPreviousIdBySessionProvider.delete(oldestKey);
  }
}

function resolveRememberedOpenAIResponsesPreviousId(
  sessionId: string,
  provider: string,
): string | undefined {
  return openAIResponsesPreviousIdBySessionProvider.get(
    toOpenAIResponsesSessionProviderKey(sessionId, provider),
  );
}

function resolveOpenAIResponsesPromptCacheRetention(
  extraParams: Record<string, unknown> | undefined,
): OpenAIResponsesPromptCacheRetention | undefined {
  const retention = extraParams?.promptCacheRetention;
  if (retention === "in_memory" || retention === "24h") {
    return retention;
  }
  return undefined;
}

function resolveAutoOpenAIResponsesPromptCacheKey(
  model: OpenAIResponsesProvider,
  options: OpenAIResponsesOptions | undefined,
): string | undefined {
  const sessionId = normalizeNonEmptyString(options?.sessionId);
  if (sessionId && typeof model.provider === "string") {
    return sessionId;
  }
  const agentId = normalizeNonEmptyString(options?.metadata?.agentId);
  if (agentId && typeof model.provider === "string") {
    return agentId;
  }
  return undefined;
}

function resolveOpenAIResponsesPromptCacheKey(
  extraParams: Record<string, unknown> | undefined,
  model: OpenAIResponsesProvider,
  options: OpenAIResponsesOptions | undefined,
): string | undefined {
  const configured = normalizeNonEmptyString(extraParams?.promptCacheKey);
  if (configured) {
    return configured;
  }
  return resolveAutoOpenAIResponsesPromptCacheKey(model, options);
}

function resolveOpenAIResponsesResponseIdFromAssistant(
  model: OpenAIResponsesProvider,
  message: unknown,
): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const typed = message as {
    role?: unknown;
    api?: unknown;
    provider?: unknown;
    responseId?: unknown;
    response_id?: unknown;
  };
  if (typed.role !== "assistant" || typed.api !== "openai-responses") {
    return undefined;
  }
  if (typeof model.provider === "string" && typed.provider !== model.provider) {
    return undefined;
  }
  return normalizeNonEmptyString(typed.responseId) ?? normalizeNonEmptyString(typed.response_id);
}

function resolvePreviousOpenAIResponsesResponseIdFromContext(
  model: OpenAIResponsesProvider,
  messages: unknown,
): string | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const responseId = resolveOpenAIResponsesResponseIdFromAssistant(model, messages[i]);
    if (responseId) {
      return responseId;
    }
  }
  return undefined;
}

function wrapOpenAIResponsesResultTracking(
  stream: ReturnType<StreamFn>,
  model: OpenAIResponsesProvider,
  sessionId: string | undefined,
): ReturnType<StreamFn> {
  if (!sessionId || typeof model.provider !== "string") {
    return stream;
  }

  const maybeStream = stream as ReturnType<StreamFn> & {
    result?: (() => Promise<unknown>) | undefined;
    [OPENAI_RESPONSES_RESULT_WRAPPED]?: true;
  };
  if (maybeStream[OPENAI_RESPONSES_RESULT_WRAPPED]) {
    return stream;
  }
  if (typeof maybeStream.result !== "function") {
    return stream;
  }

  const originalResult = maybeStream.result.bind(maybeStream);
  maybeStream.result = async () => {
    const message = await originalResult();
    const responseId = resolveOpenAIResponsesResponseIdFromAssistant(model, message);
    if (responseId) {
      rememberOpenAIResponsesPreviousId(sessionId, model.provider as string, responseId);
    }
    return message;
  };
  maybeStream[OPENAI_RESPONSES_RESULT_WRAPPED] = true;

  return stream;
}

function createOpenAIResponsesCacheParamsWrapper(
  baseStreamFn: StreamFn | undefined,
  extraParams: Record<string, unknown> | undefined,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!isOpenAIResponsesApi(model)) {
      return underlying(model, context, options);
    }

    const typedOptions = options as OpenAIResponsesOptions | undefined;
    const sessionId = normalizeNonEmptyString(typedOptions?.sessionId);
    const provider = normalizeNonEmptyString(model.provider);
    const promptCacheRetention = resolveOpenAIResponsesPromptCacheRetention(extraParams);
    const promptCacheKey = resolveOpenAIResponsesPromptCacheKey(extraParams, model, typedOptions);

    const previousFromContext = resolvePreviousOpenAIResponsesResponseIdFromContext(
      model,
      context.messages,
    );
    if (sessionId && provider && previousFromContext) {
      rememberOpenAIResponsesPreviousId(sessionId, provider, previousFromContext);
    }
    const previousResponseId =
      previousFromContext ??
      (sessionId && provider
        ? resolveRememberedOpenAIResponsesPreviousId(sessionId, provider)
        : undefined);

    const shouldInjectPayload =
      Boolean(promptCacheRetention) || Boolean(promptCacheKey) || Boolean(previousResponseId);

    const stream = shouldInjectPayload
      ? underlying(model, context, {
          ...options,
          onPayload: (payload) => {
            if (payload && typeof payload === "object") {
              const typedPayload = payload as OpenAIResponsesPayload;
              if (promptCacheRetention) {
                typedPayload.prompt_cache_retention = promptCacheRetention;
              }
              if (promptCacheKey) {
                typedPayload.prompt_cache_key = promptCacheKey;
              }
              if (previousResponseId) {
                typedPayload.previous_response_id = previousResponseId;
              }
            }
            options?.onPayload?.(payload);
          },
        })
      : underlying(model, context, options);

    return wrapOpenAIResponsesResultTracking(stream, model, sessionId);
  };
}

/**
 * Test helper to reset in-memory previous_response_id tracking.
 */
export function resetOpenAIResponsesPreviousIdTrackingForTests(): void {
  openAIResponsesPreviousIdBySessionProvider.clear();
}

/**
 * Resolve provider-specific extra params from model config.
 * Used to pass through stream params like temperature/maxTokens.
 *
 * @internal Exported for testing only
 */
export function resolveExtraParams(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
}): Record<string, unknown> | undefined {
  const modelKey = `${params.provider}/${params.modelId}`;
  const modelConfig = params.cfg?.agents?.defaults?.models?.[modelKey];
  return modelConfig?.params ? { ...modelConfig.params } : undefined;
}

function normalizeApiType(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveConfiguredModelApi(
  cfg: OpenClawConfig | undefined,
  provider: string,
  modelId: string,
): string | undefined {
  const providerConfig = cfg?.models?.providers?.[provider];
  if (!providerConfig) {
    return undefined;
  }

  const modelConfig = providerConfig.models.find((model) => model.id === modelId);
  return normalizeApiType(modelConfig?.api) ?? normalizeApiType(providerConfig.api);
}

function resolveEffectiveModelApi(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  modelApi?: string;
}): string | undefined {
  const explicit = normalizeApiType(params.modelApi);
  if (explicit) {
    return explicit;
  }

  const fromConfig = resolveConfiguredModelApi(params.cfg, params.provider, params.modelId);
  if (fromConfig) {
    return fromConfig;
  }

  if (params.provider === "anthropic") {
    return "anthropic-messages";
  }

  if (params.provider.toLowerCase().includes("anthropic")) {
    return "anthropic-messages";
  }

  return undefined;
}

function isAnthropicMessagesApi(apiType: string | undefined): boolean {
  return apiType === "anthropic-messages";
}

type CacheRetention = "none" | "short" | "long";
type CacheRetentionStreamOptions = Partial<SimpleStreamOptions> & {
  cacheRetention?: CacheRetention;
};

/**
 * Resolve cacheRetention from extraParams, supporting both new `cacheRetention`
 * and legacy `cacheControlTtl` values for backwards compatibility.
 *
 * Mapping: "5m" → "short", "1h" → "long"
 *
 * Only applies when the underlying model uses Anthropic's messages API.
 *
 * Defaults to "short" for anthropic-messages API models when not explicitly
 * configured.
 */
function resolveCacheRetention(
  extraParams: Record<string, unknown> | undefined,
  modelApi: string | undefined,
): CacheRetention | undefined {
  if (!isAnthropicMessagesApi(modelApi)) {
    return undefined;
  }

  // Prefer new cacheRetention if present
  const newVal = extraParams?.cacheRetention;
  if (newVal === "none" || newVal === "short" || newVal === "long") {
    return newVal;
  }

  // Fall back to legacy cacheControlTtl with mapping
  const legacy = extraParams?.cacheControlTtl;
  if (legacy === "5m") {
    return "short";
  }
  if (legacy === "1h") {
    return "long";
  }

  // Default to "short" for anthropic-messages models when not explicitly configured
  return "short";
}

function createStreamFnWithExtraParams(
  baseStreamFn: StreamFn | undefined,
  extraParams: Record<string, unknown> | undefined,
  modelApi: string | undefined,
): StreamFn | undefined {
  const hasExtraParams = Boolean(extraParams && Object.keys(extraParams).length > 0);
  if (!hasExtraParams && !isAnthropicMessagesApi(modelApi)) {
    return undefined;
  }

  const resolvedExtraParams = extraParams ?? {};
  const streamParams: CacheRetentionStreamOptions = {};
  if (typeof resolvedExtraParams.temperature === "number") {
    streamParams.temperature = resolvedExtraParams.temperature;
  }
  if (typeof resolvedExtraParams.maxTokens === "number") {
    streamParams.maxTokens = resolvedExtraParams.maxTokens;
  }
  const cacheRetention = resolveCacheRetention(resolvedExtraParams, modelApi);
  if (cacheRetention) {
    streamParams.cacheRetention = cacheRetention;
  }

  if (Object.keys(streamParams).length === 0) {
    return undefined;
  }

  log.debug(`creating streamFn wrapper with params: ${JSON.stringify(streamParams)}`);

  const underlying = baseStreamFn ?? streamSimple;
  const wrappedStreamFn: StreamFn = (model, context, options) =>
    underlying(model, context, {
      ...streamParams,
      ...options,
    });

  return wrappedStreamFn;
}

function isDirectOpenAIBaseUrl(baseUrl: unknown): boolean {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    return true;
  }

  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "api.openai.com" || host === "chatgpt.com";
  } catch {
    const normalized = baseUrl.toLowerCase();
    return normalized.includes("api.openai.com") || normalized.includes("chatgpt.com");
  }
}

function shouldForceResponsesStore(model: {
  api?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
}): boolean {
  if (typeof model.api !== "string" || typeof model.provider !== "string") {
    return false;
  }
  if (!OPENAI_RESPONSES_APIS.has(model.api)) {
    return false;
  }
  if (!OPENAI_RESPONSES_PROVIDERS.has(model.provider)) {
    return false;
  }
  return isDirectOpenAIBaseUrl(model.baseUrl);
}

function createOpenAIResponsesStoreWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!shouldForceResponsesStore(model)) {
      return underlying(model, context, options);
    }

    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          (payload as { store?: unknown }).store = true;
        }
        originalOnPayload?.(payload);
      },
    });
  };
}

function isAnthropic1MModel(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return ANTHROPIC_1M_MODEL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function parseHeaderList(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveAnthropicBetas(
  extraParams: Record<string, unknown> | undefined,
  modelApi: string | undefined,
  provider: string,
  modelId: string,
): string[] | undefined {
  if (!isAnthropicMessagesApi(modelApi)) {
    return undefined;
  }

  const betas = new Set<string>();
  const configured = extraParams?.anthropicBeta;
  if (typeof configured === "string" && configured.trim()) {
    betas.add(configured.trim());
  } else if (Array.isArray(configured)) {
    for (const beta of configured) {
      if (typeof beta === "string" && beta.trim()) {
        betas.add(beta.trim());
      }
    }
  }

  if (extraParams?.context1m === true) {
    if (isAnthropic1MModel(modelId)) {
      betas.add(ANTHROPIC_CONTEXT_1M_BETA);
    } else {
      log.warn(`ignoring context1m for non-opus/sonnet model: ${provider}/${modelId}`);
    }
  }

  return betas.size > 0 ? [...betas] : undefined;
}

function mergeAnthropicBetaHeader(
  headers: Record<string, string> | undefined,
  betas: string[],
): Record<string, string> {
  const merged = { ...headers };
  const existingKey = Object.keys(merged).find((key) => key.toLowerCase() === "anthropic-beta");
  const existing = existingKey ? parseHeaderList(merged[existingKey]) : [];
  const values = Array.from(new Set([...existing, ...betas]));
  const key = existingKey ?? "anthropic-beta";
  merged[key] = values.join(",");
  return merged;
}

// Betas that pi-ai's createClient injects for standard Anthropic API key calls.
// Must be included when injecting anthropic-beta via options.headers, because
// pi-ai's mergeHeaders uses Object.assign (last-wins), which would otherwise
// overwrite the hardcoded defaultHeaders["anthropic-beta"].
const PI_AI_DEFAULT_ANTHROPIC_BETAS = [
  "fine-grained-tool-streaming-2025-05-14",
  "interleaved-thinking-2025-05-14",
] as const;

// Additional betas pi-ai injects when the API key is an OAuth token (sk-ant-oat-*).
// These are required for Anthropic to accept OAuth Bearer auth. Losing oauth-2025-04-20
// causes a 401 "OAuth authentication is currently not supported".
const PI_AI_OAUTH_ANTHROPIC_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  ...PI_AI_DEFAULT_ANTHROPIC_BETAS,
] as const;

function isAnthropicOAuthApiKey(apiKey: unknown): boolean {
  return typeof apiKey === "string" && apiKey.includes("sk-ant-oat");
}

function createAnthropicBetaHeadersWrapper(
  baseStreamFn: StreamFn | undefined,
  betas: string[],
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    // Preserve the betas pi-ai's createClient would inject for the given token type.
    // Without this, our options.headers["anthropic-beta"] overwrites the pi-ai
    // defaultHeaders via Object.assign, stripping critical betas like oauth-2025-04-20.
    const piAiBetas = isAnthropicOAuthApiKey(options?.apiKey)
      ? (PI_AI_OAUTH_ANTHROPIC_BETAS as readonly string[])
      : (PI_AI_DEFAULT_ANTHROPIC_BETAS as readonly string[]);
    const allBetas = [...new Set([...piAiBetas, ...betas])];
    return underlying(model, context, {
      ...options,
      headers: mergeAnthropicBetaHeader(options?.headers, allBetas),
    });
  };
}

/**
 * Create a streamFn wrapper that adds OpenRouter app attribution headers.
 * These headers allow OpenClaw to appear on OpenRouter's leaderboard.
 */
function createOpenRouterHeadersWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    underlying(model, context, {
      ...options,
      headers: {
        ...OPENROUTER_APP_HEADERS,
        ...options?.headers,
      },
    });
}

/**
 * Create a streamFn wrapper that injects tool_stream=true for Z.AI providers.
 *
 * Z.AI's API supports the `tool_stream` parameter to enable real-time streaming
 * of tool call arguments and reasoning content. When enabled, the API returns
 * progressive tool_call deltas, allowing users to see tool execution in real-time.
 *
 * @see https://docs.z.ai/api-reference#streaming
 */
function createZaiToolStreamWrapper(
  baseStreamFn: StreamFn | undefined,
  enabled: boolean,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!enabled) {
      return underlying(model, context, options);
    }

    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          // Inject tool_stream: true for Z.AI API
          (payload as Record<string, unknown>).tool_stream = true;
        }
        originalOnPayload?.(payload);
      },
    });
  };
}

/**
 * Apply extra params (like temperature) to an agent's streamFn.
 * Also adds OpenRouter app attribution headers when using the OpenRouter provider.
 *
 * @internal Exported for testing
 */
export function applyExtraParamsToAgent(
  agent: { streamFn?: StreamFn },
  cfg: OpenClawConfig | undefined,
  provider: string,
  modelId: string,
  extraParamsOverride?: Record<string, unknown>,
  modelApi?: string,
): void {
  const extraParams = resolveExtraParams({
    cfg,
    provider,
    modelId,
  });
  const override =
    extraParamsOverride && Object.keys(extraParamsOverride).length > 0
      ? Object.fromEntries(
          Object.entries(extraParamsOverride).filter(([, value]) => value !== undefined),
        )
      : undefined;
  const merged = Object.assign({}, extraParams, override);
  const resolvedModelApi = resolveEffectiveModelApi({
    cfg,
    provider,
    modelId,
    modelApi,
  });
  const wrappedStreamFn = createStreamFnWithExtraParams(agent.streamFn, merged, resolvedModelApi);

  if (wrappedStreamFn) {
    log.debug(`applying extraParams to agent streamFn for ${provider}/${modelId}`);
    agent.streamFn = wrappedStreamFn;
  }

  const anthropicBetas = resolveAnthropicBetas(merged, resolvedModelApi, provider, modelId);
  if (anthropicBetas?.length) {
    log.debug(
      `applying Anthropic beta header for ${provider}/${modelId}: ${anthropicBetas.join(",")}`,
    );
    agent.streamFn = createAnthropicBetaHeadersWrapper(agent.streamFn, anthropicBetas);
  }

  if (provider === "openrouter") {
    log.debug(`applying OpenRouter app attribution headers for ${provider}/${modelId}`);
    agent.streamFn = createOpenRouterHeadersWrapper(agent.streamFn);
  }

  // Enable Z.AI tool_stream for real-time tool call streaming.
  // Enabled by default for Z.AI provider, can be disabled via params.tool_stream: false
  if (provider === "zai" || provider === "z-ai") {
    const toolStreamEnabled = merged?.tool_stream !== false;
    if (toolStreamEnabled) {
      log.debug(`enabling Z.AI tool_stream for ${provider}/${modelId}`);
      agent.streamFn = createZaiToolStreamWrapper(agent.streamFn, true);
    }
  }

  // Apply OpenAI Responses API cache controls for all compatible providers.
  // `prompt_cache_retention` and `prompt_cache_key` are injected via payload,
  // and `previous_response_id` is derived from prior assistant response metadata.
  agent.streamFn = createOpenAIResponsesCacheParamsWrapper(agent.streamFn, merged);

  // Work around upstream pi-ai hardcoding `store: false` for Responses API.
  // Force `store=true` for direct OpenAI/OpenAI Codex providers so multi-turn
  // server-side conversation state is preserved.
  agent.streamFn = createOpenAIResponsesStoreWrapper(agent.streamFn);
}
