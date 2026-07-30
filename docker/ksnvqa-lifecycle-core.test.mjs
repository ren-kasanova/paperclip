import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDeliveryMonitorPolicy,
  boundedSourceTitle,
  deliveryMonitorCandidates,
  extractRejectionObservations,
  extractUnresolvedRejections,
  isProductionPromotionInteraction,
  lifecycleHealthStatus,
  migrateLifecycleState,
  monitorHasLivePath,
  productionApprovalTargetViolation,
  rejectionCompleteness,
  rejectionCycleMarker,
  stageDispatchKey,
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
  assert.deepEqual(result[0].completeness, {
    complete: true,
    missing: [],
    duplicates: [],
  });
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

test("a persisted schedule or freshly triggered monitor is a live path", () => {
  assert.equal(
    monitorHasLivePath(
      { monitorNextCheckAt: "2026-07-30T12:30:00.000Z" },
      [],
      Date.parse("2026-07-30T12:00:00.000Z"),
    ),
    true,
  );
  assert.equal(
    monitorHasLivePath(
      { monitorLastTriggeredAt: "2026-07-30T12:00:00.000Z" },
      [],
      Date.parse("2026-07-30T12:05:00.000Z"),
    ),
    true,
  );
  assert.equal(
    monitorHasLivePath(
      { monitorLastTriggeredAt: "2026-07-30T12:00:00.000Z" },
      [],
      Date.parse("2026-07-30T12:11:00.000Z"),
    ),
    false,
  );
  assert.equal(
    monitorHasLivePath(
      { monitorNextCheckAt: "2026-07-30T11:59:00.000Z" },
      [],
      Date.parse("2026-07-30T12:00:00.000Z"),
    ),
    false,
  );
});

test("monitor repair preserves the complete execution policy and durable timeout", () => {
  const timeoutAt = "2026-08-02T12:00:00.000Z";
  const policy = buildDeliveryMonitorPolicy(
    {
      identifier: "KSNVQA-19",
      title: "[KSNV-188] Marketplace P95 spike — Delivery QA-return monitor",
      executionPolicy: {
        mode: "supervised",
        stages: [{ id: "review", type: "review" }],
        reviewPreset: { mode: "required" },
        authorizationPolicy: { mode: "restricted" },
        commentRequired: false,
        monitor: {
          scheduledBy: "assignee",
          timeoutAt,
        },
      },
    },
    "rejection-188",
    {
      nowMs: Date.parse("2026-07-30T12:00:00.000Z"),
      delayMs: 2 * 60 * 60 * 1000,
      returnTimeoutMs: 72 * 60 * 60 * 1000,
    },
  );
  assert.equal(policy.mode, "supervised");
  assert.deepEqual(policy.stages, [{ id: "review", type: "review" }]);
  assert.deepEqual(policy.reviewPreset, { mode: "required" });
  assert.deepEqual(policy.authorizationPolicy, { mode: "restricted" });
  assert.equal(policy.commentRequired, false);
  assert.equal(policy.monitor.timeoutAt, timeoutAt);
  assert.equal(policy.monitor.nextCheckAt, "2026-07-30T14:00:00.000Z");
});

test("dispatch or invariant failures degrade watcher health", () => {
  assert.equal(lifecycleHealthStatus([], [], []), "ok");
  assert.equal(lifecycleHealthStatus(["dispatch failed"], []), "degraded");
});

test("near-miss rejection headlines are routed instead of disappearing", () => {
  const issue = {
    id: "linear-variant",
    identifier: "KSNV-190",
    comments: {
      nodes: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          body: structuredRejection.replace(
            "## QA REJECTED",
            "## QA REJECTED (cycle 2)",
          ),
          createdAt: "2026-07-30T10:00:00.000Z",
        },
      ],
    },
  };
  assert.equal(extractUnresolvedRejections([issue]).length, 1);
});

test("rejection evidence requires one non-empty literal label per field", () => {
  const prose =
    "QA REJECTED\nExpected behavior was not observed in the environment; severity is P1.";
  assert.equal(rejectionCompleteness(prose).complete, false);
  const duplicate = `${structuredRejection}\n- Severity: P2`;
  assert.deepEqual(rejectionCompleteness(duplicate).duplicates, ["severity"]);
});

test("rejection observations retain the exact resolving return", () => {
  const rejectionId = "44444444-4444-4444-8444-444444444444";
  const returnId = "55555555-5555-4555-8555-555555555555";
  const observations = extractRejectionObservations([
    {
      id: "linear-resolved",
      comments: {
        nodes: [
          {
            id: rejectionId,
            body: structuredRejection,
            createdAt: "2026-07-30T10:00:00.000Z",
          },
          {
            id: returnId,
            body: `QA RETURN RESOLVED\n\nRejection: ${rejectionId}`,
            createdAt: "2026-07-30T11:00:00.000Z",
          },
        ],
      },
    },
  ]);
  assert.equal(observations[0].resolved, true);
  assert.equal(observations[0].resolutionCommentId, returnId);
});

test("stage dispatch keys are stable across mutable Linear updates", () => {
  assert.equal(
    stageDispatchKey("linear-1", "ready_for_qa", 7),
    "linear-stage:linear-1:ready_for_qa:entry-7",
  );
});

test("source-bound titles preserve the Linear id and action within 240 chars", () => {
  const title = boundedSourceTitle(
    "KSNV-999",
    "A".repeat(400),
    "Delivery QA-return monitor",
  );
  assert.equal(title.length, 240);
  assert.match(title, /^\[KSNV-999\] /);
  assert.match(title, / — Delivery QA-return monitor$/);
});

test("version 4 state migration adds durable entry sequences", () => {
  assert.deepEqual(
    migrateLifecycleState(
      {
        version: 4,
        active: {},
        transitionHistory: {},
        rejectionCycles: {},
      },
      "2026-07-30T12:00:00.000Z",
    ),
    {
      version: 5,
      active: {},
      transitionHistory: {},
      rejectionCycles: {},
      migratedAt: "2026-07-30T12:00:00.000Z",
      entrySequences: {},
      returnDispatches: {},
    },
  );
});

test("legacy advancement-only rejection outcomes are re-verified", () => {
  assert.deepEqual(
    migrateLifecycleState(
      {
        version: 5,
        rejectionCycles: {
          "rejection-1": {
            identifier: "KSNV-217",
            status: "resolved_or_advanced",
          },
          "rejection-2": {
            identifier: "KSNV-188",
            status: "resolved_return_observed",
          },
        },
      },
      "2026-07-30T12:00:00.000Z",
    ).rejectionCycles,
    {
      "rejection-1": {
        identifier: "KSNV-217",
        status: "unverified_legacy_resolution",
        legacyResolutionInvalidatedAt: "2026-07-30T12:00:00.000Z",
      },
      "rejection-2": {
        identifier: "KSNV-188",
        status: "resolved_return_observed",
      },
    },
  );
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
  assert.match(
    productionApprovalTargetViolation(
      {
        ...base,
        title: "Approve Android app promotion to prod after TN10 QA",
        payload: {
          ...base.payload,
          target: {
            type: "custom",
            key: "KSNV-188:production-promotion:signed-pipeline",
            revisionId: "sha256:abc",
          },
        },
      },
      "KSNV-217",
    ),
    /must reference KSNV-217/,
  );
  assert.match(
    productionApprovalTargetViolation({
      kind: "request_confirmation",
      title: "Approve rollout",
      payload: {
        prompt: "Ship the signed app",
        detailsMarkdown:
          "Promote to live. Artifact: app\nDigest: sha256:abc\nRelease path: signed pipeline\nRollback: previous digest",
      },
    }),
    /immutable custom target/,
  );
  assert.equal(
    isProductionPromotionInteraction({
      kind: "request_confirmation",
      title: "Approve Android app promotion to prod after TN10 QA",
      payload: { prompt: "Ship the signed release" },
    }),
    true,
  );
  assert.equal(
    isProductionPromotionInteraction({
      kind: "request_confirmation",
      title: "Approve provisioning of a funded test fixture",
      payload: {
        detailsMarkdown: "Blocks the production rollout scheduled next week",
      },
    }),
    false,
  );
  assert.equal(
    isProductionPromotionInteraction({
      kind: "request_confirmation",
      title: "Approve lock release for the production signing fixture",
    }),
    false,
  );
  assert.equal(
    isProductionPromotionInteraction({
      kind: "request_confirmation",
      title: "Approve production rollout after funded-wallet fixture QA",
      payload: {
        detailsMarkdown:
          "The staging deployment is excluded; promote the signed live artifact.",
      },
    }),
    true,
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
