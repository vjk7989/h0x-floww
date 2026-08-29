// @vitest-environment jsdom
/**
 * THE DEFECT this exists for: `thread/parts.tsx` and `vendo-approval.tsx` both
 * settle the instant `approvals.decide` resolves — the CALL it authorizes may
 * still be running — while `embeds.tsx` settles only once the wire reports
 * that call's own outcome. All three used to hardcode their own copy of the
 * approve line, and `vendo-approval.tsx` said "ran" for the earlier, post-decide
 * moment: the words were the only thing telling two different lifecycle
 * states apart, and they drifted.
 *
 * `APPROVAL_LINES` (approval-card.tsx) is the fix: one constant per moment,
 * every call site imports it. Every assertion below reads off the constant,
 * never a literal — a hand-written expectation here would be a fourth copy of
 * the same string, which is exactly how the bug happened the first time.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { VendoApprovalRef } from "@vendoai/core";
import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createVendoClient, VendoApproval, VendoProvider, type VendoClient } from "../../src/index.js";
import { APPROVAL_LINES } from "../../src/chrome/approval-card.js";
import { VendoApprovalEmbed } from "../../src/chrome/embeds.js";
import { ThreadPart } from "../../src/chrome/thread/parts.js";
import { createWireServer } from "../wire-server.js";

// A STANDING ask (thread/parts.tsx's `ThreadStandingApproval`): the descriptor
// names a different call (`vendo_app_build`) than the one riding beside it, so
// this is the guard-raised branch, decided over the wire like the queue and
// the toast.
const standingPart = {
  type: "data-vendo-approval",
  toolCallId: "call_make",
  risk: "write",
  approvalId: "apr_1",
  descriptor: {
    name: "vendo_app_build",
    title: "Build this app for real",
    description: "Build this app for real",
    inputSchema: {},
  },
} as unknown as UIMessage["parts"][number];

const rideAlong = {
  type: "dynamic-tool",
  toolName: "vendo_make",
  toolCallId: "call_make",
  state: "input-available",
  input: {},
} as unknown as UIMessage["parts"][number];

const approvalRef: VendoApprovalRef = {
  kind: "vendo/approval-ref@1",
  approvalId: "apr_1",
  summary: "Send the report to a client",
};

describe("the approval settle line never drifts between call sites", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    cleanup();
    await wire.close();
  });

  it("thread/parts.tsx settles the instant decide() resolves, at the post-decide constant", async () => {
    render(
      <VendoProvider client={client}>
        <ThreadPart
          part={standingPart}
          partKey="p0"
          role="assistant"
          restored={false}
          risks={new Map()}
          siblingParts={[rideAlong]}
        />
      </VendoProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByText(APPROVAL_LINES.underWay)).toBeDefined());
  });

  it("vendo-approval.tsx settles at the SAME post-decide constant — the site the bug lived in", async () => {
    render(
      <VendoApproval
        client={client}
        approval={{ id: "apr_1", question: "Send the report?", notes: [] }}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByText(APPROVAL_LINES.underWay)).toBeDefined());
  });

  it("embeds.tsx settles only once the wire reports the call's own outcome, at the post-result constant", async () => {
    render(<VendoProvider client={client}><VendoApprovalEmbed refValue={approvalRef} /></VendoProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByText(APPROVAL_LINES.ran)).toBeDefined());
  });

  it("the post-decide constant and the post-result constant are not the same line", () => {
    expect(APPROVAL_LINES.underWay).not.toBe(APPROVAL_LINES.ran);
  });
});
