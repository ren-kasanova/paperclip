const REJECTION_HEADLINE = "QA REJECTED";
const RETURN_HEADLINE = "QA RETURN RESOLVED";

const rejectionFields = [
  [
    "testedArtifact",
    /\b(?:tested (?:artifact|target|build|commit|deployment|image)|artifact|build|commit|deployment|image(?: digest)?)\b/i,
  ],
  ["failedCriterion", /\bfailed criterion\b/i],
  ["expected", /\bexpected\b/i],
  ["observed", /\bobserved\b/i],
  ["reproduction", /\breproduction(?: steps?)?\b/i],
  ["environment", /\benvironment\b/i],
  ["evidence", /\b(?:durable )?evidence\b/i],
  ["severity", /\bseverity\b/i],
  ["regressionScope", /\bregression scope\b/i],
  ["retestCondition", /\bretest condition\b/i],
];

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
  return (
    line === headline ||
    line.startsWith(`${headline}:`) ||
    line.startsWith(`${headline} —`) ||
    line.startsWith(`${headline} -`)
  );
}

export function rejectionCompleteness(body) {
  const text = String(body || "");
  const missing = rejectionFields
    .filter(([, pattern]) => !pattern.test(text))
    .map(([name]) => name);
  return { complete: missing.length === 0, missing };
}

export function extractUnresolvedRejections(issues) {
  const unresolved = [];
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
      const resolved = returns.some((comment) => {
        const rejectionTime = Date.parse(rejection.createdAt || rejection.updatedAt || 0);
        const returnTime = Date.parse(comment.createdAt || comment.updatedAt || 0);
        return (
          returnTime > rejectionTime &&
          String(comment.body).includes(rejection.id)
        );
      });
      if (resolved) continue;
      unresolved.push({
        issue,
        comment: rejection,
        completeness: rejectionCompleteness(rejection.body),
      });
    }
  }
  return unresolved;
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

export function monitorHasLivePath(issue, pendingInteractions = []) {
  return (
    Boolean(issue?.executionRunId) ||
    Boolean(issue?.checkoutRunId) ||
    ["queued", "running"].includes(issue?.executionState?.status) ||
    pendingInteractions.some((interaction) => interaction?.status === "pending")
  );
}

export function rejectionCycleMarker(commentId) {
  return `KSNVQA rejection cycle: ${commentId}`;
}

export function isProductionPromotionInteraction(interaction) {
  const text = [
    interaction?.title,
    interaction?.summary,
    interaction?.payload?.prompt,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    interaction?.kind === "request_confirmation" &&
    (
      /\bproduction\s+(?:promotion|deployment|release)\b/i.test(text) ||
      /\bpromot(?:e|ing|ion)\b.{0,80}\b(?:to\s+)?production\b/i.test(text) ||
      /\brelease\b.{0,80}\b(?:to\s+)?production\b/i.test(text)
    )
  );
}

export function productionApprovalTargetViolation(interaction) {
  if (!isProductionPromotionInteraction(interaction)) return null;
  const target = interaction?.payload?.target;
  if (!target || target.type !== "custom") {
    return "Production promotion approvals must be bound to an immutable custom target.";
  }
  if (!String(target.revisionId || "").trim()) {
    return "Production promotion approvals must include the immutable artifact digest or release revision as target.revisionId.";
  }
  if (!/^ksnv-\d+:production-promotion:/i.test(String(target.key || ""))) {
    return "Production promotion approval target.key must be `KSNV-###:production-promotion:<release-path>`.";
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
