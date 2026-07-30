import assert from "node:assert/strict";
import test from "node:test";

import {
  deliveryMonitorCandidates,
  extractUnresolvedRejections,
  monitorHasLivePath,
  productionApprovalTargetViolation,
  rejectionCycleMarker,
} from "./ksnvqa-lifecycle-core.mjs";

const structuredRejection = [
  "## QA REJECTED",
  "",
  "- Tested artifact: app@sha256:abc",
  "- Failed criterion: p95 under 500 ms",
  "- Expected: 500 ms",
  "- Observed: 900 ms",
  "- Reproduction steps: run the production probe",
  "- Environment: production",
  "- Durable evidence: trace-123",
  "- Severity: P1",
  "- Regression scope: marketplace",
  "- Retest condition: deploy artifact with the fix",
].join("\n");

test("finds one complete unresolved rejection by immutable comment id", () => {
  const issue = {
    id: "linear-1",
    identifier: "KSNV-188",
    comments: {
      nodes: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          body: structuredRejection,
          createdAt: "2026-07-30T10:00:00.000Z",
        },
      ],
    },
  };
  const result = extractUnresolvedRejections([issue]);
  assert.equal(result.length, 1);
  assert.equal(result[0].comment.id, "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(result[0].completeness, { complete: true, missing: [] });
});

test("requires a later QA return to cite the exact rejection id", () => {
  const rejectionId = "11111111-1111-4111-8111-111111111111";
  const issue = {
    id: "linear-1",
    identifier: "KSNV-188",
    comments: {
      nodes: [
        {
          id: rejectionId,
          body: structuredRejection,
          createdAt: "2026-07-30T10:00:00.000Z",
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          body: `QA RETURN RESOLVED\n\nRejection: ${rejectionId}`,
          createdAt: "2026-07-30T11:00:00.000Z",
        },
      ],
    },
  };
  assert.deepEqual(extractUnresolvedRejections([issue]), []);
});

test("selects only the canonical source-bound delivery monitor", () => {
  const monitor = {
    title: "[KSNV-188] Marketplace P95 spike — Delivery QA-return monitor",
  };
  assert.deepEqual(
    deliveryMonitorCandidates(
      [
        monitor,
        { title: "[KSNV-188] Marketplace P95 spike — Ready for QA" },
        { title: "[KSNV-189] Other — Delivery QA-return monitor" },
      ],
      "KSNV-188",
    ),
    [monitor],
  );
});

test("a pending interaction is a live monitor path", () => {
  assert.equal(
    monitorHasLivePath({}, [{ status: "pending" }]),
    true,
  );
  assert.equal(monitorHasLivePath({}, []), false);
});

test("production approval is fail-closed unless artifact-bound", () => {
  const base = {
    kind: "request_confirmation",
    title: "Approve production promotion for KSNV-188",
    payload: {
      prompt: "Promote the pinned release",
      detailsMarkdown:
        "Artifact: app\nDigest: sha256:abc\nRelease path: signed pipeline\nRollback: previous digest",
    },
  };
  assert.match(productionApprovalTargetViolation(base), /immutable custom target/);
  assert.equal(
    productionApprovalTargetViolation({
      ...base,
      payload: {
        ...base.payload,
        target: {
          type: "custom",
          key: "KSNV-188:production-promotion:signed-pipeline",
          revisionId: "sha256:abc",
        },
      },
    }),
    null,
  );
  assert.equal(
    rejectionCycleMarker("11111111-1111-4111-8111-111111111111"),
    "KSNVQA rejection cycle: 11111111-1111-4111-8111-111111111111",
  );
});

test("development delivery is not production promotion when production is excluded", () => {
  assert.equal(
    productionApprovalTargetViolation({
      kind: "request_confirmation",
      title: "Approve exact KSNV-188 development delivery",
      summary: "Authorize publication, merge to dev, and development deployment",
      payload: {
        prompt: "Approve this exact development repair target?",
        detailsMarkdown:
          "Production promotion and production deployment are explicitly excluded.",
      },
    }),
    null,
  );
});
