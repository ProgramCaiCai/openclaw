import type { ChannelOutboundAdapter } from "../types.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { markdownToTelegramHtmlChunks } from "../../../telegram/format.js";
import { sendMessageTelegram } from "../../../telegram/send.js";

function parseReplyToMessageId(replyToId?: string | null) {
  if (!replyToId) {
    return undefined;
  }
  const trimmed = replyToId.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!/^-?\d+$/.test(trimmed)) {
    return undefined;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return undefined;
  }
  return parsed;
}

function parseThreadId(threadId?: string | number | null) {
  if (threadId == null) {
    return undefined;
  }
  if (typeof threadId === "number") {
    return Number.isFinite(threadId) ? Math.trunc(threadId) : undefined;
  }
  const trimmed = threadId.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

type TelegramOutboundChannelData = {
  buttons?: Array<Array<{ text: string; callback_data: string }>>;
  quoteText?: string;
};

function isTelegramOutboundButtons(
  value: unknown,
): value is TelegramOutboundChannelData["buttons"] {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.every(
    (row) =>
      Array.isArray(row) &&
      row.every(
        (button) =>
          Boolean(button) &&
          typeof button === "object" &&
          typeof (button as { text?: unknown }).text === "string" &&
          typeof (button as { callback_data?: unknown }).callback_data === "string",
      ),
  );
}

function readTelegramOutboundChannelData(value: unknown): TelegramOutboundChannelData | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  const quoteText = typeof obj.quoteText === "string" ? obj.quoteText : undefined;
  const buttons = isTelegramOutboundButtons(obj.buttons) ? obj.buttons : undefined;
  if (!quoteText && !buttons) {
    return undefined;
  }
  return {
    ...(buttons ? { buttons } : {}),
    ...(quoteText ? { quoteText } : {}),
  };
}

export const telegramOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: markdownToTelegramHtmlChunks,
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendText: async ({ to, text, accountId, deps, replyToId, threadId }) => {
    const send = deps?.sendTelegram ?? sendMessageTelegram;
    const replyToMessageId = parseReplyToMessageId(replyToId);
    const messageThreadId = parseThreadId(threadId);
    const result = await send(to, text, {
      verbose: false,
      textMode: "html",
      messageThreadId,
      replyToMessageId,
      accountId: accountId ?? undefined,
    });
    return { channel: "telegram", ...result };
  },
  sendMedia: async ({ to, text, mediaUrl, accountId, deps, replyToId, threadId }) => {
    const send = deps?.sendTelegram ?? sendMessageTelegram;
    const replyToMessageId = parseReplyToMessageId(replyToId);
    const messageThreadId = parseThreadId(threadId);
    const result = await send(to, text, {
      verbose: false,
      mediaUrl,
      textMode: "html",
      messageThreadId,
      replyToMessageId,
      accountId: accountId ?? undefined,
    });
    return { channel: "telegram", ...result };
  },
  sendPayload: async ({ to, payload, accountId, deps, replyToId, threadId }) => {
    const send = deps?.sendTelegram ?? sendMessageTelegram;
    const replyToMessageId = parseReplyToMessageId(replyToId);
    const messageThreadId = parseThreadId(threadId);
    const telegramData = readTelegramOutboundChannelData(payload.channelData?.telegram);
    const quoteText = telegramData?.quoteText;
    const text = payload.text ?? "";
    const mediaUrls = payload.mediaUrls?.length
      ? payload.mediaUrls
      : payload.mediaUrl
        ? [payload.mediaUrl]
        : [];
    const baseOpts = {
      verbose: false,
      textMode: "html" as const,
      messageThreadId,
      replyToMessageId,
      quoteText,
      accountId: accountId ?? undefined,
    };

    if (mediaUrls.length === 0) {
      const result = await send(to, text, {
        ...baseOpts,
        buttons: telegramData?.buttons,
      });
      return { channel: "telegram", ...result };
    }

    // Telegram allows reply_markup on media; attach buttons only to first send.
    const sentMessageIds: string[] = [];
    let finalResult: Awaited<ReturnType<typeof send>> | undefined;
    try {
      for (let i = 0; i < mediaUrls.length; i += 1) {
        const mediaUrl = mediaUrls[i];
        const isFirst = i === 0;
        finalResult = await send(to, isFirst ? text : "", {
          ...baseOpts,
          mediaUrl,
          ...(isFirst ? { buttons: telegramData?.buttons } : {}),
        });
        if (finalResult?.messageId) {
          sentMessageIds.push(finalResult.messageId);
        }
      }
    } catch (err) {
      const partial =
        sentMessageIds.length > 0
          ? `Partial success: sent ${sentMessageIds.length} message(s): ${sentMessageIds.join(", ")}.`
          : "No media messages were sent.";
      const next = new Error(`${formatErrorMessage(err)}. ${partial}`);
      (next as { cause?: unknown }).cause = err;
      (next as { sentMessageIds?: string[] }).sentMessageIds = sentMessageIds;
      throw next;
    }
    return { channel: "telegram", ...(finalResult ?? { messageId: "unknown", chatId: to }) };
  },
};
