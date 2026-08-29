import { describe, expect, it } from "vitest";
import {
  AUDIT_DECIDED_BY,
  AUDIT_KINDS,
  AUDIT_OUTCOMES,
  VENUES,
  auditEventSchema,
  storeWireAuditListRequestSchema,
  storeWireAuditTallyRequestSchema,
} from "../src/index.js";

/**
 * The audit enums were spelled twice inside core — once on the ROW
 * (`audit.ts`), once on the wire's REQUEST filters (`store-wire.ts`) — and the
 * two copies happened to agree.
 *
 * So this asserts IDENTITY, not equality. Two independent copies of a member
 * list are equal on the day they are written; equality is exactly what a
 * drifting duplicate keeps passing right up until someone edits one side. Only
 * "the same array object reached both schemas" fails the moment a copy comes
 * back, which is the whole reason this file exists. `.options` is the tuple zod
 * kept a reference to, so `toBe` here is a claim about the SOURCE, not the
 * values.
 *
 * What the enums do NOT collapse is deliberate and stays: the request keeps its
 * own schema — optional, and refused by the mount rather than widened — it just
 * no longer keeps its own member list.
 */
const options = (field: unknown): readonly string[] => {
  const node = field as { options?: readonly string[]; unwrap?: () => { options: readonly string[] } };
  return node.options ?? node.unwrap!().options;
};

describe("the audit enums have ONE source", () => {
  it.each([
    ["kind", AUDIT_KINDS, auditEventSchema.shape.kind, storeWireAuditListRequestSchema.shape.kind, storeWireAuditTallyRequestSchema.shape.kind],
    ["venue", VENUES, auditEventSchema.shape.venue, storeWireAuditListRequestSchema.shape.venue, storeWireAuditTallyRequestSchema.shape.venue],
    ["outcome", AUDIT_OUTCOMES, auditEventSchema.shape.outcome, storeWireAuditListRequestSchema.shape.outcome, storeWireAuditTallyRequestSchema.shape.outcome],
    ["decidedBy", AUDIT_DECIDED_BY, auditEventSchema.shape.decidedBy, storeWireAuditListRequestSchema.shape.decidedBy, storeWireAuditTallyRequestSchema.shape.decidedBy],
  ])("the row schema and both wire requests share %s's tuple object", (_name, tuple, row, list, tally) => {
    expect(options(row)).toBe(tuple);
    expect(options(list)).toBe(tuple);
    expect(options(tally)).toBe(tuple);
  });

  it("keeps the request's own schema separate from the row's", () => {
    // Sharing the members must not have shared the SCHEMA: a filter is optional
    // and a row's kind is not, so `auditEventSchema` must never be reachable as
    // the request's validator.
    expect(storeWireAuditListRequestSchema.shape.kind).not.toBe(auditEventSchema.shape.kind);
    expect(storeWireAuditListRequestSchema.shape.kind.isOptional()).toBe(true);
    expect(auditEventSchema.shape.kind.isOptional()).toBe(false);
  });
});
