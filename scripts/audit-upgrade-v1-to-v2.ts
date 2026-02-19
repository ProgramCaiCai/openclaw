import fs from "node:fs";
import path from "node:path";
import type { AuditEventV1 } from "../src/audit/schema-v1.js";
import { upgradeVerifiedAuditEventsV1ToV2 } from "../src/audit/upgrade-v1-to-v2.js";

function usage(): never {
  throw new Error(
    "Usage: pnpm tsx scripts/audit-upgrade-v1-to-v2.ts <input.ndjson> <output.ndjson>",
  );
}

function readV1Events(inputPath: string): AuditEventV1[] {
  const text = fs.readFileSync(inputPath, "utf8");
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.map((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSON at line ${index + 1}: ${String(error)}`, { cause: error });
    }
    const event = parsed as AuditEventV1;
    if (event.version !== 1) {
      throw new Error(`Line ${index + 1} is not v1 audit event (version=${String(event.version)})`);
    }
    return event;
  });
}

function main(): void {
  const [, , inputArg, outputArg] = process.argv;
  if (!inputArg || !outputArg) {
    usage();
  }

  const inputPath = path.resolve(inputArg);
  const outputPath = path.resolve(outputArg);

  const inputEvents = readV1Events(inputPath);
  const upgradedEvents = upgradeVerifiedAuditEventsV1ToV2(inputEvents);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(
    outputPath,
    `${upgradedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );

  process.stdout.write(
    `upgraded ${inputEvents.length} events: ${path.basename(inputPath)} -> ${path.basename(outputPath)}\n`,
  );
}

main();
