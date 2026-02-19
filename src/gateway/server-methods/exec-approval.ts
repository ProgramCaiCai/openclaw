import type { AuditEventV1Input } from "../../audit/schema-v1.js";
import type { ExecApprovalForwarder } from "../../infra/exec-approval-forwarder.js";
import {
  DEFAULT_EXEC_APPROVAL_TIMEOUT_MS,
  type ExecApprovalDecision,
} from "../../infra/exec-approvals.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateExecApprovalRequestParams,
  validateExecApprovalResolveParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

type ExecApprovalAuditSink = (event: AuditEventV1Input) => void;

type ExecApprovalHandlersOptions = {
  forwarder?: ExecApprovalForwarder;
  auditSink?: ExecApprovalAuditSink;
};

function mapRequestActor(client: { connect?: { client?: { id?: string } } } | null | undefined): {
  type: "system" | "client";
  id: string;
} {
  const clientId = client?.connect?.client?.id;
  if (typeof clientId === "string" && clientId.length > 0) {
    return { type: "client", id: clientId };
  }
  return { type: "system", id: "openclaw" };
}

function commandPreview(command: string): string {
  const max = 256;
  return command.length > max ? `${command.slice(0, max)}...` : command;
}

function safeEmitAuditEvent(
  sink: ExecApprovalAuditSink | undefined,
  event: AuditEventV1Input,
): void {
  if (!sink) {
    return;
  }
  try {
    sink(event);
  } catch {
    // Audit logging is best-effort and must not block approval flow.
  }
}

function emitRequestedAuditEvent(
  sink: ExecApprovalAuditSink | undefined,
  record: {
    id: string;
    request: {
      command: string;
      cwd?: string | null;
      host?: string | null;
      security?: string | null;
      ask?: string | null;
      sessionKey?: string | null;
    };
    createdAtMs: number;
    expiresAtMs: number;
  },
  client: { connect?: { client?: { id?: string } } } | null | undefined,
): void {
  safeEmitAuditEvent(sink, {
    eventType: "exec.approval.requested",
    action: "requested",
    outcome: "success",
    actor: mapRequestActor(client),
    subject: { type: "approval", id: record.id },
    correlation: {
      approvalId: record.id,
      sessionKey: record.request.sessionKey ?? undefined,
    },
    source: { component: "gateway", subsystem: "exec-approval" },
    payload: {
      command: commandPreview(record.request.command),
      cwd: record.request.cwd,
      host: record.request.host,
      security: record.request.security,
      ask: record.request.ask,
      createdAtMs: record.createdAtMs,
      expiresAtMs: record.expiresAtMs,
    },
  });
}

function emitResolvedAuditEvent(
  sink: ExecApprovalAuditSink | undefined,
  args: {
    approvalId: string;
    decision: ExecApprovalDecision;
    resolvedBy?: string | null;
    sessionKey?: string | null;
  },
): void {
  safeEmitAuditEvent(sink, {
    eventType: "exec.approval.resolved",
    action: "resolved",
    outcome: "success",
    actor: {
      type: "user",
      id: args.resolvedBy ?? "unknown",
    },
    subject: { type: "approval", id: args.approvalId },
    correlation: {
      approvalId: args.approvalId,
      sessionKey: args.sessionKey ?? undefined,
    },
    source: { component: "gateway", subsystem: "exec-approval" },
    payload: {
      decision: args.decision,
      resolvedBy: args.resolvedBy ?? null,
    },
  });
}

function emitCompletedAuditEvent(
  sink: ExecApprovalAuditSink | undefined,
  args: {
    approvalId: string;
    decision: ExecApprovalDecision | null;
    sessionKey?: string | null;
    createdAtMs: number;
    expiresAtMs: number;
  },
): void {
  safeEmitAuditEvent(sink, {
    eventType: args.decision ? "exec.approval.completed" : "exec.approval.timeout",
    action: args.decision ? "completed" : "timed_out",
    outcome: args.decision ? "success" : "timeout",
    actor: { type: "system", id: "openclaw" },
    subject: { type: "approval", id: args.approvalId },
    correlation: {
      approvalId: args.approvalId,
      sessionKey: args.sessionKey ?? undefined,
    },
    source: { component: "gateway", subsystem: "exec-approval" },
    payload: {
      decision: args.decision,
      createdAtMs: args.createdAtMs,
      expiresAtMs: args.expiresAtMs,
    },
  });
}

export function createExecApprovalHandlers(
  manager: ExecApprovalManager,
  opts?: ExecApprovalHandlersOptions,
): GatewayRequestHandlers {
  const auditSink = opts?.auditSink;

  return {
    "exec.approval.request": async ({ params, respond, context, client }) => {
      if (!validateExecApprovalRequestParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid exec.approval.request params: ${formatValidationErrors(
              validateExecApprovalRequestParams.errors,
            )}`,
          ),
        );
        return;
      }
      const p = params as {
        id?: string;
        command: string;
        cwd?: string;
        host?: string;
        security?: string;
        ask?: string;
        agentId?: string;
        resolvedPath?: string;
        sessionKey?: string;
        timeoutMs?: number;
        twoPhase?: boolean;
      };
      const twoPhase = p.twoPhase === true;
      const timeoutMs =
        typeof p.timeoutMs === "number" ? p.timeoutMs : DEFAULT_EXEC_APPROVAL_TIMEOUT_MS;
      const explicitId = typeof p.id === "string" && p.id.trim().length > 0 ? p.id.trim() : null;
      if (explicitId && manager.getSnapshot(explicitId)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "approval id already pending"),
        );
        return;
      }
      const request = {
        command: p.command,
        cwd: p.cwd ?? null,
        host: p.host ?? null,
        security: p.security ?? null,
        ask: p.ask ?? null,
        agentId: p.agentId ?? null,
        resolvedPath: p.resolvedPath ?? null,
        sessionKey: p.sessionKey ?? null,
      };
      const record = manager.create(request, timeoutMs, explicitId);
      record.requestedByConnId = client?.connId ?? null;
      record.requestedByDeviceId = client?.connect?.device?.id ?? null;
      record.requestedByClientId = client?.connect?.client?.id ?? null;
      // Use register() to synchronously add to pending map before sending any response.
      // This ensures the approval ID is valid immediately after the "accepted" response.
      let decisionPromise: Promise<
        import("../../infra/exec-approvals.js").ExecApprovalDecision | null
      >;
      try {
        decisionPromise = manager.register(record, timeoutMs);
      } catch (err) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `registration failed: ${String(err)}`),
        );
        return;
      }
      context.broadcast(
        "exec.approval.requested",
        {
          id: record.id,
          request: record.request,
          createdAtMs: record.createdAtMs,
          expiresAtMs: record.expiresAtMs,
        },
        { dropIfSlow: true },
      );
      emitRequestedAuditEvent(auditSink, record, client);
      void opts?.forwarder
        ?.handleRequested({
          id: record.id,
          request: record.request,
          createdAtMs: record.createdAtMs,
          expiresAtMs: record.expiresAtMs,
        })
        .catch((err) => {
          context.logGateway?.error?.(`exec approvals: forward request failed: ${String(err)}`);
        });

      // Only send immediate "accepted" response when twoPhase is requested.
      // This preserves single-response semantics for existing callers.
      if (twoPhase) {
        respond(
          true,
          {
            status: "accepted",
            id: record.id,
            createdAtMs: record.createdAtMs,
            expiresAtMs: record.expiresAtMs,
          },
          undefined,
        );
      }

      const decision = await decisionPromise;
      emitCompletedAuditEvent(auditSink, {
        approvalId: record.id,
        decision,
        sessionKey: record.request.sessionKey,
        createdAtMs: record.createdAtMs,
        expiresAtMs: record.expiresAtMs,
      });
      // Send final response with decision for callers using expectFinal:true.
      respond(
        true,
        {
          id: record.id,
          decision,
          createdAtMs: record.createdAtMs,
          expiresAtMs: record.expiresAtMs,
        },
        undefined,
      );
    },
    "exec.approval.waitDecision": async ({ params, respond }) => {
      const p = params as { id?: string };
      const id = typeof p.id === "string" ? p.id.trim() : "";
      if (!id) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
        return;
      }
      const decisionPromise = manager.awaitDecision(id);
      if (!decisionPromise) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "approval expired or not found"),
        );
        return;
      }
      // Capture snapshot before await (entry may be deleted after grace period)
      const snapshot = manager.getSnapshot(id);
      const decision = await decisionPromise;
      // Return decision (can be null on timeout) - let clients handle via askFallback
      respond(
        true,
        {
          id,
          decision,
          createdAtMs: snapshot?.createdAtMs,
          expiresAtMs: snapshot?.expiresAtMs,
        },
        undefined,
      );
    },
    "exec.approval.resolve": async ({ params, respond, client, context }) => {
      if (!validateExecApprovalResolveParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid exec.approval.resolve params: ${formatValidationErrors(
              validateExecApprovalResolveParams.errors,
            )}`,
          ),
        );
        return;
      }
      const p = params as { id: string; decision: string };
      const decision = p.decision as ExecApprovalDecision;
      if (decision !== "allow-once" && decision !== "allow-always" && decision !== "deny") {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid decision"));
        return;
      }
      const resolvedBy = client?.connect?.client?.displayName ?? client?.connect?.client?.id;
      const snapshot = manager.getSnapshot(p.id);
      const ok = manager.resolve(p.id, decision, resolvedBy ?? null);
      if (!ok) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown approval id"));
        return;
      }
      context.broadcast(
        "exec.approval.resolved",
        { id: p.id, decision, resolvedBy, ts: Date.now() },
        { dropIfSlow: true },
      );
      emitResolvedAuditEvent(auditSink, {
        approvalId: p.id,
        decision,
        resolvedBy,
        sessionKey: snapshot?.request.sessionKey,
      });
      void opts?.forwarder
        ?.handleResolved({ id: p.id, decision, resolvedBy, ts: Date.now() })
        .catch((err) => {
          context.logGateway?.error?.(`exec approvals: forward resolve failed: ${String(err)}`);
        });
      respond(true, { ok: true }, undefined);
    },
  };
}
