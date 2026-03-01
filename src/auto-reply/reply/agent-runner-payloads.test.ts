import { describe, expect, it } from "vitest";
import { buildReplyPayloads } from "./agent-runner-payloads.js";

const baseParams = {
  isHeartbeat: false,
  didLogHeartbeatStrip: false,
  blockStreamingEnabled: false,
  blockReplyPipeline: null,
  replyToMode: "off" as const,
};

describe("buildReplyPayloads media filter integration", () => {
  it("drops low-value placeholder text payloads with no media", () => {
    const { replyPayloads } = buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "answer for user question" }],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("strips placeholder prefix and keeps substantive text", () => {
    const { replyPayloads } = buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "answer for user question\n\n正常内容" }],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.text).toBe("正常内容");
  });

  it("strips placeholder prefix case-insensitively", () => {
    const { replyPayloads } = buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "Answer For User Question\n\n内容" }],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.text).toBe("内容");
  });

  it("does not strip substantive same-line text that starts with the placeholder phrase", () => {
    const text = "answer for user question about billing details";
    const { replyPayloads } = buildReplyPayloads({
      ...baseParams,
      payloads: [{ text }],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.text).toBe(text);
  });

  it("treats punctuation-only placeholder variants as empty text", () => {
    const { replyPayloads } = buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "answer for user question.", mediaUrl: "file:///tmp/photo.jpg" }],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.text).toBeUndefined();
    expect(replyPayloads[0]?.mediaUrl).toBe("file:///tmp/photo.jpg");
  });

  it("keeps media-only payloads when text is low-value placeholder", () => {
    const { replyPayloads } = buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "answer for user question", mediaUrl: "file:///tmp/photo.jpg" }],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.text).toBeUndefined();
    expect(replyPayloads[0]?.mediaUrl).toBe("file:///tmp/photo.jpg");
  });

  it("strips media URL from payload when in messagingToolSentMediaUrls", () => {
    const { replyPayloads } = buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "hello", mediaUrl: "file:///tmp/photo.jpg" }],
      messagingToolSentMediaUrls: ["file:///tmp/photo.jpg"],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0].mediaUrl).toBeUndefined();
  });

  it("preserves media URL when not in messagingToolSentMediaUrls", () => {
    const { replyPayloads } = buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "hello", mediaUrl: "file:///tmp/photo.jpg" }],
      messagingToolSentMediaUrls: ["file:///tmp/other.jpg"],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0].mediaUrl).toBe("file:///tmp/photo.jpg");
  });

  it("applies media filter after text filter", () => {
    const { replyPayloads } = buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "hello world!", mediaUrl: "file:///tmp/photo.jpg" }],
      messagingToolSentTexts: ["hello world!"],
      messagingToolSentMediaUrls: ["file:///tmp/photo.jpg"],
    });

    // Text filter removes the payload entirely (text matched), so nothing remains.
    expect(replyPayloads).toHaveLength(0);
  });

  it("does not dedupe text for cross-target messaging sends", () => {
    const { replyPayloads } = buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "hello world!" }],
      messageProvider: "telegram",
      originatingTo: "telegram:123",
      messagingToolSentTexts: ["hello world!"],
      messagingToolSentTargets: [{ tool: "discord", provider: "discord", to: "channel:C1" }],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.text).toBe("hello world!");
  });

  it("does not dedupe media for cross-target messaging sends", () => {
    const { replyPayloads } = buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "photo", mediaUrl: "file:///tmp/photo.jpg" }],
      messageProvider: "telegram",
      originatingTo: "telegram:123",
      messagingToolSentMediaUrls: ["file:///tmp/photo.jpg"],
      messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.mediaUrl).toBe("file:///tmp/photo.jpg");
  });

  it("suppresses same-target replies when messageProvider is synthetic but originatingChannel is set", () => {
    const { replyPayloads } = buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "hello world!" }],
      messageProvider: "heartbeat",
      originatingChannel: "telegram",
      originatingTo: "268300329",
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [{ tool: "telegram", provider: "telegram", to: "268300329" }],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("does not suppress same-target replies when accountId differs", () => {
    const { replyPayloads } = buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "hello world!" }],
      messageProvider: "heartbeat",
      originatingChannel: "telegram",
      originatingTo: "268300329",
      accountId: "personal",
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [
        {
          tool: "telegram",
          provider: "telegram",
          to: "268300329",
          accountId: "work",
        },
      ],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.text).toBe("hello world!");
  });
});
