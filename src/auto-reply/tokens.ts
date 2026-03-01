import { escapeRegExp } from "../utils.js";

export const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
export const SILENT_REPLY_TOKEN = "NO_REPLY";
const LOW_VALUE_PLACEHOLDER_TEXT = "answer for user question";
const LOW_VALUE_PLACEHOLDER_PREFIX =
  /^\s*answer(?:[\p{P}\p{Z}\s]+)for(?:[\p{P}\p{Z}\s]+)user(?:[\p{P}\p{Z}\s]+)question(?=$|[\p{P}\p{Z}\s])(?:[\p{P}\p{Z}\s]*)/iu;

function normalizeLowValuePlaceholderText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function isLowValuePlaceholderText(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  return normalizeLowValuePlaceholderText(text) === LOW_VALUE_PLACEHOLDER_TEXT;
}

export function stripLowValuePlaceholderPrefix(text: string): string {
  const match = LOW_VALUE_PLACEHOLDER_PREFIX.exec(text);
  if (!match) {
    return text;
  }
  return text.slice(match[0].length).trim();
}

export function isSilentReplyText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) {
    return false;
  }
  const escaped = escapeRegExp(token);
  // Match only the exact silent token with optional surrounding whitespace.
  // This prevents
  // substantive replies ending with NO_REPLY from being suppressed (#19537).
  return new RegExp(`^\\s*${escaped}\\s*$`).test(text);
}

export function isSilentReplyPrefixText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) {
    return false;
  }
  const normalized = text.trimStart().toUpperCase();
  if (!normalized) {
    return false;
  }
  if (!normalized.includes("_")) {
    return false;
  }
  if (/[^A-Z_]/.test(normalized)) {
    return false;
  }
  return token.toUpperCase().startsWith(normalized);
}
