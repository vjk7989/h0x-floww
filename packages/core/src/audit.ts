import { z } from "zod";
import { appIdSchema, isoDateTimeSchema, turnIdSchema, type AppId, type IsoDateTime, type Json, type TurnId } from "./ids.js";
import { principalSchema, type Principal } from "./principal.js";
import { VENUES, type RunContext } from "./run-context.js";
import { triggerRefSchema, type TriggerRef } from "./triggers.js";
import type { GuardDecision } from "./guard.js";
import { riskLabelSchema, type RiskLabel, type ToolOutcome } from "./tools.js";

/** The audit enums' members. ONE spelling each: the interface below, the row
 *  schema, and the wire's request filters (`store-wire.ts`) all build from these
 *  tuples, so a member added in one place cannot silently miss the others.
 *  `venue` needs no tuple here — `VENUES` is already its one source, and the
 *  `satisfies` on the other two ties them to the types that own them. */
export const AUDIT_KINDS = ["tool-call", "approval", "policy-decision", "run", "app-lifecycle", "share", "door-auth", "principal"] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];
export const AUDIT_OUTCOMES = ["ok", "error", "pending-approval", "blocked", "connect-required"] as const satisfies readonly ToolOutcome["status"][];
export const AUDIT_DECIDED_BY = ["grant", "rule", "judge", "default", "confirmEach", "breaker", "denied", "org", "frozen"] as const satisfies readonly GuardDecision["decidedBy"][];

/** 01-core §7 */
export interface AuditEvent {
  id: string;
  at: IsoDateTime;
  kind: AuditKind;
  principal: Principal;
  venue: RunContext["venue"];
  presence: RunContext["presence"];
  appId?: AppId;
  trigger?: TriggerRef;
  /** The turn this row came out of, so a turn's rows join to each other, to its
   *  mirrored calls and to the views it painted. Copied from the `RunContext` by
   *  the mint helpers — never authored by a caller. Absent on a run with no turn
   *  (a webhook, a schedule fire, an org-policy load). */
  turnId?: TurnId;
  /** The MCP client this row came in on — `mcpc_*` or a CIMD URL for a
   *  third-party agent, `svc:<hash8>` for a host's own service key. Absent on
   *  every row that did not arrive at the door. */
  clientId?: string;
  tool?: string;
  /** The risk the guard actually gated on — the EFFECTIVE grade, after any
   *  `resolveRisk`, not the descriptor's static label. Absent on rows written
   *  with no tool descriptor in hand, and on a control/frozen row: the freeze
   *  short-circuit runs before risk resolution, so it has no effective grade to
   *  report and omits the field rather than chip the declared label. */
  risk?: RiskLabel;
  inputPreview?: string;
  outcome?: ToolOutcome["status"];
  decidedBy?: GuardDecision["decidedBy"];
  detail?: Json;
}

/**
 * The ctx half of an audit row — the fields every row copies off the run it came
 * out of. ONE copy: hand-spreading these at each mint site is how `turnId`
 * reached three writers and silently missed five, and a row that cannot be
 * joined to its turn is an unanswerable question for billing and reconciliation.
 *
 * Absent optionals stay ABSENT rather than becoming `undefined` keys, so a row
 * built through this is byte-identical to a hand-written one.
 */
export const auditContext = (
  ctx: Pick<RunContext, "principal" | "venue" | "presence" | "appId" | "trigger" | "turnId" | "mcpConsent">,
): Pick<AuditEvent, "principal" | "venue" | "presence" | "appId" | "trigger" | "turnId" | "clientId"> => ({
  principal: ctx.principal,
  venue: ctx.venue,
  presence: ctx.presence,
  ...(ctx.appId === undefined ? {} : { appId: ctx.appId }),
  ...(ctx.trigger === undefined ? {} : { trigger: ctx.trigger }),
  ...(ctx.turnId === undefined ? {} : { turnId: ctx.turnId }),
  ...(ctx.mcpConsent === undefined ? {} : { clientId: ctx.mcpConsent.clientId }),
});

/** 01-core §7 */
export const auditEventSchema = z.object({
  id: z.string().regex(/^aud_.+$/),
  at: isoDateTimeSchema,
  kind: z.enum(AUDIT_KINDS),
  principal: principalSchema,
  venue: z.enum(VENUES),
  presence: z.enum(["present", "away"]),
  appId: appIdSchema.optional(),
  trigger: triggerRefSchema.optional(),
  turnId: turnIdSchema.optional(),
  clientId: z.string().optional(),
  tool: z.string().optional(),
  risk: riskLabelSchema.optional(),
  inputPreview: z.string().optional(),
  outcome: z.enum(AUDIT_OUTCOMES).optional(),
  decidedBy: z.enum(AUDIT_DECIDED_BY).optional(),
  detail: z.unknown().optional(),
}).passthrough() satisfies z.ZodType<AuditEvent>;
