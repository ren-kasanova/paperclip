const REJECTION_HEADLINE = "QA REJECTED";
const RETURN_HEADLINE = "QA RETURN RESOLVED";

const rejectionFields = [
  ["testedArtifact", "Tested artifact"],
  ["failedCriterion", "Failed criterion"],
  ["expected", "Expected"],
  ["observed", "Observed"],
  ["reproduction", "Reproduction steps"],
  ["environment", "Environment"],
  ["evidence", "Durable evidence"],
  ["severity", "Severity"],
  ["regressionScope", "Regression scope"],
  ["retestCondition", "Retest condition"],
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstContentLine(body) {
  return String(body || "")
    .split(/\r?\n/)
    .map((line) =>
      line
        .trim()
        .replace(/^#{1,6}\s+/, "")
        .replace(/^\*\*(.+)\*\*$/, "$1")
        .replace(/:$/, "")
        .trim(),
    )
    .find(Boolean) || "";
}

function hasHeadline(body, headline) {
  const line = firstContentLine(body).toUpperCase();
  return new RegExp(`^${escapeRegExp(headline)}\\b`, "i").test(line);
}

export function rejectionCompleteness(body) {
  const lines = String(body || "")
    .split(/\r?\n/)
    .map((line) =>
      line
        .trim()
        .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
        .replace(/\*\*/g, "")
        .trim(),
    );
  const missing = [];
  const duplicates = [];
  for (const [name, label] of rejectionFields) {
    const pattern = new RegExp(`^${escapeRegExp(label)}\\s*:\\s*(.+?)\\s*$`, "i");
    const matches = lines.filter((line) => pattern.test(line));
    if (matches.length === 0) missing.push(name);
    if (matches.length > 1) duplicates.push(name);
  }
  return {
    complete: missing.length === 0 && duplicates.length === 0,
    missing,
    duplicates,
  };
}

export function extractRejectionObservations(issues) {
  const observations = [];
  for (const issue of issues || []) {
    const comments = [...(issue?.comments?.nodes || [])]
      .filter((comment) => comment?.id && typeof comment?.body === "string")
      .sort((left, right) =>
        String(left.createdAt || left.updatedAt || "").localeCompare(
          String(right.createdAt || right.updatedAt || ""),
        ),
      );
    const returns = comments.filter((comment) =>
      hasHeadline(comment.body, RETURN_HEADLINE),
    );
    for (const rejection of comments.filter((comment) =>
      hasHeadline(comment.body, REJECTION_HEADLINE),
    )) {
      const resolution = returns.find((comment) => {
        const rejectionTime = Date.parse(rejection.createdAt || rejection.updatedAt || 0);
        const returnTime = Date.parse(comment.createdAt || comment.updatedAt || 0);
        return (
          returnTime > rejectionTime &&
          String(comment.body).includes(rejection.id)
        );
      });
      observations.push({
        issue,
        comment: rejection,
        resolved: Boolean(resolution),
        resolutionCommentId: resolution?.id || null,
        completeness: rejectionCompleteness(rejection.body),
      });
    }
  }
  return observations;
}

export function extractUnresolvedRejections(issues) {
  return extractRejectionObservations(issues).filter((entry) => !entry.resolved);
}

export function deliveryMonitorCandidates(paperclipIssues, identifier) {
  const prefix = `[${identifier}]`;
  return (paperclipIssues || []).filter(
    (issue) =>
      typeof issue?.title === "string" &&
      issue.title.startsWith(prefix) &&
      issue.title.endsWith("— Delivery QA-return monitor"),
  );
}

export function monitorHasLivePath(
  issue,
  pendingInteractions = [],
  nowMs = Date.now(),
) {
  const nextCheckMs = Date.parse(issue?.monitorNextCheckAt || "");
  const wakeRequestedMs = Date.parse(issue?.monitorWakeRequestedAt || "");
  const lastTriggeredMs = Date.parse(issue?.monitorLastTriggeredAt || "");
  const isRecent = (timestamp) =>
    Number.isFinite(timestamp) &&
    nowMs - timestamp >= 0 &&
    nowMs - timestamp < 10 * 60 * 1000;
  return (
    Boolean(issue?.executionRunId) ||
    Boolean(issue?.checkoutRunId) ||
    (Number.isFinite(nextCheckMs) && nextCheckMs > nowMs) ||
    isRecent(wakeRequestedMs) ||
    ["queued", "running"].includes(issue?.executionState?.status) ||
    ["queued", "running"].includes(issue?.activeRun?.status) ||
    isRecent(lastTriggeredMs) ||
    pendingInteractions.some((interaction) => interaction?.status === "pending")
  );
}

export function buildDeliveryMonitorPolicy(
  issue,
  rejectionCommentId,
  {
    nowMs = Date.now(),
    delayMs = 30 * 60 * 1000,
    timeoutAt = null,
    returnTimeoutMs = 72 * 60 * 60 * 1000,
  } = {},
) {
  const existingPolicy = issue?.executionPolicy || {};
  const existingMonitor = existingPolicy.monitor || {};
  const linearIdentifier =
    typeof issue?.title === "string"
      ? issue.title.match(/^\[(KSNV-\d+)\]/)?.[1]
      : null;
  return {
    ...existingPolicy,
    mode: existingPolicy.mode || "normal",
    stages: Array.isArray(existingPolicy.stages)
      ? existingPolicy.stages
      : [],
    monitor: {
      ...existingMonitor,
      kind: "external_service",
      serviceName: "Kasanova QA lifecycle",
      externalRef: [
        linearIdentifier ? `linear:${linearIdentifier}` : null,
        rejectionCommentId ? `linear-comment:${rejectionCommentId}` : null,
        issue?.identifier ? `paperclip:${issue.identifier}` : null,
      ].filter(Boolean).join("|"),
      nextCheckAt: new Date(nowMs + delayMs).toISOString(),
      timeoutAt:
        timeoutAt ||
        existingMonitor.timeoutAt ||
        new Date(nowMs + returnTimeoutMs).toISOString(),
      maxAttempts: 96,
      recoveryPolicy: "wake_owner",
      notes:
        "Re-read the live Linear issue and immutable rejection, repair only delivery-owned work, post one QA RETURN RESOLVED citing the rejection ID, then return the same issue to Ready for QA.",
    },
    commentRequired:
      typeof existingPolicy.commentRequired === "boolean"
        ? existingPolicy.commentRequired
        : true,
  };
}

export function lifecycleHealthStatus(...failureGroups) {
  return failureGroups.some(
    (entries) => Array.isArray(entries) && entries.length > 0,
  )
    ? "degraded"
    : "ok";
}

export function stageDispatchKey(issueId, stageSlug, entrySequence) {
  return `linear-stage:${issueId}:${stageSlug}:entry-${entrySequence}`;
}

export function boundedSourceTitle(
  identifier,
  subject,
  action,
  maxLength = 240,
) {
  const prefix = `[${identifier}] `;
  const suffix = ` — ${action}`;
  const available = Math.max(1, maxLength - prefix.length - suffix.length);
  const normalized = String(subject || "Linear issue").replace(/\s+/g, " ").trim();
  const bounded =
    normalized.length <= available
      ? normalized
      : `${normalized.slice(0, Math.max(1, available - 1)).trimEnd()}…`;
  return `${prefix}${bounded}${suffix}`;
}

export function migrateLifecycleState(previous, now) {
  if (!previous) return null;
  if (![2, 3, 4, 5].includes(previous.version)) {
    throw new Error(`Unsupported lifecycle watcher state version: ${previous.version}`);
  }
  let state = previous;
  if (state.version === 2) {
    state = {
      ...state,
      version: 3,
      migratedAt: now,
      transitionHistory: {},
      guardNotifications: {},
      monitorInvariantNotifications: {},
      withdrawnPolicyInteractions: {},
    };
  }
  if (state.version === 3) {
    state = {
      ...state,
      version: 4,
      migratedAt: now,
      rejectionCycles: {},
    };
  }
  if (state.version === 4) {
    state = {
      ...state,
      version: 5,
      migratedAt: now,
      entrySequences: {},
    };
  }
  const rejectionCycles = Object.fromEntries(
    Object.entries(state.rejectionCycles || {}).map(([commentId, cycle]) => [
      commentId,
      cycle?.status === "resolved_or_advanced"
        ? {
            ...cycle,
            status: "unverified_legacy_resolution",
            legacyResolutionInvalidatedAt: now,
          }
        : cycle,
    ]),
  );
  return {
    ...state,
    entrySequences: { ...(state.entrySequences || {}) },
    rejectionCycles,
    returnDispatches: { ...(state.returnDispatches || {}) },
  };
}

export function rejectionCycleMarker(commentId) {
  return `KSNVQA rejection cycle: ${commentId}`;
}

export function isProductionPromotionInteraction(interaction) {
  const headline = [
    interaction?.title,
    interaction?.summary,
    interaction?.payload?.prompt,
  ]
    .filter(Boolean)
    .join(" ");
  const details = String(interaction?.payload?.detailsMarkdown || "");
  const explicitlyExcluded =
    /\bproduction\s+(?:promotion|deployment|release|rollout)\s+(?:is\s+|are\s+)?(?:explicitly\s+)?excluded\b/i.test(
      details,
    ) ||
    /\b(?:explicitly\s+)?exclude(?:s|d)?\s+production\s+(?:promotion|deployment|release|rollout)\b/i.test(
      details,
    );
  if (explicitlyExcluded) return false;
  const promotionHeadline = headline.replace(
    /\b(?:lock transfer|lock release|ownership transfer)\b/gi,
    "",
  );
  const productionEnvironment =
    /\b(?:production|prod|live|play\s+store\s+production)\b/i;
  const promotionAction =
    /\b(?:promot(?:e|ing|ion)|release|deploy(?:ment|ing)?|rollout|ship)\b/i;
  return (
    interaction?.kind === "request_confirmation" &&
    (
      /\bproduction\s+(?:promotion|deployment|release|rollout)\b/i.test(
        promotionHeadline,
      ) ||
      (
        promotionAction.test(promotionHeadline) &&
        (productionEnvironment.test(promotionHeadline) ||
          productionEnvironment.test(details))
      ) ||
      (
        productionEnvironment.test(promotionHeadline) &&
        promotionAction.test(details)
      )
    )
  );
}

export function productionApprovalTargetViolation(
  interaction,
  expectedIdentifier = null,
) {
  if (!isProductionPromotionInteraction(interaction)) return null;
  const target = interaction?.payload?.target;
  if (!target || target.type !== "custom") {
    return "Production promotion approvals must be bound to an immutable custom target.";
  }
  if (!String(target.revisionId || "").trim()) {
    return "Production promotion approvals must include the immutable artifact digest or release revision as target.revisionId.";
  }
  const keyMatch = String(target.key || "").match(
    /^(ksnv-\d+):production-promotion:/i,
  );
  if (!keyMatch) {
    return "Production promotion approval target.key must be `KSNV-###:production-promotion:<release-path>`.";
  }
  if (
    expectedIdentifier &&
    keyMatch[1].toUpperCase() !== String(expectedIdentifier).toUpperCase()
  ) {
    return `Production promotion approval target.key must reference ${expectedIdentifier}.`;
  }
  const details = String(interaction?.payload?.detailsMarkdown || "");
  const requiredEvidence = [
    ["artifact", /\bartifact\b/i],
    ["digest", /\b(?:digest|sha(?:256)?)\b/i],
    ["release path", /\brelease path\b/i],
    ["rollback", /\brollback\b/i],
  ];
  const missing = requiredEvidence
    .filter(([, pattern]) => !pattern.test(details))
    .map(([label]) => label);
  return missing.length > 0
    ? `Production promotion approval is missing: ${missing.join(", ")}.`
    : null;
}

function sameInteractionTarget(left, right) {
  const leftTarget = left?.payload?.target;
  const rightTarget = right?.payload?.target;
  return (
    leftTarget?.type === "custom" &&
    rightTarget?.type === "custom" &&
    String(leftTarget.key || "") === String(rightTarget.key || "") &&
    String(leftTarget.revisionId || "") ===
      String(rightTarget.revisionId || "")
  );
}

export function productionInteractionStaleReason(
  interaction,
  siblingInteractions = [],
  linearState = null,
) {
  if (!isProductionPromotionInteraction(interaction)) return null;
  if (linearState && linearState !== "Ready for Release") {
    return `The source Linear issue is ${linearState}, not Ready for Release; this production confirmation is obsolete.`;
  }
  const acceptedDuplicate = (siblingInteractions || []).find(
    (candidate) =>
      candidate?.id !== interaction?.id &&
      candidate?.kind === "request_confirmation" &&
      candidate?.status === "accepted" &&
      isProductionPromotionInteraction(candidate) &&
      sameInteractionTarget(candidate, interaction),
  );
  if (acceptedDuplicate) {
    return `The same immutable production target was already accepted by interaction ${acceptedDuplicate.id}; this duplicate has no target drift.`;
  }
  const text = [
    interaction?.title,
    interaction?.summary,
    interaction?.payload?.prompt,
    interaction?.payload?.detailsMarkdown,
  ]
    .filter(Boolean)
    .join(" ");
  if (
    /\b(?:after|once|upon)\b.{0,80}\bprovision(?:ed|ing)?\b/i.test(text) ||
    /\bprovision(?:ed|ing)?\b.{0,80}\b(?:credential|access|secret|token)\b/i.test(
      text,
    )
  ) {
    return "Production approval and credential provisioning must be separate interactions; this bundled confirmation is obsolete.";
  }
  return null;
}

export function monitorNeedsTerminalCleanup(issue, targetStatus) {
  return (
    issue?.status !== targetStatus ||
    issue?.assigneeAgentId != null ||
    issue?.assigneeUserId != null ||
    issue?.executionPolicy != null
  );
}
