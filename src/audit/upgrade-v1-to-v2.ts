import { upgradeAuditEventsV1ToV2 } from "./migrate-v1-to-v2.js";
import type { AuditEventV1 } from "./schema-v1.js";
import type { AuditEventV2 } from "./schema-v2.js";
import { verifyAuditChain } from "./verify.js";

export function upgradeVerifiedAuditEventsV1ToV2(
  inputEvents: readonly AuditEventV1[],
  migratedAt = new Date().toISOString(),
): AuditEventV2[] {
  const sourceVerify = verifyAuditChain(inputEvents);
  if (!sourceVerify.ok) {
    const first = sourceVerify.issues[0];
    throw new Error(`source v1 verification failed at index ${first?.index}: ${first?.message}`);
  }

  const upgradedEvents = upgradeAuditEventsV1ToV2(inputEvents, migratedAt);
  const outputVerify = verifyAuditChain(upgradedEvents);
  if (!outputVerify.ok) {
    const first = outputVerify.issues[0];
    throw new Error(`v2 verification failed at index ${first?.index}: ${first?.message}`);
  }

  return upgradedEvents;
}
