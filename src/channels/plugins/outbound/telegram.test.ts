import { describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../../auto-reply/types.js";
import { markdownToTelegramHtml } from "../../../telegram/format.js";
import { telegramOutbound } from "./telegram.js";

describe("telegramOutbound", () => {
  it("passes parsed reply/thread ids for sendText", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "tg-text-1", chatId: "123" });
    const sendText = telegramOutbound.sendText;
    expect(sendText).toBeDefined();

    const result = await sendText!({
      cfg: {},
      to: "123",
      text: "<b>hello</b>",
      accountId: "work",
      replyToId: "44",
      threadId: "55",
      deps: { sendTelegram },
    });

    expect(sendTelegram).toHaveBeenCalledWith(
      "123",
      "<b>hello</b>",
      expect.objectContaining({
        textMode: "html",
        verbose: false,
        accountId: "work",
        replyToMessageId: 44,
        messageThreadId: 55,
      }),
    );
    expect(result).toEqual({ channel: "telegram", messageId: "tg-text-1", chatId: "123" });
  });

  it("parses scoped DM thread ids for sendText", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "tg-text-2", chatId: "12345" });
    const sendText = telegramOutbound.sendText;
    expect(sendText).toBeDefined();

    await sendText!({
      cfg: {},
      to: "12345",
      text: "<b>hello</b>",
      accountId: "work",
      threadId: "12345:99",
      deps: { sendTelegram },
    });

    expect(sendTelegram).toHaveBeenCalledWith(
      "12345",
      "<b>hello</b>",
      expect.objectContaining({
        textMode: "html",
        verbose: false,
        accountId: "work",
        messageThreadId: 99,
      }),
    );
  });

  it("renders markdown captions before sendMedia", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "tg-media-1", chatId: "123" });
    const sendMedia = telegramOutbound.sendMedia;
    expect(sendMedia).toBeDefined();

    const caption = "See `README.md`\n- bullet\n> quote";

    const result = await sendMedia!({
      cfg: {},
      to: "123",
      text: caption,
      mediaUrl: "https://example.com/a.jpg",
      mediaLocalRoots: ["/tmp/media"],
      accountId: "default",
      deps: { sendTelegram },
    });

    expect(sendTelegram).toHaveBeenCalledWith(
      "123",
      markdownToTelegramHtml(caption),
      expect.objectContaining({
        textMode: "html",
        verbose: false,
        mediaUrl: "https://example.com/a.jpg",
        mediaLocalRoots: ["/tmp/media"],
      }),
    );
    expect(result).toEqual({ channel: "telegram", messageId: "tg-media-1", chatId: "123" });
  });

  it("renders markdown payload text before sendPayload with buttons", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "tg-payload-1", chatId: "123" });
    const sendPayload = telegramOutbound.sendPayload;
    expect(sendPayload).toBeDefined();

    const text = "Check `README.md`\n- bullet\n> quote";
    const payload: ReplyPayload = {
      text,
      channelData: {
        telegram: {
          buttons: [[{ text: "Approve", callback_data: "ok" }]],
        },
      },
    };

    await sendPayload!({
      cfg: {},
      to: "123",
      text: "",
      payload,
      accountId: "default",
      deps: { sendTelegram },
    });

    expect(sendTelegram).toHaveBeenCalledWith(
      "123",
      markdownToTelegramHtml(text),
      expect.objectContaining({
        textMode: "html",
        accountId: "default",
        buttons: [[{ text: "Approve", callback_data: "ok" }]],
      }),
    );
  });

  it("sends payload media list and applies buttons only to first message", async () => {
    const sendTelegram = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "tg-1", chatId: "123" })
      .mockResolvedValueOnce({ messageId: "tg-2", chatId: "123" });
    const sendPayload = telegramOutbound.sendPayload;
    expect(sendPayload).toBeDefined();

    const caption = "caption `README.md`";
    const payload: ReplyPayload = {
      text: caption,
      mediaUrls: ["https://example.com/1.jpg", "https://example.com/2.jpg"],
      channelData: {
        telegram: {
          quoteText: "quoted",
          buttons: [[{ text: "Approve", callback_data: "ok" }]],
        },
      },
    };

    const result = await sendPayload!({
      cfg: {},
      to: "123",
      text: "",
      payload,
      mediaLocalRoots: ["/tmp/media"],
      accountId: "default",
      deps: { sendTelegram },
    });

    expect(sendTelegram).toHaveBeenCalledTimes(2);
    expect(sendTelegram).toHaveBeenNthCalledWith(
      1,
      "123",
      markdownToTelegramHtml(caption),
      expect.objectContaining({
        mediaUrl: "https://example.com/1.jpg",
        quoteText: "quoted",
        buttons: [[{ text: "Approve", callback_data: "ok" }]],
      }),
    );
    expect(sendTelegram).toHaveBeenNthCalledWith(
      2,
      "123",
      "",
      expect.objectContaining({
        mediaUrl: "https://example.com/2.jpg",
        quoteText: "quoted",
      }),
    );
    const secondCallOpts = sendTelegram.mock.calls[1]?.[2] as Record<string, unknown>;
    expect(secondCallOpts?.buttons).toBeUndefined();
    expect(result).toEqual({ channel: "telegram", messageId: "tg-2", chatId: "123" });
  });
});
