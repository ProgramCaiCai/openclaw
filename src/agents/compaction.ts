import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { estimateTokens, generateSummary } from "@mariozechner/pi-coding-agent";
import { DEFAULT_CONTEXT_TOKENS } from "./defaults.js";
import { repairToolUseResultPairing } from "./session-transcript-repair.js";

export const BASE_CHUNK_RATIO = 0.4;
export const MIN_CHUNK_RATIO = 0.15;
export const SAFETY_MARGIN = 1.2; // 20% buffer for estimateTokens() inaccuracy
const DEFAULT_SUMMARY_FALLBACK = "No prior history.";
const DEFAULT_PARTS = 2;
const MERGE_SUMMARIES_INSTRUCTIONS =
  "Merge these partial summaries into a single cohesive summary. Preserve decisions," +
  " TODOs, open questions, and any constraints.";

const TOKENS_AFTER_SANITY_RATIO = 1.1;

export class CompactionSummaryUnavailableError extends Error {
  override name = "CompactionSummaryUnavailableError";
}

export function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }
  if (!err || typeof err !== "object") {
    return false;
  }
  return (err as { name?: unknown }).name === "AbortError";
}

function sanitizeTokensAfterEstimate(tokensAfter: number, tokensBefore: number): number {
  if (!Number.isFinite(tokensAfter) || tokensAfter < 0) {
    return tokensBefore;
  }
  if (!Number.isFinite(tokensBefore) || tokensBefore <= 0) {
    return tokensAfter;
  }
  if (tokensAfter > tokensBefore * TOKENS_AFTER_SANITY_RATIO) {
    return tokensBefore;
  }
  return tokensAfter;
}

export function estimateMessagesTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

function normalizeParts(parts: number, messageCount: number): number {
  if (!Number.isFinite(parts) || parts <= 1) {
    return 1;
  }
  return Math.min(Math.max(1, Math.floor(parts)), Math.max(1, messageCount));
}

export function splitMessagesByTokenShare(
  messages: AgentMessage[],
  parts = DEFAULT_PARTS,
): AgentMessage[][] {
  if (messages.length === 0) {
    return [];
  }
  const normalizedParts = normalizeParts(parts, messages.length);
  if (normalizedParts <= 1) {
    return [messages];
  }

  const totalTokens = estimateMessagesTokens(messages);
  const targetTokens = totalTokens / normalizedParts;
  const chunks: AgentMessage[][] = [];
  let current: AgentMessage[] = [];
  let currentTokens = 0;

  for (const message of messages) {
    const messageTokens = estimateTokens(message);
    if (
      chunks.length < normalizedParts - 1 &&
      current.length > 0 &&
      currentTokens + messageTokens > targetTokens
    ) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }

    current.push(message);
    currentTokens += messageTokens;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

export function chunkMessagesByMaxTokens(
  messages: AgentMessage[],
  maxTokens: number,
): AgentMessage[][] {
  if (messages.length === 0) {
    return [];
  }

  const chunks: AgentMessage[][] = [];
  let currentChunk: AgentMessage[] = [];
  let currentTokens = 0;

  for (const message of messages) {
    const messageTokens = estimateTokens(message);
    if (currentChunk.length > 0 && currentTokens + messageTokens > maxTokens) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }

    currentChunk.push(message);
    currentTokens += messageTokens;

    if (messageTokens > maxTokens) {
      // Split oversized messages to avoid unbounded chunk growth.
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Compute adaptive chunk ratio based on average message size.
 * When messages are large, we use smaller chunks to avoid exceeding model limits.
 */
export function computeAdaptiveChunkRatio(messages: AgentMessage[], contextWindow: number): number {
  if (messages.length === 0) {
    return BASE_CHUNK_RATIO;
  }

  const totalTokens = estimateMessagesTokens(messages);
  const avgTokens = totalTokens / messages.length;

  // Apply safety margin to account for estimation inaccuracy
  const safeAvgTokens = avgTokens * SAFETY_MARGIN;
  const avgRatio = safeAvgTokens / contextWindow;

  // If average message is > 10% of context, reduce chunk ratio
  if (avgRatio > 0.1) {
    const reduction = Math.min(avgRatio * 2, BASE_CHUNK_RATIO - MIN_CHUNK_RATIO);
    return Math.max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - reduction);
  }

  return BASE_CHUNK_RATIO;
}

/**
 * Check if a single message is too large to summarize.
 * If single message > 50% of context, it can't be summarized safely.
 */
export function isOversizedForSummary(msg: AgentMessage, contextWindow: number): boolean {
  const tokens = estimateTokens(msg) * SAFETY_MARGIN;
  return tokens > contextWindow * 0.5;
}

async function summarizeChunks(params: {
  messages: AgentMessage[];
  model: NonNullable<ExtensionContext["model"]>;
  apiKey: string;
  signal: AbortSignal;
  reserveTokens: number;
  maxChunkTokens: number;
  customInstructions?: string;
  previousSummary?: string;
}): Promise<string> {
  if (params.messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }

  const chunks = chunkMessagesByMaxTokens(params.messages, params.maxChunkTokens);
  let summary = params.previousSummary;

  for (const chunk of chunks) {
    summary = await generateSummary(
      chunk,
      params.model,
      params.reserveTokens,
      params.apiKey,
      params.signal,
      params.customInstructions,
      summary,
    );
  }

  return summary ?? DEFAULT_SUMMARY_FALLBACK;
}

/**
 * Summarize with progressive fallback for handling oversized messages.
 * If full summarization fails, tries partial summarization excluding oversized messages.
 */
export async function summarizeWithFallback(params: {
  messages: AgentMessage[];
  model: NonNullable<ExtensionContext["model"]>;
  apiKey: string;
  signal: AbortSignal;
  reserveTokens: number;
  maxChunkTokens: number;
  contextWindow: number;
  customInstructions?: string;
  previousSummary?: string;
}): Promise<string> {
  const { messages, contextWindow } = params;

  if (messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }

  // Try full summarization first
  try {
    return await summarizeChunks(params);
  } catch (fullError) {
    if (isAbortError(fullError, params.signal)) {
      throw fullError;
    }
    console.warn(
      `Full summarization failed, trying partial: ${
        fullError instanceof Error ? fullError.message : String(fullError)
      }`,
    );
  }

  // Fallback 1: Summarize only small messages, note oversized ones
  const smallMessages: AgentMessage[] = [];
  const oversizedNotes: string[] = [];

  for (const msg of messages) {
    if (isOversizedForSummary(msg, contextWindow)) {
      const role = (msg as { role?: string }).role ?? "message";
      const tokens = estimateTokens(msg);
      oversizedNotes.push(
        `[Large ${role} (~${Math.round(tokens / 1000)}K tokens) omitted from summary]`,
      );
    } else {
      smallMessages.push(msg);
    }
  }

  if (smallMessages.length > 0) {
    try {
      const partialSummary = await summarizeChunks({
        ...params,
        messages: smallMessages,
      });
      const notes = oversizedNotes.length > 0 ? `\n\n${oversizedNotes.join("\n")}` : "";
      return partialSummary + notes;
    } catch (partialError) {
      if (isAbortError(partialError, params.signal)) {
        throw partialError;
      }
      console.warn(
        `Partial summarization also failed: ${
          partialError instanceof Error ? partialError.message : String(partialError)
        }`,
      );
    }
  }

  // Refuse to produce a low-information summary that would truncate history.
  throw new CompactionSummaryUnavailableError(
    `Summary unavailable; refusing to compact to avoid data loss (messages=${messages.length} oversized=${oversizedNotes.length}).`,
  );
}

export async function summarizeInStages(params: {
  messages: AgentMessage[];
  model: NonNullable<ExtensionContext["model"]>;
  apiKey: string;
  signal: AbortSignal;
  reserveTokens: number;
  maxChunkTokens: number;
  contextWindow: number;
  customInstructions?: string;
  previousSummary?: string;
  parts?: number;
  minMessagesForSplit?: number;
}): Promise<string> {
  const { messages } = params;
  if (messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }

  const minMessagesForSplit = Math.max(2, params.minMessagesForSplit ?? 4);
  const parts = normalizeParts(params.parts ?? DEFAULT_PARTS, messages.length);
  const totalTokens = estimateMessagesTokens(messages);

  if (parts <= 1 || messages.length < minMessagesForSplit || totalTokens <= params.maxChunkTokens) {
    return summarizeWithFallback(params);
  }

  const splits = splitMessagesByTokenShare(messages, parts).filter((chunk) => chunk.length > 0);
  if (splits.length <= 1) {
    return summarizeWithFallback(params);
  }

  const partialSummaries: string[] = [];
  for (const chunk of splits) {
    partialSummaries.push(
      await summarizeWithFallback({
        ...params,
        messages: chunk,
        previousSummary: undefined,
      }),
    );
  }

  if (partialSummaries.length === 1) {
    return partialSummaries[0];
  }

  const summaryMessages: AgentMessage[] = partialSummaries.map((summary) => ({
    role: "user",
    content: summary,
    timestamp: Date.now(),
  }));

  const mergeInstructions = params.customInstructions
    ? `${MERGE_SUMMARIES_INSTRUCTIONS}\n\nAdditional focus:\n${params.customInstructions}`
    : MERGE_SUMMARIES_INSTRUCTIONS;

  return summarizeWithFallback({
    ...params,
    messages: summaryMessages,
    customInstructions: mergeInstructions,
  });
}

/**
 * Check if a message role represents a turn boundary (user-initiated context).
 * Codex treats bashExecution like a user message for turn boundaries.
 */
function isTurnBoundaryRole(role: string): boolean {
  return role === "user" || role === "bashExecution";
}

/**
 * Check if a message is a valid cut point (never cut at toolResult).
 * Matches Codex's findValidCutPoints invariant.
 */
function isValidCutPoint(message: AgentMessage): boolean {
  const role = (message as { role?: unknown })?.role;
  return typeof role === "string" && role !== "toolResult";
}

/**
 * Find the optimal turn-aware cut index in a message array.
 * Returns the index where the kept suffix (messages[cutIndex..]) fits within budgetTokens.
 *
 * Algorithm:
 * 1. Precompute suffix token sums.
 * 2. Collect valid cut points (skip toolResult).
 * 3. Among feasible cut points (suffix fits budget), prefer turn boundaries (user/bashExecution).
 * 4. Pick the earliest feasible candidate to maximize kept history.
 *
 * Returns 0 if everything fits; returns messages.length if nothing can be kept.
 */
function chooseTurnAwareCutIndex(messages: AgentMessage[], budgetTokens: number): number {
  if (messages.length === 0) {
    return 0;
  }
  if (estimateMessagesTokens(messages) <= budgetTokens) {
    return 0;
  }

  // Precompute suffix token sums: suffixTokens[i] = tokens from messages[i..end]
  const msgTokens = messages.map((m) => estimateTokens(m));
  const suffixTokens = Array.from<number>({ length: messages.length + 1 });
  suffixTokens[messages.length] = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    suffixTokens[i] = suffixTokens[i + 1] + msgTokens[i];
  }

  // Collect valid cut points (indices where we could start the kept suffix)
  const validCutPoints: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (isValidCutPoint(messages[i])) {
      validCutPoints.push(i);
    }
  }

  if (validCutPoints.length === 0) {
    // All messages are toolResult — drop everything
    return messages.length;
  }

  // Find feasible cut points where suffix fits within budget
  const feasible = validCutPoints.filter((i) => suffixTokens[i] <= budgetTokens);
  if (feasible.length === 0) {
    // Even the smallest valid suffix exceeds budget; keep from the last valid cut point
    return validCutPoints[validCutPoints.length - 1];
  }

  // Prefer turn boundaries (user/bashExecution) over mid-turn cuts (assistant)
  const feasibleTurnBoundaries = feasible.filter((i) => {
    const role = (messages[i] as { role?: unknown })?.role;
    return typeof role === "string" && isTurnBoundaryRole(role);
  });

  const candidates = feasibleTurnBoundaries.length > 0 ? feasibleTurnBoundaries : feasible;
  // Pick earliest to maximize kept history
  return candidates[0];
}

export function pruneHistoryForContextShare(params: {
  messages: AgentMessage[];
  maxContextTokens: number;
  maxHistoryShare?: number;
  parts?: number;
}): {
  messages: AgentMessage[];
  droppedMessagesList: AgentMessage[];
  droppedChunks: number;
  droppedMessages: number;
  droppedTokens: number;
  keptTokens: number;
  budgetTokens: number;
} {
  const maxHistoryShare = params.maxHistoryShare ?? 0.5;
  const budgetTokens = Math.max(1, Math.floor(params.maxContextTokens * maxHistoryShare));
  const tokensBefore = estimateMessagesTokens(params.messages);

  const cutIndex = chooseTurnAwareCutIndex(params.messages, budgetTokens);
  if (cutIndex <= 0) {
    return {
      messages: params.messages,
      droppedMessagesList: [],
      droppedChunks: 0,
      droppedMessages: 0,
      droppedTokens: 0,
      keptTokens: tokensBefore,
      budgetTokens,
    };
  }

  const dropped = params.messages.slice(0, cutIndex);
  const keptCandidate = params.messages.slice(cutIndex);

  // Repair tool_use/tool_result pairing in the kept suffix to handle any
  // orphaned tool_results whose tool_use was in the dropped prefix.
  const repairReport = repairToolUseResultPairing(keptCandidate);
  const repairedKept = repairReport.messages;
  const orphanedCount = repairReport.droppedOrphanCount;

  const keptTokens = sanitizeTokensAfterEstimate(estimateMessagesTokens(repairedKept), tokensBefore);

  return {
    messages: repairedKept,
    droppedMessagesList: dropped,
    droppedChunks: 1,
    droppedMessages: dropped.length + orphanedCount,
    droppedTokens: estimateMessagesTokens(dropped),
    keptTokens,
    budgetTokens,
  };
}

export function resolveContextWindowTokens(model?: ExtensionContext["model"]): number {
  return Math.max(1, Math.floor(model?.contextWindow ?? DEFAULT_CONTEXT_TOKENS));
}
