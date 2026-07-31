import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

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
  monitorNeedsTerminalCleanup,
  productionApprovalTargetViolation,
  productionInteractionStaleReason,
  rejectionCycleMarker,
  stageDispatchKey,
} from "./ksnvqa-lifecycle-core.mjs";

const required = [
  "LINEAR_API_KEY",
  "KSNVQA_PAPERCLIP_API_URL",
  "PAPERCLIP_RFQA_ROUTINE_ID",
  "PAPERCLIP_RFR_ROUTINE_ID",
  "PAPERCLIP_PRODUCTION_VALIDATION_ROUTINE_ID",
  "PAPERCLIP_DONE_ROUTINE_ID",
  "PAPERCLIP_PROJECT_ID",
  "PAPERCLIP_PROJECT_WORKSPACE_ID",
  "PAPERCLIP_ASSIGNEE_AGENT_ID",
  "PAPERCLIP_COMPANY_ID",
  "PAPERCLIP_DELIVERY_AGENT_ID",
  "STATE_DIR",
];

for (const key of required) {
  if (!process.env[key]?.trim()) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const config = {
  linearApiKey: process.env.LINEAR_API_KEY,
  linearApiUrl: process.env.LINEAR_API_URL?.trim() || "https://api.linear.app/graphql",
  identifierPrefix: process.env.LINEAR_IDENTIFIER_PREFIX?.trim() || "KSNV-",
  // PAPERCLIP_API_URL is reserved by the Paperclip runtime and is injected as
  // the public base URL, which does not include /api. Keep the watcher's
  // internal API target in a distinct variable so the runtime cannot replace
  // it and silently turn routine dispatches into /routines/... 404s.
  paperclipApiUrl: process.env.KSNVQA_PAPERCLIP_API_URL.replace(/\/+$/, ""),
  projectId: process.env.PAPERCLIP_PROJECT_ID,
  projectWorkspaceId: process.env.PAPERCLIP_PROJECT_WORKSPACE_ID,
  assigneeAgentId: process.env.PAPERCLIP_ASSIGNEE_AGENT_ID,
  companyId: process.env.PAPERCLIP_COMPANY_ID,
  deliveryAgentId: process.env.PAPERCLIP_DELIVERY_AGENT_ID,
  stateDir: process.env.STATE_DIR,
  cycleWindowMs: Number(process.env.LIFECYCLE_CYCLE_WINDOW_HOURS || 24) * 60 * 60 * 1000,
  maxStageEntries: Number(process.env.LIFECYCLE_MAX_STAGE_ENTRIES || 3),
  requestTimeoutMs: Number(process.env.LIFECYCLE_REQUEST_TIMEOUT_MS || 10_000),
  returnTimeoutMs:
    Number(process.env.LIFECYCLE_RETURN_TIMEOUT_HOURS || 72) * 60 * 60 * 1000,
};

const stages = [
  {
    state: "Ready for QA",
    slug: "ready_for_qa",
    action: "Ready for QA",
    event: "linear.issue.entered_ready_for_qa",
    routineId: process.env.PAPERCLIP_RFQA_ROUTINE_ID,
  },
  {
    state: "Ready for Release",
    slug: "ready_for_release",
    action: "production promotion",
    event: "linear.issue.entered_ready_for_release",
    routineId: process.env.PAPERCLIP_RFR_ROUTINE_ID,
  },
  {
    state: "Production Validation",
    slug: "production_validation",
    action: "production validation",
    event: "linear.issue.entered_production_validation",
    routineId: process.env.PAPERCLIP_PRODUCTION_VALIDATION_ROUTINE_ID,
  },
  {
    state: "Done",
    slug: "done",
    action: "Done evidence audit",
    event: "linear.issue.entered_done",
    routineId: process.env.PAPERCLIP_DONE_ROUTINE_ID,
  },
];

const stateFile = path.join(config.stateDir, "state.json");
const healthFile = path.join(config.stateDir, "health.json");
const deliveryTreeFile = path.join(config.stateDir, "delivery-tree.json");
const lockFile = path.join(config.stateDir, "watcher.lock");
const lockStaleMs = 5 * 60 * 1000;

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

function buildDeliveryTreeSnapshot(lifecycleIssues, inProgressIssues, now) {
  const rejectedByIssueId = new Map();
  for (const observation of extractUnresolvedRejections(inProgressIssues)) {
    const existing = rejectedByIssueId.get(observation.issue.id);
    const observedAt =
      observation.comment.updatedAt ||
      observation.comment.createdAt ||
      observation.issue.updatedAt;
    const existingAt =
      existing?.qaRejection?.observedAt ||
      existing?.updatedAt;
    if (existing && Date.parse(existingAt || "") >= Date.parse(observedAt || "")) {
      continue;
    }
    rejectedByIssueId.set(observation.issue.id, {
      linearIssueId: observation.issue.id,
      identifier: observation.issue.identifier,
      title: observation.issue.title,
      url: observation.issue.url,
      state: "In Progress",
      updatedAt: observation.issue.updatedAt,
      qaRejection: {
        commentId: observation.comment.id,
        observedAt,
      },
    });
  }

  const tickets = [
    ...lifecycleIssues.map((issue) => ({
      linearIssueId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      state: issue.stage.state,
      updatedAt: issue.updatedAt,
      enteredAt: issue.updatedAt,
    })),
    ...rejectedByIssueId.values(),
  ].sort((left, right) =>
    left.identifier.localeCompare(right.identifier, undefined, { numeric: true }),
  );

  return {
    version: 1,
    source: "linear-kasanova",
    fetchedAt: now,
    tickets,
  };
}

async function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const token = randomUUID();
      const handle = await open(lockFile, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({
          pid: process.pid,
          token,
          acquiredAt: new Date().toISOString(),
        })}\n`,
      );
      const heartbeat = setInterval(() => {
        const now = new Date();
        handle.utimes(now, now).catch(() => {});
      }, 30_000);
      heartbeat.unref();
      return { handle, heartbeat, token };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let lockStat;
      try {
        lockStat = await stat(lockFile);
      } catch (statError) {
        if (statError?.code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() - lockStat.mtimeMs < lockStaleMs) return null;
      try {
        await unlink(lockFile);
      } catch (unlinkError) {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      }
    }
  }
  return null;
}

async function releaseLock(handle) {
  if (!handle) return;
  clearInterval(handle.heartbeat);
  try {
    await handle.handle.close();
  } catch {
    return;
  }
  try {
    const current = await readJson(lockFile, null);
    if (current?.token === handle.token) await unlink(lockFile);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      process.stderr.write(
        `${new Date().toISOString()} lifecycle lock release warning: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }
}

async function fetchJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: options.signal || AbortSignal.timeout(config.requestTimeoutMs),
    });
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new Error(
        `${options.method || "GET"} ${url} timed out after ${config.requestTimeoutMs} ms`,
      );
    }
    throw error;
  }
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${options.method || "GET"} ${url} returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok) {
    const message = body?.error || body?.message || `HTTP ${response.status}`;
    throw new Error(`${options.method || "GET"} ${url} failed: ${message}`);
  }
  return body;
}

async function fetchIssuesByState(state) {
  const query = `
    query KasanovaIssuesByState($state: String!, $after: String) {
      issues(
        first: 50
        after: $after
        filter: { state: { name: { eq: $state } } }
      ) {
        nodes {
          id
          identifier
          title
          url
          updatedAt
          state { name }
          team { key name }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  const issues = [];
  let after = null;
  do {
    const result = await fetchJson(config.linearApiUrl, {
      method: "POST",
      headers: {
        authorization: config.linearApiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, variables: { state, after } }),
    });
    if (result?.errors?.length) {
      throw new Error(`Linear GraphQL error: ${result.errors.map((entry) => entry.message).join("; ")}`);
    }
    const page = result?.data?.issues;
    if (!page) throw new Error("Linear response did not contain data.issues");
    issues.push(
      ...page.nodes.filter((issue) => issue.identifier?.startsWith(config.identifierPrefix)),
    );
    after = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);

  return issues;
}

async function fetchIssueWithAllComments(issueId) {
  const query = `
    query KasanovaIssueComments($id: String!, $after: String) {
      issue(id: $id) {
        id
        identifier
        title
        url
        updatedAt
        state { name }
        team { key name }
        comments(first: 50, after: $after) {
          nodes { id body createdAt updatedAt }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  `;
  const comments = [];
  let after = null;
  let issue = null;
  do {
    const result = await fetchJson(config.linearApiUrl, {
      method: "POST",
      headers: {
        authorization: config.linearApiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, variables: { id: issueId, after } }),
    });
    if (result?.errors?.length) {
      throw new Error(
        `Linear GraphQL error: ${result.errors.map((entry) => entry.message).join("; ")}`,
      );
    }
    issue = result?.data?.issue;
    if (!issue) throw new Error(`Linear response did not contain issue ${issueId}`);
    const page = issue.comments;
    comments.push(...(page?.nodes || []));
    after = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return { ...issue, comments: { nodes: comments } };
}

async function fetchLifecycleIssues() {
  const results = [];
  for (const stage of stages) {
    const issues = await fetchIssuesByState(stage.state);
    results.push(issues.map((issue) => ({ ...issue, stage })));
  }
  return results.flat();
}

async function fetchInProgressIssuesWithComments() {
  const issues = await fetchIssuesByState("In Progress");
  const hydrated = [];
  for (const issue of issues) {
    hydrated.push(await fetchIssueWithAllComments(issue.id));
  }
  return hydrated;
}

async function fetchTrackedCycleIssuesWithComments(previousCycles, knownIssueIds) {
  const unresolvedIssueIds = new Set(
    Object.values(previousCycles || {})
      .filter(
        (cycle) =>
          cycle?.linearIssueId &&
          !String(cycle.status || "").startsWith("resolved_") &&
          !String(cycle.status || "").startsWith("closed_"),
      )
      .map((cycle) => cycle.linearIssueId),
  );
  const issues = [];
  for (const issueId of unresolvedIssueIds) {
    if (knownIssueIds.has(issueId)) continue;
    issues.push(await fetchIssueWithAllComments(issueId));
  }
  return issues;
}

function routineSubject(issue) {
  const rendered = boundedSourceTitle(
    issue.identifier,
    issue.title,
    issue.stage.action,
  );
  const prefix = `[${issue.identifier}] `;
  const suffix = ` — ${issue.stage.action}`;
  return rendered.slice(prefix.length, rendered.length - suffix.length);
}

async function dispatchIssue(issue, entrySequence) {
  return fetchJson(`${config.paperclipApiUrl}/routines/${issue.stage.routineId}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: "api",
      projectId: config.projectId,
      projectWorkspaceId: config.projectWorkspaceId,
      assigneeAgentId: config.assigneeAgentId,
      idempotencyKey: stageDispatchKey(
        issue.id,
        issue.stage.slug,
        entrySequence,
      ),
      variables: {
        linear_identifier: issue.identifier,
        linear_title: routineSubject(issue),
      },
      payload: {
        event: issue.stage.event,
        linearIssueId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        state: issue.state?.name,
        updatedAt: issue.updatedAt,
        teamKey: issue.team?.key,
      },
    }),
  });
}

async function fetchPaperclipIssues() {
  const issues = [];
  const limit = 1000;
  let offset = 0;
  while (true) {
    const query = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      excludeRoutineExecutions: "true",
      projectId: config.projectId,
    });
    const page = await fetchJson(
      `${config.paperclipApiUrl}/companies/${config.companyId}/issues?${query}`,
    );
    if (!Array.isArray(page)) {
      throw new Error(
        "Paperclip company issues endpoint returned an invalid response",
      );
    }
    issues.push(...page);
    if (page.length < limit) break;
    offset += page.length;
  }
  return issues;
}

async function fetchPaperclipIssue(issueId) {
  return fetchJson(`${config.paperclipApiUrl}/issues/${issueId}`);
}

async function postIssueComment(issueId, body) {
  return fetchJson(`${config.paperclipApiUrl}/issues/${issueId}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
}

async function fetchIssueComments(issueId) {
  const comments = [];
  const limit = 500;
  let after = null;
  while (true) {
    const query = new URLSearchParams({
      order: "desc",
      limit: String(limit),
      ...(after ? { after } : {}),
    });
    const page = await fetchJson(
      `${config.paperclipApiUrl}/issues/${issueId}/comments?${query}`,
    );
    if (!Array.isArray(page)) {
      throw new Error(
        `Paperclip comments endpoint returned an invalid response for ${issueId}`,
      );
    }
    comments.push(...page);
    if (page.length < limit) break;
    after = page.at(-1)?.id || null;
    if (!after) {
      throw new Error(
        `Paperclip comments endpoint did not provide a cursor for ${issueId}`,
      );
    }
  }
  return comments;
}

async function fetchIssueInteractions(issueId) {
  const interactions = await fetchJson(
    `${config.paperclipApiUrl}/issues/${issueId}/interactions`,
  );
  if (!Array.isArray(interactions)) {
    throw new Error(`Paperclip interactions endpoint returned an invalid response for ${issueId}`);
  }
  return interactions;
}

async function ensureIssueComment(issueId, marker, body) {
  const comments = await fetchIssueComments(issueId);
  if (comments.some((comment) => String(comment?.body || "").includes(marker))) {
    return false;
  }
  await postIssueComment(issueId, body);
  return true;
}

async function patchIssue(issueId, body) {
  return fetchJson(`${config.paperclipApiUrl}/issues/${issueId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createPaperclipIssue(body) {
  return fetchJson(
    `${config.paperclipApiUrl}/companies/${config.companyId}/issues`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function monitorPolicy(
  issue,
  rejectionCommentId,
  delayMs = 60 * 60 * 1000,
  timeoutAt = null,
) {
  return buildDeliveryMonitorPolicy(issue, rejectionCommentId, {
    delayMs,
    timeoutAt,
    returnTimeoutMs: config.returnTimeoutMs,
  });
}

function latestSourceBoundIssue(paperclipIssues, identifier) {
  const prefix = `[${identifier}]`;
  return paperclipIssues
    .filter(
      (issue) =>
        typeof issue?.title === "string" &&
        issue.title.startsWith(prefix) &&
        !issue.title.endsWith("— Delivery QA-return monitor") &&
        !issue.title.includes("— lifecycle invariant:") &&
        !issue.title.endsWith("— lifecycle churn guard") &&
        !issue.title.endsWith("— rejection evidence repair"),
    )
    .sort((left, right) =>
      String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")),
    )[0] || null;
}

async function createDeliveryMonitor(linearIssue, paperclipIssues, rejectionCommentId) {
  const parent = latestSourceBoundIssue(paperclipIssues, linearIssue.identifier);
  const monitor = await createPaperclipIssue({
    projectId: config.projectId,
    projectWorkspaceId: config.projectWorkspaceId,
    parentId: parent?.id || null,
    title: boundedSourceTitle(
      linearIssue.identifier,
      linearIssue.title,
      "Delivery QA-return monitor",
    ),
    description: [
      `Persist the delivery-owned QA-return loop for [${linearIssue.identifier}](${linearIssue.url}).`,
      "",
      `Immutable rejection comment: \`${rejectionCommentId}\`.`,
      "",
      "Do not approve QA, promote production, validate production, or advance a QA-owned gate.",
    ].join("\n"),
    status: "todo",
    priority: "high",
    assigneeAgentId: config.deliveryAgentId,
    assigneeUserId: null,
    idempotencyKey: `ksnvqa-delivery-monitor:${linearIssue.id}`,
  });
  return monitor;
}

async function surfaceLifecycleInvariant({
  linearIssue,
  paperclipIssues,
  rejectionCommentId,
  kind,
  reason,
}) {
  const parent = latestSourceBoundIssue(paperclipIssues, linearIssue.identifier);
  const created = await createPaperclipIssue({
    projectId: config.projectId,
    projectWorkspaceId: config.projectWorkspaceId,
    parentId: parent?.id || null,
    title: boundedSourceTitle(
      linearIssue.identifier,
      linearIssue.title,
      `lifecycle invariant: ${kind}`,
    ),
    description: [
      `The zero-token lifecycle watcher cannot complete the QA-return route for [${linearIssue.identifier}](${linearIssue.url}).`,
      "",
      `- Invariant: ${reason}`,
      `- Immutable rejection comment: \`${rejectionCommentId}\``,
      "- Required action: repair the canonical Delivery monitor state, then leave the immutable rejection cycle intact so the watcher can resume it.",
    ].join("\n"),
    status: "todo",
    priority: "high",
    assigneeAgentId: null,
    assigneeUserId: "local-board",
    idempotencyKey:
      `ksnvqa-lifecycle-invariant:${linearIssue.id}:${rejectionCommentId}:${kind}`,
  });
  paperclipIssues.push(created);
  return created;
}

async function surfaceRejectionEvidenceIssue({
  linearIssue,
  paperclipIssues,
  rejectionCommentId,
  reason,
}) {
  const parent = latestSourceBoundIssue(
    paperclipIssues,
    linearIssue.identifier,
  );
  const created = await createPaperclipIssue({
    projectId: config.projectId,
    projectWorkspaceId: config.projectWorkspaceId,
    parentId: parent?.id || null,
    title: boundedSourceTitle(
      linearIssue.identifier,
      linearIssue.title,
      "rejection evidence repair",
    ),
    description: [
      `Repair the existing malformed QA rejection for [${linearIssue.identifier}](${linearIssue.url}).`,
      "",
      `- Immutable rejection comment: \`${rejectionCommentId}\``,
      `- Evidence defect: ${reason}`,
      "- Edit the original Linear comment to contain exactly one non-empty required label. Do not create a second rejection.",
    ].join("\n"),
    status: "todo",
    priority: "high",
    assigneeAgentId: config.assigneeAgentId,
    assigneeUserId: null,
    idempotencyKey:
      `ksnvqa-rejection-evidence:${linearIssue.id}:${rejectionCommentId}`,
  });
  paperclipIssues.push(created);
  return created;
}

async function surfaceMonitorInvariant({
  monitor,
  paperclipIssues,
  kind,
  reason,
  rejectionCommentId,
}) {
  const identifier =
    String(monitor.title || "").match(/^\[(KSNV-\d+)\]/)?.[1] ||
    "LINEAR-SWEEP";
  const subject = String(monitor.title || monitor.identifier)
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/\s+— Delivery QA-return monitor$/, "");
  const created = await createPaperclipIssue({
    projectId: config.projectId,
    projectWorkspaceId: config.projectWorkspaceId,
    parentId: monitor.id,
    title: boundedSourceTitle(
      identifier,
      subject,
      `lifecycle invariant: ${kind}`,
    ),
    description: [
      `The Delivery monitor ${monitor.identifier} stopped fail-closed.`,
      "",
      `- Invariant: ${reason}`,
      rejectionCommentId
        ? `- Immutable rejection comment: \`${rejectionCommentId}\``
        : "- Immutable rejection comment: unavailable in the watcher ledger",
      "- Required action: reconcile the Linear rejection cycle before reactivating Delivery.",
    ].join("\n"),
    status: "todo",
    priority: "high",
    assigneeAgentId: null,
    assigneeUserId: "local-board",
    idempotencyKey:
      `ksnvqa-monitor-invariant:${monitor.id}:${kind}`,
  });
  paperclipIssues.push(created);
  return created;
}

async function enforceRejectionCycles(
  inProgressIssues,
  lifecycleIssues,
  observedCycleIssues,
  paperclipIssues,
  previousCycles,
) {
  const cycles = { ...(previousCycles || {}) };
  const violations = [];
  const evidenceWarnings = [];
  const repaired = [];
  const observations = extractRejectionObservations(observedCycleIssues);
  const observationByCommentId = new Map(
    observations.map((entry) => [entry.comment.id, entry]),
  );
  const detected = extractUnresolvedRejections(inProgressIssues);
  const detectedIds = new Set(detected.map((entry) => entry.comment.id));
  const currentStateByIssueId = new Map([
    ...inProgressIssues.map((issue) => [issue.id, issue.state?.name || "In Progress"]),
    ...lifecycleIssues.map((issue) => [issue.id, issue.stage.state]),
    ...observedCycleIssues.map((issue) => [
      issue.id,
      issue.state?.name || "Unknown",
    ]),
  ]);

  for (const rejection of detected) {
    const { issue: linearIssue, comment, completeness } = rejection;
    const marker = rejectionCycleMarker(comment.id);
    const evidenceMarker = `KSNVQA rejection evidence warning: ${comment.id}`;
    const detectedAt =
      cycles[comment.id]?.detectedAt || new Date().toISOString();
    const storedTimeoutMs = Date.parse(cycles[comment.id]?.timeoutAt || "");
    const timeoutAt = Number.isFinite(storedTimeoutMs)
      ? new Date(storedTimeoutMs).toISOString()
      : new Date(
          Date.parse(detectedAt) + config.returnTimeoutMs,
        ).toISOString();
    const cycle = {
      ...(cycles[comment.id] || {}),
      linearIssueId: linearIssue.id,
      identifier: linearIssue.identifier,
      rejectionCommentId: comment.id,
      detectedAt,
      timeoutAt,
      lastSeenAt: new Date().toISOString(),
    };

    if (!completeness.complete) {
      const invalidParts = [
        completeness.missing.length > 0
          ? `missing structured fields: ${completeness.missing.join(", ")}`
          : null,
        completeness.duplicates.length > 0
          ? `duplicate structured fields: ${completeness.duplicates.join(", ")}`
          : null,
      ].filter(Boolean);
      const reason =
        `${linearIssue.identifier} rejection ${comment.id} has invalid evidence: ` +
        invalidParts.join("; ");
      evidenceWarnings.push(reason);
      cycle.evidenceWarning = reason;
      cycle.missingFields = completeness.missing;
      cycle.duplicateFields = completeness.duplicates;
      const sourceIssue = latestSourceBoundIssue(paperclipIssues, linearIssue.identifier);
      if (sourceIssue && !["done", "cancelled"].includes(sourceIssue.status)) {
        await ensureIssueComment(
          sourceIssue.id,
          evidenceMarker,
          [
            "## Rejection handoff evidence warning",
            "",
            evidenceMarker,
            "",
            reason,
            "",
            "The immutable rejection is still routed so delivery cannot be stranded. Kasanova QA must repair the existing Linear rejection comment; it must not create a duplicate rejection.",
          ].join("\n"),
        );
      } else if (!cycle.evidenceIssueId) {
        const evidenceIssue = await surfaceRejectionEvidenceIssue({
          linearIssue,
          paperclipIssues,
          rejectionCommentId: comment.id,
          reason,
        });
        cycle.evidenceIssueId = evidenceIssue.id;
        cycle.evidenceIdentifier = evidenceIssue.identifier;
      }
    } else {
      delete cycle.evidenceWarning;
      delete cycle.missingFields;
      delete cycle.duplicateFields;
    }

    if (Date.now() >= Date.parse(cycle.timeoutAt)) {
      const reason =
        `${linearIssue.identifier} rejection ${comment.id} exceeded its ` +
        `${config.returnTimeoutMs / (60 * 60 * 1000)}-hour Delivery return window`;
      violations.push(reason);
      cycle.status = "blocked_return_timeout";
      cycle.invariantViolation = reason;
      if (!cycle.timeoutInvariantIssueId) {
        const invariant = await surfaceLifecycleInvariant({
          linearIssue,
          paperclipIssues,
          rejectionCommentId: comment.id,
          kind: "return-timeout",
          reason,
        });
        cycle.timeoutInvariantIssueId = invariant.id;
        cycle.timeoutInvariantIdentifier = invariant.identifier;
      }
      cycles[comment.id] = cycle;
      continue;
    }

    let candidates = deliveryMonitorCandidates(
      paperclipIssues,
      linearIssue.identifier,
    );
    if (candidates.length === 0) {
      const created = await createDeliveryMonitor(
        linearIssue,
        paperclipIssues,
        comment.id,
      );
      paperclipIssues.push(created);
      candidates = [created];
      repaired.push(`${created.identifier}:created:${comment.id}`);
    }
    if (candidates.length !== 1) {
      const reason =
        `${linearIssue.identifier} has ${candidates.length} Delivery QA-return monitors; expected exactly one`;
      violations.push(reason);
      cycle.status = "blocked_monitor_cardinality";
      cycle.paperclipIssueIds = candidates.map((candidate) => candidate.id);
      if (!cycle.invariantIssueId) {
        const invariant = await surfaceLifecycleInvariant({
          linearIssue,
          paperclipIssues,
          rejectionCommentId: comment.id,
          kind: "monitor-cardinality",
          reason,
        });
        cycle.invariantIssueId = invariant.id;
        cycle.invariantIdentifier = invariant.identifier;
      }
      cycles[comment.id] = cycle;
      continue;
    }

    const monitor = candidates[0];
    cycle.monitorIssueId = monitor.id;
    cycle.monitorIdentifier = monitor.identifier;
    if (monitor.status === "cancelled") {
      const reason =
        `${linearIssue.identifier} canonical Delivery monitor ${monitor.identifier} is cancelled and requires Ren to choose recovery`;
      violations.push(reason);
      cycle.status = "blocked_cancelled_monitor";
      if (!cycle.invariantIssueId) {
        const invariant = await surfaceLifecycleInvariant({
          linearIssue,
          paperclipIssues,
          rejectionCommentId: comment.id,
          kind: "cancelled-monitor",
          reason,
        });
        cycle.invariantIssueId = invariant.id;
        cycle.invariantIdentifier = invariant.identifier;
      }
      cycles[comment.id] = cycle;
      continue;
    }

    const interactions = await fetchIssueInteractions(monitor.id);
    const eligibleMonitor =
      monitor.assigneeAgentId === config.deliveryAgentId &&
      monitor.assigneeUserId == null &&
      ["in_progress", "in_review"].includes(monitor.status);
    if (eligibleMonitor && monitorHasLivePath(monitor, interactions)) {
      cycle.status = interactions.some((interaction) => interaction.status === "pending")
        ? "routed_pending_interaction"
        : monitor.monitorNextCheckAt
          ? "routed_monitor"
          : "routed_live_execution";
      cycles[comment.id] = cycle;
      continue;
    }

    const detailedMonitor = await fetchPaperclipIssue(monitor.id);
    const policy = monitorPolicy(
      detailedMonitor,
      comment.id,
      60 * 60 * 1000,
      cycle.timeoutAt,
    );
    const attemptCount =
      detailedMonitor.executionState?.monitor?.attemptCount || 0;
    const maxAttempts =
      detailedMonitor.executionPolicy?.monitor?.maxAttempts || 96;
    if (attemptCount >= maxAttempts) {
      const reason =
        `${linearIssue.identifier} rejection ${comment.id} exhausted ` +
        `${attemptCount}/${maxAttempts} Delivery monitor attempts`;
      violations.push(reason);
      cycle.status = "blocked_return_attempts";
      cycle.invariantViolation = reason;
      if (!cycle.attemptInvariantIssueId) {
        const invariant = await surfaceLifecycleInvariant({
          linearIssue,
          paperclipIssues,
          rejectionCommentId: comment.id,
          kind: "return-attempts-exhausted",
          reason,
        });
        cycle.attemptInvariantIssueId = invariant.id;
        cycle.attemptInvariantIdentifier = invariant.identifier;
      }
      if (monitorNeedsTerminalCleanup(detailedMonitor, "blocked")) {
        await patchIssue(monitor.id, {
          status: "blocked",
          assigneeAgentId: null,
          assigneeUserId: null,
          executionPolicy: null,
        });
      }
      cycles[comment.id] = cycle;
      continue;
    }
    await patchIssue(monitor.id, {
      status: "in_review",
      assigneeAgentId: config.deliveryAgentId,
      assigneeUserId: null,
      executionPolicy: policy,
    });
    await ensureIssueComment(
      monitor.id,
      marker,
      [
        "## QA rejection routed to Delivery",
        "",
        marker,
        "",
        `- Linear: [${linearIssue.identifier}](${linearIssue.url})`,
        `- Immutable rejection comment: \`${comment.id}\``,
        "- Owner: Kasanova Delivery; no user assignee.",
        `- Next check: \`${policy.monitor.nextCheckAt}\`.`,
        "- Delivery must post exactly one `QA RETURN RESOLVED` that cites this rejection ID before returning the same Linear issue to `Ready for QA`.",
      ].join("\n"),
    );
    repaired.push(`${monitor.identifier}:reopened:${comment.id}`);
    cycle.status = "routed_monitor";
    cycle.routedAt = new Date().toISOString();
    cycles[comment.id] = cycle;
  }

  for (const [commentId, cycle] of Object.entries(cycles)) {
    if (detectedIds.has(commentId)) continue;
    if (
      String(cycle.status || "").startsWith("resolved_") ||
      String(cycle.status || "").startsWith("closed_")
    ) {
      continue;
    }
    const currentState = currentStateByIssueId.get(cycle.linearIssueId);
    const observation = observationByCommentId.get(commentId);
    if (observation?.resolved) {
      cycles[commentId] = {
        ...cycle,
        status: "resolved_return_observed",
        resolutionCommentId: observation.resolutionCommentId,
        lastObservedState: currentState || observation.issue.state?.name || null,
        resolvedAt: cycle.resolvedAt || new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      };
      continue;
    }
    if (["Canceled", "Cancelled", "Duplicate"].includes(currentState)) {
      cycles[commentId] = {
        ...cycle,
        status: "closed_terminal_linear_state",
        lastObservedState: currentState,
        resolvedAt: cycle.resolvedAt || new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      };
      continue;
    }
    const reason = observation
      ? `${cycle.identifier} rejection ${commentId} is still unresolved but disappeared from the In Progress intake`
      : `${cycle.identifier} rejection ${commentId} could not be verified in the complete Linear comment history`;
    violations.push(reason);
    cycles[commentId] = {
      ...cycle,
      status: observation
        ? "unresolved_outside_in_progress"
        : "unverified_rejection_missing",
      invariantViolation: reason,
      lastObservedState: currentState || null,
      lastSeenAt: new Date().toISOString(),
    };
  }

  return {
    cycles,
    detected: detected.length,
    violations,
    evidenceWarnings,
    repaired,
  };
}

async function reportCycleGuard(issue, paperclipIssues, count) {
  const candidate = latestSourceBoundIssue(
    paperclipIssues,
    issue.identifier,
  );
  const target =
    candidate && !["done", "cancelled"].includes(candidate.status)
      ? candidate
      : null;
  if (!target?.id) {
    const created = await createPaperclipIssue({
      projectId: config.projectId,
      projectWorkspaceId: config.projectWorkspaceId,
      title: boundedSourceTitle(
        issue.identifier,
        issue.title,
        "lifecycle churn guard",
      ),
      description: [
        `Automatic lifecycle dispatch stopped for [${issue.identifier}](${issue.url}).`,
        "",
        `- Stage: \`${issue.stage.state}\``,
        `- Observed entries within 24 hours: ${count}`,
        "- Required action: inspect and resolve the state ping-pong before another automated QA cycle.",
      ].join("\n"),
      status: "todo",
      priority: "high",
      assigneeAgentId: config.assigneeAgentId,
      assigneeUserId: null,
      idempotencyKey:
        `ksnvqa-lifecycle-guard:${issue.id}:${issue.stage.slug}:${count}`,
    });
    paperclipIssues.push(created);
    return {
      targetIssueId: created.id,
      targetIdentifier: created.identifier,
      created: true,
    };
  }
  await postIssueComment(
    target.id,
    [
      "## Lifecycle churn guard",
      "",
      `Stopped automatic dispatch for [${issue.identifier}](${issue.url}) in \`${issue.stage.state}\`.`,
      "",
      `- Observed ${count} entries into the same stage within 24 hours.`,
      `- Automatic dispatch resumes only after the Linear issue changes state.`,
      "- Kasanova QA must inspect the lifecycle history and resolve the ping-pong before another cycle.",
    ].join("\n"),
  );
  return {
    targetIssueId: target.id,
    targetIdentifier: target.identifier,
    created: false,
  };
}

async function enforceDeliveryMonitorInvariant(
  paperclipIssues,
  previousNotifications,
  rejectionCycles = {},
) {
  const issueIds = new Set(paperclipIssues.map((issue) => issue.id));
  const notifications = Object.fromEntries(
    Object.entries(previousNotifications || {}).filter(([issueId]) =>
      issueIds.has(issueId),
    ),
  );
  const violations = [];
  const repaired = [];
  const closed = [];
  const stopped = [];
  const cycleByMonitorIssueId = new Map(
    Object.values(rejectionCycles || {})
      .filter((cycle) => cycle?.monitorIssueId)
      .map((cycle) => [cycle.monitorIssueId, cycle]),
  );
  for (const issue of paperclipIssues) {
    const isMonitor =
      typeof issue?.title === "string" &&
      issue.title.endsWith("— Delivery QA-return monitor");
    const eligibleStatus = ["in_progress", "in_review"].includes(issue?.status);
    const knownCycle = cycleByMonitorIssueId.get(issue.id) || null;
    const terminalKnownCycle =
      String(knownCycle?.status || "").startsWith("resolved_") ||
      String(knownCycle?.status || "").startsWith("closed_");
    const terminalCleanup =
      (issue.status === "done" && issue.assigneeAgentId != null) ||
      (terminalKnownCycle && !eligibleStatus);
    if (!isMonitor || (!eligibleStatus && !terminalCleanup)) continue;

    try {
      const detailedIssue = await fetchPaperclipIssue(issue.id);
      const cycle = knownCycle;
      const rejectionCommentId =
        cycle?.rejectionCommentId ||
        String(detailedIssue.executionPolicy?.monitor?.externalRef || "")
          .match(/(?:^|\|)linear-comment:([^|]+)/)?.[1] ||
        null;
      const cycleStatus = String(cycle?.status || "");
      if (
        cycleStatus.startsWith("resolved_") ||
        cycleStatus.startsWith("closed_") ||
        detailedIssue.status === "done"
      ) {
        if (cycle) {
          await ensureIssueComment(
            issue.id,
            `KSNVQA monitor closed: ${rejectionCommentId || issue.id}`,
            [
              "## Delivery monitor closed",
              "",
              `KSNVQA monitor closed: ${rejectionCommentId || issue.id}`,
              "",
              rejectionCommentId
                ? `Linear recorded an exact \`QA RETURN RESOLVED\` for rejection \`${rejectionCommentId}\`.`
                : "The tracked Linear cycle reached a terminal state.",
              "No further Delivery wake is required for this rejection cycle.",
            ].join("\n"),
          );
        }
        if (monitorNeedsTerminalCleanup(detailedIssue, "done")) {
          await patchIssue(issue.id, {
            status: "done",
            assigneeAgentId: null,
            assigneeUserId: null,
            executionPolicy: null,
          });
          closed.push(issue.identifier);
        }
        delete notifications[issue.id];
        continue;
      }
      const monitorState = detailedIssue.executionState?.monitor || {};
      const persistedMonitor =
        detailedIssue.executionPolicy?.monitor || {};
      const attemptCount = Number(monitorState.attemptCount || 0);
      const maxAttempts = Number(
        monitorState.maxAttempts || persistedMonitor.maxAttempts || 96,
      );
      const durableTimeoutAt =
        cycle?.timeoutAt ||
        monitorState.timeoutAt ||
        persistedMonitor.timeoutAt ||
        null;
      const timedOut =
        cycleStatus === "blocked_return_timeout" ||
        (durableTimeoutAt &&
          Date.now() >= Date.parse(durableTimeoutAt));
      const attemptsExhausted =
        cycleStatus === "blocked_return_attempts" ||
        attemptCount >= maxAttempts;
      if (timedOut || attemptsExhausted) {
        const kind = timedOut
          ? "return-timeout"
          : "return-attempts-exhausted";
        const reason = timedOut
          ? `${issue.identifier} exceeded its durable Delivery return deadline ${durableTimeoutAt}`
          : `${issue.identifier} exhausted ${attemptCount}/${maxAttempts} Delivery monitor attempts`;
        if (cycle) {
          cycle.status = timedOut
            ? "blocked_return_timeout"
            : "blocked_return_attempts";
          cycle.invariantViolation = reason;
        }
        const existingInvariantId = timedOut
          ? cycle?.timeoutInvariantIssueId
          : cycle?.attemptInvariantIssueId;
        if (!existingInvariantId) {
          const invariant = await surfaceMonitorInvariant({
            monitor: detailedIssue,
            paperclipIssues,
            kind,
            reason,
            rejectionCommentId,
          });
          if (cycle) {
            if (timedOut) {
              cycle.timeoutInvariantIssueId = invariant.id;
              cycle.timeoutInvariantIdentifier = invariant.identifier;
            } else {
              cycle.attemptInvariantIssueId = invariant.id;
              cycle.attemptInvariantIdentifier = invariant.identifier;
            }
          }
        }
        await ensureIssueComment(
          issue.id,
          `KSNVQA monitor stopped: ${kind}`,
          [
            "## Delivery monitor stopped fail-closed",
            "",
            `KSNVQA monitor stopped: ${kind}`,
            "",
            reason,
            "A source-bound invariant task now owns recovery; this monitor will not re-arm automatically.",
          ].join("\n"),
        );
        if (monitorNeedsTerminalCleanup(detailedIssue, "blocked")) {
          await patchIssue(issue.id, {
            status: "blocked",
            assigneeAgentId: null,
            assigneeUserId: null,
            executionPolicy: null,
          });
          stopped.push(issue.identifier);
        }
        delete notifications[issue.id];
        violations.push(reason);
        continue;
      }
      const interactions = await fetchIssueInteractions(issue.id);
      const ownerDrift =
        detailedIssue.assigneeAgentId !== config.deliveryAgentId ||
        detailedIssue.assigneeUserId != null;
      if (
        !ownerDrift &&
        monitorHasLivePath(detailedIssue, interactions)
      ) {
        delete notifications[issue.id];
        continue;
      }
      if (
        detailedIssue.status !== "in_progress" &&
        detailedIssue.status !== "in_review"
      ) {
        continue;
      }
      const executionPolicy = monitorPolicy(
        detailedIssue,
        rejectionCommentId,
        2 * 60 * 60 * 1000,
        durableTimeoutAt,
      );
      await patchIssue(issue.id, {
        assigneeAgentId: config.deliveryAgentId,
        assigneeUserId: null,
        executionPolicy,
      });
      repaired.push(issue.identifier);
      if (notifications[issue.id]) continue;
      const marker = `KSNVQA monitor repair: ${
        rejectionCommentId || issue.id
      }`;
      await ensureIssueComment(
        issue.id,
        marker,
        [
          "## Delivery monitor invariant repaired",
          "",
          marker,
          "",
          "The zero-token Kasanova lifecycle watcher restored this active QA-return monitor's persisted wake path.",
          "",
          "- Owner: Kasanova Delivery; no user assignee.",
          `- Next check: \`${executionPolicy.monitor.nextCheckAt}\`.`,
          "- Recovery: `wake_owner`, 72-hour timeout, 96-attempt cap.",
          "- Preserve the same Linear issue, immutable rejection ID, and canonical KSNVQA task.",
        ].join("\n"),
      );
      notifications[issue.id] = new Date().toISOString();
    } catch (error) {
      violations.push(
        `${issue.identifier} Delivery monitor repair failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return { notifications, violations, repaired, closed, stopped };
}

function absoluteConfirmationReason(interaction) {
  const text = [
    interaction?.title,
    interaction?.summary,
    interaction?.payload?.prompt,
    interaction?.payload?.detailsMarkdown,
  ]
    .filter(Boolean)
    .join(" ");
  return /\bbrowser\b/i.test(text)
    ? "Browser access cannot be granted through a Paperclip interaction."
    : null;
}

function realProvisioningRequest(interaction) {
  if (isProductionPromotionInteraction(interaction)) return false;
  const headline = [
    interaction?.title,
    interaction?.summary,
    interaction?.payload?.prompt,
    interaction?.payload?.detailsMarkdown,
  ]
    .filter(Boolean)
    .join(" ");
  return /\b(provision(?:ed|ing)?|credential|funded|fixture|lock transfer|lock release|ownership transfer)\b/i.test(
    headline,
  );
}

function forbiddenConfirmationReason(interaction) {
  const headline = [
    interaction?.title,
    interaction?.summary,
    interaction?.payload?.prompt,
  ]
    .filter(Boolean)
    .join(" ");
  const details = String(interaction?.payload?.detailsMarkdown || "");
  const authorization =
    /\b(authori[sz]e|permission|approve|allow|confirm)\b/i.test(headline);
  if (!authorization) return null;
  const absoluteReason = absoluteConfirmationReason(interaction);
  if (absoluteReason) return absoluteReason;
  const toolMethod = String(
    interaction?.payload?.toolAction?.method ||
      interaction?.payload?.toolAction?.httpMethod ||
      "",
  ).toUpperCase();
  const explicitlyReadOnly =
    /\bread[- ]?only\b/i.test(headline) ||
    ["GET", "HEAD", "OPTIONS"].includes(toolMethod) ||
    /\b(authori[sz]e|permission|approve|allow|confirm)\b.{0,48}\b(inspect|query|probe|check status)\b/i.test(
      headline,
    );
  if (explicitlyReadOnly) {
    return "Read-only operations are preauthorized and cannot request approval.";
  }
  const deviceUse =
    /\b(Android|emulator|device|ADB|TN10)\b/i.test(headline) &&
    /\b(use|access|run|test|QA)\b/i.test(headline);
  const realProvisioning = realProvisioningRequest(interaction);
  if (deviceUse && !realProvisioning) {
    return "Assigned Android-device and emulator use is preauthorized.";
  }
  return null;
}

async function enforceInteractionPolicy(
  previousHandled,
  linearStateByIdentifier,
) {
  const handled = Object.fromEntries(
    Object.entries(previousHandled || {}).filter(
      ([, timestamp]) =>
        Date.now() - Date.parse(timestamp) < 30 * 24 * 60 * 60 * 1000,
    ),
  );
  const feed = await fetchJson(
    `${config.paperclipApiUrl}/companies/${config.companyId}/attention?includeDismissed=true`,
  );
  const items = Array.isArray(feed?.items) ? feed.items : [];
  const issueCache = new Map();
  let withdrawn = 0;
  for (const item of items) {
    if (item?.sourceKind !== "issue_thread_interaction") continue;
    if (item?.subject?.metadata?.kind !== "request_confirmation") continue;
    const issueId = item.subject.metadata.issueId;
    const interactionId = item.subject.id;
    if (!issueId || !interactionId || handled[interactionId]) continue;
    const interactions = await fetchJson(
      `${config.paperclipApiUrl}/issues/${issueId}/interactions`,
    );
    const interaction = Array.isArray(interactions)
      ? interactions.find((entry) => entry?.id === interactionId)
      : null;
    if (!interaction || interaction.status !== "pending") continue;
    const productionPromotion =
      isProductionPromotionInteraction(interaction) &&
      !realProvisioningRequest(interaction);
    const absoluteReason = absoluteConfirmationReason(interaction);
    const preauthorizationReason =
      forbiddenConfirmationReason(interaction);
    let productionViolation = null;
    let staleReason = null;
    let expectedIdentifier = null;
    let reason = null;
    if (productionPromotion) {
      let issue = issueCache.get(issueId);
      if (!issue) {
        issue = await fetchPaperclipIssue(issueId);
        issueCache.set(issueId, issue);
      }
      expectedIdentifier =
        String(issue?.title || "").match(/^\[(KSNV-\d+)\]/)?.[1] || null;
      const sourceLinearState = expectedIdentifier
        ? linearStateByIdentifier?.get(expectedIdentifier) || null
        : null;
      staleReason = productionInteractionStaleReason(
        interaction,
        interactions,
        sourceLinearState,
      );
      productionViolation = productionApprovalTargetViolation(
        interaction,
        expectedIdentifier,
      );
      const readOnlyPreauthorization =
        preauthorizationReason ===
        "Read-only operations are preauthorized and cannot request approval.";
      reason =
        staleReason ||
        absoluteReason ||
        (readOnlyPreauthorization ? preauthorizationReason : null) ||
        productionViolation;
    } else {
      reason = preauthorizationReason;
    }
    if (!reason) continue;
    const remediation = staleReason
      ? [
          "- No decision is required from Ren.",
          "- Re-entering `Ready for Release` must create a fresh target-bound confirmation only when the immutable target has changed or no prior acceptance covers it.",
        ]
      : absoluteReason
      ? [
          "- Do not continue the browser operation.",
          "- Browser access requires Ren's exact phrase `USA EL NAVEGADOR` in the current message; a Paperclip interaction cannot substitute for it.",
        ]
      : productionViolation && reason === productionViolation
      ? [
          "- Re-read the live `Ready for Release` state and QA evidence.",
          "- Create a new confirmation whose custom target binds the exact artifact/release revision.",
          "- Include the release path and rollback evidence; revalidate that same target immediately before promotion.",
        ]
      : [
          "- Continue the preauthorized operation directly.",
          "- If a real dependency is missing, request only the concrete provisioning.",
          "- Browser access still requires Ren's exact current-message phrase `USA EL NAVEGADOR`.",
        ];
    const commentBody = [
      staleReason
        ? "## Stale confirmation retired"
        : "## Invalid confirmation rejected",
      "",
      reason,
      "",
      ...remediation,
    ].join("\n");
    if (staleReason) {
      if (
        expectedIdentifier &&
        linearStateByIdentifier?.get(expectedIdentifier) &&
        linearStateByIdentifier.get(expectedIdentifier) !== "Ready for Release"
      ) {
        await patchIssue(issueId, {
          status: "cancelled",
          assigneeAgentId: null,
        });
      }
      // Paperclip confirmations deliberately have no direct cancellation
      // endpoint. A board comment is the canonical supersession mechanism for
      // interactions created with supersedeOnUserComment=true.
      await postIssueComment(issueId, commentBody);
      const refreshed = await fetchIssueInteractions(issueId);
      if (
        refreshed.find((entry) => entry?.id === interactionId)?.status ===
        "pending"
      ) {
        throw new Error(
          `Stale interaction ${interactionId} did not supersede after the board comment`,
        );
      }
    } else {
      await fetchJson(
        `${config.paperclipApiUrl}/issues/${issueId}/interactions/${interactionId}/reject`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason }),
        },
      );
      await postIssueComment(issueId, commentBody);
    }
    handled[interactionId] = new Date().toISOString();
    withdrawn += 1;
  }
  return { handled, withdrawn };
}

function historyKey(issue) {
  return `${issue.id}:${issue.stage.slug}`;
}

function pruneHistory(history, nowMs) {
  const next = {};
  for (const [key, timestamps] of Object.entries(history || {})) {
    const recent = (Array.isArray(timestamps) ? timestamps : [])
      .filter((timestamp) => nowMs - new Date(timestamp).getTime() < config.cycleWindowMs);
    if (recent.length > 0) next[key] = recent;
  }
  return next;
}

function pruneRejectionCycles(cycles, nowMs) {
  const retentionMs = 30 * 24 * 60 * 60 * 1000;
  return Object.fromEntries(
    Object.entries(cycles || {}).filter(([, cycle]) => {
      const terminal =
        String(cycle?.status || "").startsWith("resolved_") ||
        String(cycle?.status || "").startsWith("closed_");
      if (!terminal) return true;
      const resolvedMs = Date.parse(cycle?.resolvedAt || "");
      return !Number.isFinite(resolvedMs) || nowMs - resolvedMs < retentionMs;
    }),
  );
}

function pruneReturnDispatches(dispatches, nowMs) {
  const retentionMs = 30 * 24 * 60 * 60 * 1000;
  return Object.fromEntries(
    Object.entries(dispatches || {}).filter(([, dispatch]) => {
      const dispatchedMs = Date.parse(dispatch?.dispatchedAt || "");
      return (
        !Number.isFinite(dispatchedMs) ||
        nowMs - dispatchedMs < retentionMs
      );
    }),
  );
}

function countByState(issues) {
  return Object.fromEntries(
    stages.map((stage) => [
      stage.state,
      issues.filter((issue) => issue.stage.state === stage.state).length,
    ]),
  );
}

async function pollLifecycle() {
  const now = new Date().toISOString();
  const nowMs = new Date(now).getTime();
  const migratedState = migrateLifecycleState(
    await readJson(stateFile, null),
    now,
  );
  const previous = migratedState
    ? {
        ...migratedState,
        rejectionCycles: pruneRejectionCycles(
          migratedState.rejectionCycles,
          nowMs,
        ),
        returnDispatches: pruneReturnDispatches(
          migratedState.returnDispatches,
          nowMs,
        ),
      }
    : null;
  const issues = await fetchLifecycleIssues();
  const inProgressIssues = await fetchInProgressIssuesWithComments();
  const linearStateByIdentifier = new Map(
    [...issues, ...inProgressIssues].map((issue) => [
      issue.identifier,
      issue.stage?.state || issue.state?.name || null,
    ]),
  );
  const trackedCycleIssues = await fetchTrackedCycleIssuesWithComments(
    previous?.rejectionCycles,
    new Set(inProgressIssues.map((issue) => issue.id)),
  );
  const observedCycleIssues = [...inProgressIssues, ...trackedCycleIssues];
  const newlyResolvedReadyForQa = new Map(
    extractRejectionObservations(observedCycleIssues)
      .filter((observation) => {
        const previousCycle =
          previous?.rejectionCycles?.[observation.comment.id];
        return (
          observation.resolved &&
          observation.issue.state?.name === "Ready for QA" &&
          previousCycle &&
          !String(previousCycle.status || "").startsWith("resolved_") &&
          !String(previousCycle.status || "").startsWith("closed_") &&
          !previous?.returnDispatches?.[observation.resolutionCommentId]
        );
      })
      .map((observation) => [
        observation.issue.id,
        observation.resolutionCommentId,
      ]),
  );
  const paperclipIssues = await fetchPaperclipIssues();

  if (!previous) {
    const active = {};
    const transitionHistory = {};
    const entrySequences = {};
    const dispatchFailures = [];
    let dispatched = 0;
    for (const issue of issues) {
      if (issue.stage.state === "Done") {
        active[issue.id] = {
          identifier: issue.identifier,
          state: issue.stage.state,
          enteredAt: issue.updatedAt,
          initializedFromBaseline: true,
        };
        continue;
      }
      try {
        const key = historyKey(issue);
        const entrySequence = (entrySequences[key] || 0) + 1;
        const run = await dispatchIssue(issue, entrySequence);
        active[issue.id] = {
          identifier: issue.identifier,
          state: issue.stage.state,
          enteredAt: issue.updatedAt,
          routineRunId: run.id,
        };
        transitionHistory[key] = [now];
        entrySequences[key] = entrySequence;
        dispatched += 1;
      } catch (error) {
        dispatchFailures.push(
          `${issue.identifier} in ${issue.stage.state}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        process.stderr.write(
          `${now} failed initial dispatch ${issue.identifier} in ${issue.stage.state}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
    await writeJsonAtomic(stateFile, {
      version: 5,
      initializedAt: now,
      lastPollAt: now,
      active,
      transitionHistory,
      entrySequences,
      returnDispatches: {},
      guardNotifications: {},
      monitorInvariantNotifications: {},
      withdrawnPolicyInteractions: {},
      rejectionCycles: {},
    });
    const rejectionResult = await enforceRejectionCycles(
      inProgressIssues,
      issues,
      observedCycleIssues,
      paperclipIssues,
      {},
    );
    const monitorResult = await enforceDeliveryMonitorInvariant(
      paperclipIssues,
      {},
      rejectionResult.cycles,
    );
    const interactionResult = await enforceInteractionPolicy(
      {},
      linearStateByIdentifier,
    );
    await writeJsonAtomic(stateFile, {
      version: 5,
      initializedAt: now,
      lastPollAt: now,
      active,
      transitionHistory,
      entrySequences,
      returnDispatches: {},
      guardNotifications: {},
      monitorInvariantNotifications: monitorResult.notifications,
      withdrawnPolicyInteractions: interactionResult.handled,
      rejectionCycles: rejectionResult.cycles,
    });
    await writeJsonAtomic(healthFile, {
      status: lifecycleHealthStatus(
        dispatchFailures,
        monitorResult.violations,
        rejectionResult.violations,
      ),
      lastPollAt: now,
      activeByState: countByState(issues),
      initializedFromBaseline: true,
      dispatched,
      dispatchFailures,
      monitorInvariantViolations: monitorResult.violations,
      monitorInvariantRepairs: monitorResult.repaired,
      monitorInvariantClosures: monitorResult.closed,
      monitorInvariantStops: monitorResult.stopped,
      withdrawnInvalidConfirmations: interactionResult.withdrawn,
      rejectionCyclesDetected: rejectionResult.detected,
      rejectionInvariantViolations: rejectionResult.violations,
      rejectionEvidenceWarnings: rejectionResult.evidenceWarnings,
      rejectionInvariantRepairs: rejectionResult.repaired,
      inProgressCount: inProgressIssues.length,
      inProgressIdentifiers: inProgressIssues.map((issue) => issue.identifier),
    });
    await writeJsonAtomic(
      deliveryTreeFile,
      buildDeliveryTreeSnapshot(issues, inProgressIssues, now),
    );
    process.stdout.write(
      `${now} initialized lifecycle watcher with ${issues.length} Kasanova issue(s), ${dispatched} non-Done dispatch(es)\n`,
    );
    return;
  }

  const nextActive = {};
  const transitionHistory = pruneHistory(previous.transitionHistory, nowMs);
  const entrySequences = { ...(previous.entrySequences || {}) };
  const returnDispatches = { ...(previous.returnDispatches || {}) };
  const guardNotifications = Object.fromEntries(
    Object.entries(previous.guardNotifications || {}).filter(([key]) =>
      Object.hasOwn(transitionHistory, key),
    ),
  );
  const guardWarnings = [];
  const dispatchFailures = [];
  let dispatched = 0;
  let guarded = 0;
  for (const issue of issues) {
    const existing = previous.active?.[issue.id];
    const forcedReadyForQaReentry =
      issue.stage.state === "Ready for QA" &&
      newlyResolvedReadyForQa.has(issue.id);
    if (existing?.state === issue.stage.state && !forcedReadyForQaReentry) {
      nextActive[issue.id] = existing;
      continue;
    }
    const key = historyKey(issue);
    const entries = transitionHistory[key] || [];
    if (entries.length >= config.maxStageEntries) {
      if (!guardNotifications[key]) {
        try {
          await reportCycleGuard(issue, paperclipIssues, entries.length);
          guardNotifications[key] = now;
        } catch (error) {
          guardWarnings.push(
            `${issue.identifier} lifecycle guard could not be surfaced: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      nextActive[issue.id] = {
        identifier: issue.identifier,
        state: issue.stage.state,
        enteredAt: issue.updatedAt,
        guardedAt: now,
        guardReason: `${entries.length} stage entries in 24h`,
      };
      guarded += 1;
      continue;
    }
    try {
      const entrySequence = (entrySequences[key] || 0) + 1;
      const run = await dispatchIssue(issue, entrySequence);
      nextActive[issue.id] = {
        identifier: issue.identifier,
        state: issue.stage.state,
        enteredAt: issue.updatedAt,
        routineRunId: run.id,
      };
      transitionHistory[key] = [...entries, now];
      entrySequences[key] = entrySequence;
      if (forcedReadyForQaReentry) {
        const resolutionCommentId =
          newlyResolvedReadyForQa.get(issue.id);
        returnDispatches[resolutionCommentId] = {
          routineRunId: run.id,
          dispatchedAt: now,
        };
      }
      dispatched += 1;
      process.stdout.write(
        `${now} dispatched ${issue.identifier} in ${issue.stage.state} as routine run ${run.id}\n`,
      );
    } catch (error) {
      dispatchFailures.push(
        `${issue.identifier} in ${issue.stage.state}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      process.stderr.write(
        `${now} failed to dispatch ${issue.identifier} in ${issue.stage.state}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  await writeJsonAtomic(stateFile, {
    version: 5,
    initializedAt: previous.initializedAt || now,
    migratedAt: previous.migratedAt,
    lastPollAt: now,
    active: nextActive,
    transitionHistory,
    entrySequences,
    returnDispatches,
    guardNotifications,
    monitorInvariantNotifications:
      previous.monitorInvariantNotifications || {},
    withdrawnPolicyInteractions:
      previous.withdrawnPolicyInteractions || {},
    rejectionCycles: previous.rejectionCycles || {},
  });

  const rejectionResult = await enforceRejectionCycles(
    inProgressIssues,
    issues,
    observedCycleIssues,
    paperclipIssues,
    previous.rejectionCycles,
  );
  const monitorResult = await enforceDeliveryMonitorInvariant(
    paperclipIssues,
    previous.monitorInvariantNotifications,
    rejectionResult.cycles,
  );
  const interactionResult = await enforceInteractionPolicy(
    previous.withdrawnPolicyInteractions,
    linearStateByIdentifier,
  );

  await writeJsonAtomic(stateFile, {
    version: 5,
    initializedAt: previous.initializedAt || now,
    migratedAt: previous.migratedAt,
    lastPollAt: now,
    active: nextActive,
    transitionHistory,
    entrySequences,
    returnDispatches,
    guardNotifications,
    monitorInvariantNotifications: monitorResult.notifications,
    withdrawnPolicyInteractions: interactionResult.handled,
    rejectionCycles: rejectionResult.cycles,
  });
  await writeJsonAtomic(healthFile, {
    status: lifecycleHealthStatus(
      dispatchFailures,
      guardWarnings,
      monitorResult.violations,
      rejectionResult.violations,
    ),
    lastPollAt: now,
    activeByState: countByState(issues),
    dispatched,
    dispatchFailures,
    guarded,
    lifecycleGuardWarnings: guardWarnings,
    monitorInvariantViolations: monitorResult.violations,
    monitorInvariantRepairs: monitorResult.repaired,
    monitorInvariantClosures: monitorResult.closed,
    monitorInvariantStops: monitorResult.stopped,
    withdrawnInvalidConfirmations: interactionResult.withdrawn,
    rejectionCyclesDetected: rejectionResult.detected,
    rejectionInvariantViolations: rejectionResult.violations,
    rejectionEvidenceWarnings: rejectionResult.evidenceWarnings,
    rejectionInvariantRepairs: rejectionResult.repaired,
    inProgressCount: inProgressIssues.length,
    inProgressIdentifiers: inProgressIssues.map((issue) => issue.identifier),
  });
  await writeJsonAtomic(
    deliveryTreeFile,
    buildDeliveryTreeSnapshot(issues, inProgressIssues, now),
  );
  process.stdout.write(
    `${now} lifecycle poll complete: ${issues.length} active, ${dispatched} dispatched, ${guarded} guarded\n`,
  );
}

async function main() {
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const lock = await acquireLock();
  if (!lock) {
    process.stdout.write(
      `${new Date().toISOString()} lifecycle poll skipped: another watcher holds the lock\n`,
    );
    return;
  }
  try {
    await pollLifecycle();
  } catch (error) {
    const now = new Date().toISOString();
    try {
      await writeJsonAtomic(healthFile, {
        status: "error",
        lastPollAt: now,
        error: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // Preserve the original failure when even the health write is unavailable.
    }
    throw error;
  } finally {
    await releaseLock(lock);
  }
}

await main();
