import type { Message } from "@grammyjs/types";
import type { TelegramMediaRef } from "./bot-message-context.js";
import type { TelegramContext } from "./bot/types.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { hasControlCommand } from "../auto-reply/command-detection.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../auto-reply/inbound-debounce.js";
import { buildCommandsPaginationKeyboard } from "../auto-reply/reply/commands-info.js";
import { buildModelsProviderData } from "../auto-reply/reply/commands-models.js";
import { resolveStoredModelOverride } from "../auto-reply/reply/model-selection.js";
import { listSkillCommandsForAgents } from "../auto-reply/skill-commands.js";
import { buildCommandsMessagePaginated } from "../auto-reply/status.js";
import { resolveChannelConfigWrites } from "../channels/plugins/config-writes.js";
import { loadConfig } from "../config/config.js";
import { writeConfigFile } from "../config/io.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { danger, logVerbose, warn } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { readChannelAllowFromStore } from "../pairing/pairing-store.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { resolveThreadSessionKeys } from "../routing/session-key.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { firstDefined, isSenderAllowed, normalizeAllowFromWithStore } from "./bot-access.js";
import { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
import {
  MEDIA_GROUP_TIMEOUT_MS,
  resolveTelegramUpdateId,
  setTelegramUpdateCompletionDefer,
} from "./bot-updates.js";
import { resolveMedia } from "./bot/delivery.js";
import {
  buildTelegramGroupPeerId,
  buildTelegramParentPeer,
  resolveTelegramForumThreadId,
} from "./bot/helpers.js";
import { migrateTelegramGroupConfig } from "./group-migration.js";
import { resolveTelegramInlineButtonsScope } from "./inline-buttons.js";
import {
  buildModelsKeyboard,
  buildProviderKeyboard,
  calculateTotalPages,
  getModelsPageSize,
  parseModelCallbackData,
  type ProviderInfo,
} from "./model-buttons.js";
import { buildInlineKeyboard } from "./send.js";

export const registerTelegramHandlers = ({
  cfg,
  accountId,
  bot,
  opts,
  runtime,
  mediaMaxBytes,
  telegramCfg,
  groupAllowFrom,
  resolveGroupPolicy,
  resolveTelegramGroupConfig,
  shouldSkipUpdate,
  processMessage,
  logger,
}: RegisterTelegramHandlerParams) => {
  const TELEGRAM_TEXT_FRAGMENT_START_THRESHOLD_CHARS = 4000;
  const TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS = 1500;
  const TELEGRAM_TEXT_FRAGMENT_MAX_ID_GAP = 1;
  const TELEGRAM_TEXT_FRAGMENT_MAX_PARTS = 12;
  const TELEGRAM_TEXT_FRAGMENT_MAX_TOTAL_CHARS = 50_000;

  type Deferred = {
    promise: Promise<void>;
    resolve: () => void;
    reject: (err: unknown) => void;
  };

  const createDeferred = (): Deferred => {
    let resolve!: () => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  type MediaGroupEntry = {
    messages: Array<{ msg: Message; ctx: TelegramContext; done: Deferred }>;
    timer: ReturnType<typeof setTimeout>;
  };

  const mediaGroupBuffer = new Map<string, MediaGroupEntry>();
  let mediaGroupProcessing: Promise<void> = Promise.resolve();

  type TextFragmentEntry = {
    key: string;
    messages: Array<{ msg: Message; ctx: TelegramContext; receivedAtMs: number; done: Deferred }>;
    timer: ReturnType<typeof setTimeout>;
  };
  const textFragmentBuffer = new Map<string, TextFragmentEntry>();
  let textFragmentProcessing: Promise<void> = Promise.resolve();

  const debounceMs = resolveInboundDebounceMs({ cfg, channel: "telegram" });
  type TelegramDebounceEntry = {
    ctx: TelegramContext;
    msg: Message;
    allMedia: TelegramMediaRef[];
    storeAllowFrom: string[];
    debounceKey: string | null;
    botUsername?: string;
    done: Deferred;
  };
  const inboundDebouncer = createInboundDebouncer<TelegramDebounceEntry>({
    debounceMs,
    buildKey: (entry) => entry.debounceKey,
    shouldDebounce: (entry) => {
      if (entry.allMedia.length > 0) {
        return false;
      }
      const text = entry.msg.text ?? entry.msg.caption ?? "";
      if (!text.trim()) {
        return false;
      }
      return !hasControlCommand(text, cfg, { botUsername: entry.botUsername });
    },
    onFlush: async (entries) => {
      if (entries.length === 0) {
        return;
      }

      const resolveAll = () => {
        for (const entry of entries) {
          entry.done.resolve();
        }
      };

      const rejectAll = (err: unknown) => {
        for (const entry of entries) {
          entry.done.reject(err);
        }
      };

      try {
        const last = entries.at(-1);
        if (!last) {
          resolveAll();
          return;
        }
        if (entries.length === 1) {
          await processMessage(last.ctx, last.allMedia, last.storeAllowFrom);
          resolveAll();
          return;
        }

        const combinedText = entries
          .map((entry) => entry.msg.text ?? entry.msg.caption ?? "")
          .filter(Boolean)
          .join("\n");
        if (!combinedText.trim()) {
          resolveAll();
          return;
        }

        const first = entries[0];
        const baseCtx = first.ctx;
        const getFile =
          typeof baseCtx.getFile === "function" ? baseCtx.getFile.bind(baseCtx) : async () => ({});
        const syntheticMessage: Message = {
          ...first.msg,
          text: combinedText,
          caption: undefined,
          caption_entities: undefined,
          entities: undefined,
          date: last.msg.date ?? first.msg.date,
        };
        const messageIdOverride = last.msg.message_id ? String(last.msg.message_id) : undefined;
        await processMessage(
          { message: syntheticMessage, me: baseCtx.me, getFile },
          [],
          first.storeAllowFrom,
          messageIdOverride ? { messageIdOverride } : undefined,
        );
        resolveAll();
      } catch (err) {
        rejectAll(err);
        runtime.error?.(danger(`telegram debounce flush failed: ${String(err)}`));
      }
    },
    onError: (err, entries) => {
      for (const entry of entries) {
        entry.done.reject(err);
      }
      runtime.error?.(danger(`telegram debounce flush failed: ${String(err)}`));
    },
  });

  const resolveTelegramSessionModel = (params: {
    chatId: number | string;
    isGroup: boolean;
    isForum: boolean;
    messageThreadId?: number;
    resolvedThreadId?: number;
  }): string | undefined => {
    const resolvedThreadId =
      params.resolvedThreadId ??
      resolveTelegramForumThreadId({
        isForum: params.isForum,
        messageThreadId: params.messageThreadId,
      });
    const peerId = params.isGroup
      ? buildTelegramGroupPeerId(params.chatId, resolvedThreadId)
      : String(params.chatId);
    const parentPeer = buildTelegramParentPeer({
      isGroup: params.isGroup,
      resolvedThreadId,
      chatId: params.chatId,
    });
    const route = resolveAgentRoute({
      cfg,
      channel: "telegram",
      accountId,
      peer: {
        kind: params.isGroup ? "group" : "direct",
        id: peerId,
      },
      parentPeer,
    });
    const baseSessionKey = route.sessionKey;
    const dmThreadId = !params.isGroup ? params.messageThreadId : undefined;
    const threadKeys =
      dmThreadId != null
        ? resolveThreadSessionKeys({ baseSessionKey, threadId: String(dmThreadId) })
        : null;
    const sessionKey = threadKeys?.sessionKey ?? baseSessionKey;
    const storePath = resolveStorePath(cfg.session?.store, { agentId: route.agentId });
    const store = loadSessionStore(storePath);
    const entry = store[sessionKey];
    const storedOverride = resolveStoredModelOverride({
      sessionEntry: entry,
      sessionStore: store,
      sessionKey,
    });
    if (storedOverride) {
      return storedOverride.provider
        ? `${storedOverride.provider}/${storedOverride.model}`
        : storedOverride.model;
    }
    const provider = entry?.modelProvider?.trim();
    const model = entry?.model?.trim();
    if (provider && model) {
      return `${provider}/${model}`;
    }
    const modelCfg = cfg.agents?.defaults?.model;
    return typeof modelCfg === "string" ? modelCfg : modelCfg?.primary;
  };

  const processMediaGroup = async (entry: MediaGroupEntry) => {
    const settleOk = () => {
      for (const msg of entry.messages) {
        msg.done.resolve();
      }
    };

    const settleErr = (err: unknown) => {
      for (const msg of entry.messages) {
        msg.done.reject(err);
      }
    };

    try {
      entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);

      const captionMsg = entry.messages.find((m) => m.msg.caption || m.msg.text);
      const primaryEntry = captionMsg ?? entry.messages[0];

      const allMedia: TelegramMediaRef[] = [];
      for (const { ctx } of entry.messages) {
        const media = await resolveMedia(ctx, mediaMaxBytes, opts.token, opts.proxyFetch);
        if (media) {
          allMedia.push({
            path: media.path,
            contentType: media.contentType,
            stickerMetadata: media.stickerMetadata,
          });
        }
      }

      const storeAllowFrom = await readChannelAllowFromStore("telegram").catch(() => []);
      await processMessage(primaryEntry.ctx, allMedia, storeAllowFrom);
      settleOk();
    } catch (err) {
      const primary = entry.messages[0];
      logger.error(
        {
          phase: "inbound.media_group",
          updateId: primary ? resolveTelegramUpdateId(primary.ctx) : undefined,
          chatId: primary?.msg.chat.id,
          messageId: primary?.msg.message_id,
          mediaGroupId: primary?.msg.media_group_id,
          error: formatErrorMessage(err),
        },
        "telegram media group handler failed",
      );
      settleErr(err);
    }
  };

  const flushTextFragments = async (entry: TextFragmentEntry) => {
    const settleOk = () => {
      for (const msg of entry.messages) {
        msg.done.resolve();
      }
    };

    const settleErr = (err: unknown) => {
      for (const msg of entry.messages) {
        msg.done.reject(err);
      }
    };

    try {
      entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);

      const first = entry.messages[0];
      const last = entry.messages.at(-1);
      if (!first || !last) {
        settleOk();
        return;
      }

      const combinedText = entry.messages.map((m) => m.msg.text ?? "").join("");
      if (!combinedText.trim()) {
        settleOk();
        return;
      }

      const syntheticMessage: Message = {
        ...first.msg,
        text: combinedText,
        caption: undefined,
        caption_entities: undefined,
        entities: undefined,
        date: last.msg.date ?? first.msg.date,
      };

      const storeAllowFrom = await readChannelAllowFromStore("telegram").catch(() => []);
      const baseCtx = first.ctx;
      const getFile =
        typeof baseCtx.getFile === "function" ? baseCtx.getFile.bind(baseCtx) : async () => ({});

      await processMessage(
        { message: syntheticMessage, me: baseCtx.me, getFile },
        [],
        storeAllowFrom,
        { messageIdOverride: String(last.msg.message_id) },
      );
      settleOk();
    } catch (err) {
      const primary = entry.messages[0];
      logger.error(
        {
          phase: "inbound.text_fragments",
          updateId: primary ? resolveTelegramUpdateId(primary.ctx) : undefined,
          chatId: primary?.msg.chat.id,
          messageId: primary?.msg.message_id,
          bufferKey: entry.key,
          parts: entry.messages.length,
          error: formatErrorMessage(err),
        },
        "telegram text fragment handler failed",
      );
      settleErr(err);
    }
  };

  const scheduleTextFragmentFlush = (entry: TextFragmentEntry) => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(async () => {
      textFragmentBuffer.delete(entry.key);
      textFragmentProcessing = textFragmentProcessing
        .then(async () => {
          await flushTextFragments(entry);
        })
        .catch((err) => {
          // R1-06: Log escaped text fragment flush errors instead of silently swallowing.
          // Individual defers are already settled by flushTextFragments; this catches
          // only unexpected errors that escape the inner try/catch.
          logger.error(
            {
              phase: "inbound.text_fragments.chain",
              bufferKey: entry.key,
              parts: entry.messages.length,
              updateIds: entry.messages.map((m) => resolveTelegramUpdateId(m.ctx)),
              error: formatErrorMessage(err),
            },
            "text fragment processing chain error",
          );
        });
      await textFragmentProcessing;
    }, TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS);
  };

  bot.on("callback_query", async (ctx) => {
    const callback = ctx.callbackQuery;
    if (!callback) {
      return;
    }
    if (shouldSkipUpdate(ctx)) {
      return;
    }
    // R1-07: Attach completion defer so offset middleware waits for async processing.
    const done = createDeferred();
    setTelegramUpdateCompletionDefer(ctx, done.promise);

    let completionSettled = false;
    const resolveCompletionOnce = () => {
      if (completionSettled) {
        return;
      }
      completionSettled = true;
      done.resolve();
    };
    const rejectCompletionOnce = (err: unknown) => {
      if (completionSettled) {
        return;
      }
      completionSettled = true;
      done.reject(err);
    };

    // Answer immediately to prevent Telegram from retrying while we process
    await withTelegramApiErrorLogging({
      operation: "answerCallbackQuery",
      runtime,
      fn: () => bot.api.answerCallbackQuery(callback.id),
    }).catch(() => {});
    try {
      const data = (callback.data ?? "").trim();
      const callbackMessage = callback.message;
      if (!data || !callbackMessage) {
        return;
      }

      const inlineButtonsScope = resolveTelegramInlineButtonsScope({
        cfg,
        accountId,
      });
      if (inlineButtonsScope === "off") {
        return;
      }

      const chatId = callbackMessage.chat.id;
      const isGroup =
        callbackMessage.chat.type === "group" || callbackMessage.chat.type === "supergroup";
      if (inlineButtonsScope === "dm" && isGroup) {
        return;
      }
      if (inlineButtonsScope === "group" && !isGroup) {
        return;
      }

      const messageThreadId = callbackMessage.message_thread_id;
      const isForum = callbackMessage.chat.is_forum === true;
      const resolvedThreadId = resolveTelegramForumThreadId({
        isForum,
        messageThreadId,
      });
      const { groupConfig, topicConfig } = resolveTelegramGroupConfig(chatId, resolvedThreadId);
      const storeAllowFrom = await readChannelAllowFromStore("telegram").catch(() => []);
      const groupAllowOverride = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
      const effectiveGroupAllow = normalizeAllowFromWithStore({
        allowFrom: groupAllowOverride ?? groupAllowFrom,
        storeAllowFrom,
      });
      const effectiveDmAllow = normalizeAllowFromWithStore({
        allowFrom: telegramCfg.allowFrom,
        storeAllowFrom,
      });
      const dmPolicy = telegramCfg.dmPolicy ?? "pairing";
      const senderId = callback.from?.id ? String(callback.from.id) : "";
      const senderUsername = callback.from?.username ?? "";

      if (isGroup) {
        if (groupConfig?.enabled === false) {
          logVerbose(`Blocked telegram group ${chatId} (group disabled)`);
          return;
        }
        if (topicConfig?.enabled === false) {
          logVerbose(
            `Blocked telegram topic ${chatId} (${resolvedThreadId ?? "unknown"}) (topic disabled)`,
          );
          return;
        }
        if (typeof groupAllowOverride !== "undefined") {
          const allowed =
            senderId &&
            isSenderAllowed({
              allow: effectiveGroupAllow,
              senderId,
              senderUsername,
            });
          if (!allowed) {
            logVerbose(
              `Blocked telegram group sender ${senderId || "unknown"} (group allowFrom override)`,
            );
            return;
          }
        }
        const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
        const groupPolicy = firstDefined(
          topicConfig?.groupPolicy,
          groupConfig?.groupPolicy,
          telegramCfg.groupPolicy,
          defaultGroupPolicy,
          "open",
        );
        if (groupPolicy === "disabled") {
          logVerbose(`Blocked telegram group message (groupPolicy: disabled)`);
          return;
        }
        if (groupPolicy === "allowlist") {
          if (!senderId) {
            logVerbose(`Blocked telegram group message (no sender ID, groupPolicy: allowlist)`);
            return;
          }
          if (!effectiveGroupAllow.hasEntries) {
            logVerbose(
              "Blocked telegram group message (groupPolicy: allowlist, no group allowlist entries)",
            );
            return;
          }
          if (
            !isSenderAllowed({
              allow: effectiveGroupAllow,
              senderId,
              senderUsername,
            })
          ) {
            logVerbose(`Blocked telegram group message from ${senderId} (groupPolicy: allowlist)`);
            return;
          }
        }
        const groupAllowlist = resolveGroupPolicy(chatId);
        if (groupAllowlist.allowlistEnabled && !groupAllowlist.allowed) {
          logger.info(
            { chatId, title: callbackMessage.chat.title, reason: "not-allowed" },
            "skipping group message",
          );
          return;
        }
      }

      if (inlineButtonsScope === "allowlist") {
        if (!isGroup) {
          if (dmPolicy === "disabled") {
            return;
          }
          if (dmPolicy !== "open") {
            const allowed =
              effectiveDmAllow.hasWildcard ||
              (effectiveDmAllow.hasEntries &&
                isSenderAllowed({
                  allow: effectiveDmAllow,
                  senderId,
                  senderUsername,
                }));
            if (!allowed) {
              return;
            }
          }
        } else {
          const allowed =
            effectiveGroupAllow.hasWildcard ||
            (effectiveGroupAllow.hasEntries &&
              isSenderAllowed({
                allow: effectiveGroupAllow,
                senderId,
                senderUsername,
              }));
          if (!allowed) {
            return;
          }
        }
      }

      const paginationMatch = data.match(/^commands_page_(\d+|noop)(?::(.+))?$/);
      if (paginationMatch) {
        const pageValue = paginationMatch[1];
        if (pageValue === "noop") {
          return;
        }

        const page = Number.parseInt(pageValue, 10);
        if (Number.isNaN(page) || page < 1) {
          return;
        }

        const agentId = paginationMatch[2]?.trim() || resolveDefaultAgentId(cfg) || undefined;
        const skillCommands = listSkillCommandsForAgents({
          cfg,
          agentIds: agentId ? [agentId] : undefined,
        });
        const result = buildCommandsMessagePaginated(cfg, skillCommands, {
          page,
          surface: "telegram",
        });

        const keyboard =
          result.totalPages > 1
            ? buildInlineKeyboard(
                buildCommandsPaginationKeyboard(result.currentPage, result.totalPages, agentId),
              )
            : undefined;

        try {
          await bot.api.editMessageText(
            callbackMessage.chat.id,
            callbackMessage.message_id,
            result.text,
            keyboard ? { reply_markup: keyboard } : undefined,
          );
        } catch (editErr) {
          const errStr = String(editErr);
          if (!errStr.includes("message is not modified")) {
            throw editErr;
          }
        }
        return;
      }

      // Model selection callback handler (mdl_prov, mdl_list_*, mdl_sel_*, mdl_back)
      const modelCallback = parseModelCallbackData(data);
      if (modelCallback) {
        const modelData = await buildModelsProviderData(cfg);
        const { byProvider, providers } = modelData;

        const editMessageWithButtons = async (
          text: string,
          buttons: ReturnType<typeof buildProviderKeyboard>,
        ) => {
          const keyboard = buildInlineKeyboard(buttons);
          try {
            await bot.api.editMessageText(
              callbackMessage.chat.id,
              callbackMessage.message_id,
              text,
              keyboard ? { reply_markup: keyboard } : undefined,
            );
          } catch (editErr) {
            const errStr = String(editErr);
            if (errStr.includes("no text in the message")) {
              try {
                await bot.api.deleteMessage(callbackMessage.chat.id, callbackMessage.message_id);
              } catch {}
              await bot.api.sendMessage(
                callbackMessage.chat.id,
                text,
                keyboard ? { reply_markup: keyboard } : undefined,
              );
            } else if (!errStr.includes("message is not modified")) {
              throw editErr;
            }
          }
        };

        if (modelCallback.type === "providers" || modelCallback.type === "back") {
          if (providers.length === 0) {
            await editMessageWithButtons("No providers available.", []);
            return;
          }
          const providerInfos: ProviderInfo[] = providers.map((p) => ({
            id: p,
            count: byProvider.get(p)?.size ?? 0,
          }));
          const buttons = buildProviderKeyboard(providerInfos);
          await editMessageWithButtons("Select a provider:", buttons);
          return;
        }

        if (modelCallback.type === "list") {
          const { provider, page } = modelCallback;
          const modelSet = byProvider.get(provider);
          if (!modelSet || modelSet.size === 0) {
            // Provider not found or no models - show providers list
            const providerInfos: ProviderInfo[] = providers.map((p) => ({
              id: p,
              count: byProvider.get(p)?.size ?? 0,
            }));
            const buttons = buildProviderKeyboard(providerInfos);
            await editMessageWithButtons(
              `Unknown provider: ${provider}\n\nSelect a provider:`,
              buttons,
            );
            return;
          }
          const models = [...modelSet].toSorted();
          const pageSize = getModelsPageSize();
          const totalPages = calculateTotalPages(models.length, pageSize);
          const safePage = Math.max(1, Math.min(page, totalPages));

          // Resolve current model from session (prefer overrides)
          const currentModel = resolveTelegramSessionModel({
            chatId,
            isGroup,
            isForum,
            messageThreadId,
            resolvedThreadId,
          });

          const buttons = buildModelsKeyboard({
            provider,
            models,
            currentModel,
            currentPage: safePage,
            totalPages,
            pageSize,
          });
          const text = `Models (${provider}) — ${models.length} available`;
          await editMessageWithButtons(text, buttons);
          return;
        }

        if (modelCallback.type === "select") {
          const { provider, model } = modelCallback;
          // Process model selection as a synthetic message with /model command
          const syntheticMessage: Message = {
            ...callbackMessage,
            from: callback.from,
            text: `/model ${provider}/${model}`,
            caption: undefined,
            caption_entities: undefined,
            entities: undefined,
          };
          const getFile =
            typeof ctx.getFile === "function" ? ctx.getFile.bind(ctx) : async () => ({});
          await processMessage(
            { message: syntheticMessage, me: ctx.me, getFile },
            [],
            storeAllowFrom,
            {
              forceWasMentioned: true,
              messageIdOverride: callback.id,
            },
          );
          return;
        }

        return;
      }

      const syntheticMessage: Message = {
        ...callbackMessage,
        from: callback.from,
        text: data,
        caption: undefined,
        caption_entities: undefined,
        entities: undefined,
      };
      const getFile = typeof ctx.getFile === "function" ? ctx.getFile.bind(ctx) : async () => ({});
      await processMessage({ message: syntheticMessage, me: ctx.me, getFile }, [], storeAllowFrom, {
        forceWasMentioned: true,
        messageIdOverride: callback.id,
      });
    } catch (err) {
      rejectCompletionOnce(err);
      const callback = ctx.callbackQuery;
      const msg = callback?.message;
      logger.error(
        {
          phase: "inbound.callback_query",
          updateId: resolveTelegramUpdateId(ctx),
          chatId: msg?.chat.id,
          messageId: msg?.message_id,
          callbackId: callback?.id,
          error: formatErrorMessage(err),
        },
        "telegram callback handler failed",
      );
      return;
    } finally {
      resolveCompletionOnce();
    }
  });

  // Handle group migration to supergroup (chat ID changes)
  bot.on("message:migrate_to_chat_id", async (ctx) => {
    try {
      const msg = ctx.message;
      if (!msg?.migrate_to_chat_id) {
        return;
      }
      if (shouldSkipUpdate(ctx)) {
        return;
      }

      const oldChatId = String(msg.chat.id);
      const newChatId = String(msg.migrate_to_chat_id);
      const chatTitle = msg.chat.title ?? "Unknown";

      runtime.log?.(warn(`[telegram] Group migrated: "${chatTitle}" ${oldChatId} → ${newChatId}`));

      if (!resolveChannelConfigWrites({ cfg, channelId: "telegram", accountId })) {
        runtime.log?.(warn("[telegram] Config writes disabled; skipping group config migration."));
        return;
      }

      // Check if old chat ID has config and migrate it
      const currentConfig = loadConfig();
      const migration = migrateTelegramGroupConfig({
        cfg: currentConfig,
        accountId,
        oldChatId,
        newChatId,
      });

      if (migration.migrated) {
        runtime.log?.(warn(`[telegram] Migrating group config from ${oldChatId} to ${newChatId}`));
        migrateTelegramGroupConfig({ cfg, accountId, oldChatId, newChatId });
        await writeConfigFile(currentConfig);
        runtime.log?.(warn(`[telegram] Group config migrated and saved successfully`));
      } else if (migration.skippedExisting) {
        runtime.log?.(
          warn(
            `[telegram] Group config already exists for ${newChatId}; leaving ${oldChatId} unchanged`,
          ),
        );
      } else {
        runtime.log?.(
          warn(`[telegram] No config found for old group ID ${oldChatId}, migration logged only`),
        );
      }
    } catch (err) {
      const msg = ctx.message;
      logger.error(
        {
          phase: "inbound.group_migration",
          updateId: resolveTelegramUpdateId(ctx),
          chatId: msg?.chat.id,
          messageId: msg?.message_id,
          error: formatErrorMessage(err),
        },
        "telegram group migration handler failed",
      );
    }
  });

  bot.on("message", async (ctx) => {
    try {
      const msg = ctx.message;
      if (!msg) {
        return;
      }
      if (shouldSkipUpdate(ctx)) {
        return;
      }

      const chatId = msg.chat.id;
      const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
      const messageThreadId = msg.message_thread_id;
      const isForum = msg.chat.is_forum === true;
      const resolvedThreadId = resolveTelegramForumThreadId({
        isForum,
        messageThreadId,
      });
      const storeAllowFrom = await readChannelAllowFromStore("telegram").catch(() => []);
      const { groupConfig, topicConfig } = resolveTelegramGroupConfig(chatId, resolvedThreadId);
      const groupAllowOverride = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
      const effectiveGroupAllow = normalizeAllowFromWithStore({
        allowFrom: groupAllowOverride ?? groupAllowFrom,
        storeAllowFrom,
      });
      const hasGroupAllowOverride = typeof groupAllowOverride !== "undefined";

      if (isGroup) {
        if (groupConfig?.enabled === false) {
          logVerbose(`Blocked telegram group ${chatId} (group disabled)`);
          return;
        }
        if (topicConfig?.enabled === false) {
          logVerbose(
            `Blocked telegram topic ${chatId} (${resolvedThreadId ?? "unknown"}) (topic disabled)`,
          );
          return;
        }
        if (hasGroupAllowOverride) {
          const senderId = msg.from?.id;
          const senderUsername = msg.from?.username ?? "";
          const allowed =
            senderId != null &&
            isSenderAllowed({
              allow: effectiveGroupAllow,
              senderId: String(senderId),
              senderUsername,
            });
          if (!allowed) {
            logVerbose(
              `Blocked telegram group sender ${senderId ?? "unknown"} (group allowFrom override)`,
            );
            return;
          }
        }
        // Group policy filtering: controls how group messages are handled
        // - "open": groups bypass allowFrom, only mention-gating applies
        // - "disabled": block all group messages entirely
        // - "allowlist": only allow group messages from senders in groupAllowFrom/allowFrom
        const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
        const groupPolicy = firstDefined(
          topicConfig?.groupPolicy,
          groupConfig?.groupPolicy,
          telegramCfg.groupPolicy,
          defaultGroupPolicy,
          "open",
        );
        if (groupPolicy === "disabled") {
          logVerbose(`Blocked telegram group message (groupPolicy: disabled)`);
          return;
        }
        if (groupPolicy === "allowlist") {
          // For allowlist mode, the sender (msg.from.id) must be in allowFrom
          const senderId = msg.from?.id;
          if (senderId == null) {
            logVerbose(`Blocked telegram group message (no sender ID, groupPolicy: allowlist)`);
            return;
          }
          if (!effectiveGroupAllow.hasEntries) {
            logVerbose(
              "Blocked telegram group message (groupPolicy: allowlist, no group allowlist entries)",
            );
            return;
          }
          const senderUsername = msg.from?.username ?? "";
          if (
            !isSenderAllowed({
              allow: effectiveGroupAllow,
              senderId: String(senderId),
              senderUsername,
            })
          ) {
            logVerbose(`Blocked telegram group message from ${senderId} (groupPolicy: allowlist)`);
            return;
          }
        }

        // Group allowlist based on configured group IDs.
        const groupAllowlist = resolveGroupPolicy(chatId);
        if (groupAllowlist.allowlistEnabled && !groupAllowlist.allowed) {
          logger.info(
            { chatId, title: msg.chat.title, reason: "not-allowed" },
            "skipping group message",
          );
          return;
        }
      }

      // Text fragment handling - Telegram splits long pastes into multiple inbound messages (~4096 chars).
      // We buffer “near-limit” messages and append immediately-following parts.
      const text = typeof msg.text === "string" ? msg.text : undefined;
      const isCommandLike = (text ?? "").trim().startsWith("/");
      if (text && !isCommandLike) {
        const nowMs = Date.now();
        const senderId = msg.from?.id != null ? String(msg.from.id) : "unknown";
        const key = `text:${chatId}:${resolvedThreadId ?? "main"}:${senderId}`;
        const existing = textFragmentBuffer.get(key);

        if (existing) {
          const last = existing.messages.at(-1);
          const lastMsgId = last?.msg.message_id;
          const lastReceivedAtMs = last?.receivedAtMs ?? nowMs;
          const idGap = typeof lastMsgId === "number" ? msg.message_id - lastMsgId : Infinity;
          const timeGapMs = nowMs - lastReceivedAtMs;
          const canAppend =
            idGap > 0 &&
            idGap <= TELEGRAM_TEXT_FRAGMENT_MAX_ID_GAP &&
            timeGapMs >= 0 &&
            timeGapMs <= TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS;

          if (canAppend) {
            const currentTotalChars = existing.messages.reduce(
              (sum, m) => sum + (m.msg.text?.length ?? 0),
              0,
            );
            const nextTotalChars = currentTotalChars + text.length;
            if (
              existing.messages.length + 1 <= TELEGRAM_TEXT_FRAGMENT_MAX_PARTS &&
              nextTotalChars <= TELEGRAM_TEXT_FRAGMENT_MAX_TOTAL_CHARS
            ) {
              const fragmentDone = createDeferred();
              existing.messages.push({ msg, ctx, receivedAtMs: nowMs, done: fragmentDone });
              setTelegramUpdateCompletionDefer(ctx, fragmentDone.promise);
              scheduleTextFragmentFlush(existing);
              return;
            }
          }

          // Not appendable (or limits exceeded): flush buffered entry first, then continue normally.
          clearTimeout(existing.timer);
          textFragmentBuffer.delete(key);
          textFragmentProcessing = textFragmentProcessing
            .then(async () => {
              await flushTextFragments(existing);
            })
            .catch((err) => {
              // R1-06: Log escaped flush errors; defers already settled inside flushTextFragments.
              logger.error(
                {
                  phase: "inbound.text_fragments.chain",
                  bufferKey: existing.key,
                  parts: existing.messages.length,
                  error: formatErrorMessage(err),
                },
                "text fragment processing chain error",
              );
            });
          await textFragmentProcessing;
        }

        const shouldStart = text.length >= TELEGRAM_TEXT_FRAGMENT_START_THRESHOLD_CHARS;
        if (shouldStart) {
          const fragmentDone = createDeferred();
          setTelegramUpdateCompletionDefer(ctx, fragmentDone.promise);
          const entry: TextFragmentEntry = {
            key,
            messages: [{ msg, ctx, receivedAtMs: nowMs, done: fragmentDone }],
            timer: setTimeout(() => {}, TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS),
          };
          textFragmentBuffer.set(key, entry);
          scheduleTextFragmentFlush(entry);
          return;
        }
      }

      // Media group handling - buffer multi-image messages
      const mediaGroupId = msg.media_group_id;
      if (mediaGroupId) {
        const existing = mediaGroupBuffer.get(mediaGroupId);
        if (existing) {
          clearTimeout(existing.timer);
          const mediaDone = createDeferred();
          existing.messages.push({ msg, ctx, done: mediaDone });
          setTelegramUpdateCompletionDefer(ctx, mediaDone.promise);
          existing.timer = setTimeout(async () => {
            mediaGroupBuffer.delete(mediaGroupId);
            mediaGroupProcessing = mediaGroupProcessing
              .then(async () => {
                await processMediaGroup(existing);
              })
              .catch((err) => {
                // R1-05: Log escaped media group flush errors; defers already settled inside processMediaGroup.
                logger.error(
                  {
                    phase: "inbound.media_group.chain",
                    mediaGroupId,
                    parts: existing.messages.length,
                    updateIds: existing.messages.map((m) => resolveTelegramUpdateId(m.ctx)),
                    error: formatErrorMessage(err),
                  },
                  "media group processing chain error",
                );
              });
            await mediaGroupProcessing;
          }, MEDIA_GROUP_TIMEOUT_MS);
        } else {
          const mediaDone = createDeferred();
          setTelegramUpdateCompletionDefer(ctx, mediaDone.promise);
          const entry: MediaGroupEntry = {
            messages: [{ msg, ctx, done: mediaDone }],
            timer: setTimeout(async () => {
              mediaGroupBuffer.delete(mediaGroupId);
              mediaGroupProcessing = mediaGroupProcessing
                .then(async () => {
                  await processMediaGroup(entry);
                })
                .catch((err) => {
                  // R1-05: Log escaped media group flush errors; defers already settled inside processMediaGroup.
                  logger.error(
                    {
                      phase: "inbound.media_group.chain",
                      mediaGroupId,
                      parts: entry.messages.length,
                      updateIds: entry.messages.map((m) => resolveTelegramUpdateId(m.ctx)),
                      error: formatErrorMessage(err),
                    },
                    "media group processing chain error",
                  );
                });
              await mediaGroupProcessing;
            }, MEDIA_GROUP_TIMEOUT_MS),
          };
          mediaGroupBuffer.set(mediaGroupId, entry);
        }
        return;
      }

      let media: Awaited<ReturnType<typeof resolveMedia>> = null;
      try {
        media = await resolveMedia(ctx, mediaMaxBytes, opts.token, opts.proxyFetch);
      } catch (mediaErr) {
        const errMsg = String(mediaErr);
        if (errMsg.includes("exceeds") && errMsg.includes("MB limit")) {
          const limitMb = Math.round(mediaMaxBytes / (1024 * 1024));
          await withTelegramApiErrorLogging({
            operation: "sendMessage",
            runtime,
            fn: () =>
              bot.api.sendMessage(chatId, `⚠️ File too large. Maximum size is ${limitMb}MB.`, {
                reply_to_message_id: msg.message_id,
              }),
          }).catch(() => {});
          logger.warn({ chatId, error: errMsg }, "media exceeds size limit");
          return;
        }
        throw mediaErr;
      }

      // Skip sticker-only messages where the sticker was skipped (animated/video)
      // These have no media and no text content to process.
      const hasText = Boolean((msg.text ?? msg.caption ?? "").trim());
      if (msg.sticker && !media && !hasText) {
        logVerbose("telegram: skipping sticker-only message (unsupported sticker type)");
        return;
      }

      const allMedia = media
        ? [
            {
              path: media.path,
              contentType: media.contentType,
              stickerMetadata: media.stickerMetadata,
            },
          ]
        : [];
      const senderId = msg.from?.id ? String(msg.from.id) : "";
      const conversationKey =
        resolvedThreadId != null ? `${chatId}:topic:${resolvedThreadId}` : String(chatId);
      const debounceKey = senderId
        ? `telegram:${accountId ?? "default"}:${conversationKey}:${senderId}`
        : null;
      const done = createDeferred();
      setTelegramUpdateCompletionDefer(ctx, done.promise);
      try {
        await inboundDebouncer.enqueue({
          ctx,
          msg,
          allMedia,
          storeAllowFrom,
          debounceKey,
          botUsername: ctx.me?.username,
          done,
        });
      } catch (err) {
        done.reject(err);
        throw err;
      }
    } catch (err) {
      const msg = ctx.message;
      logger.error(
        {
          phase: "inbound.message",
          updateId: resolveTelegramUpdateId(ctx),
          chatId: msg?.chat.id,
          messageId: msg?.message_id,
          mediaGroupId: msg?.media_group_id,
          error: formatErrorMessage(err),
        },
        "telegram message handler failed",
      );
      runtime.error?.(danger(`handler failed: ${formatErrorMessage(err)}`));
    }
  });
};
