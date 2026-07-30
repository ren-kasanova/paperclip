import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

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
};

const stages = [
  {
    state: "Ready for QA",
    slug: "ready_for_qa",
    event: "linear.issue.entered_ready_for_qa",
    routineId: process.env.PAPERCLIP_RFQA_ROUTINE_ID,
  },
  {
    state: "Ready for Release",
    slug: "ready_for_release",
    event: "linear.issue.entered_ready_for_release",
    routineId: process.env.PAPERCLIP_RFR_ROUTINE_ID,
  },
  {
    state: "Production Validation",
    slug: "production_validation",
    event: "linear.issue.entered_production_validation",
    routineId: process.env.PAPERCLIP_PRODUCTION_VALIDATION_ROUTINE_ID,
  },
  {
    state: "Done",
    slug: "done",
    event: "linear.issue.entered_done",
    routineId: process.env.PAPERCLIP_DONE_ROUTINE_ID,
  },
];

const stateFile = path.join(config.stateDir, "state.json");
const healthFile = path.join(config.stateDir, "health.json");

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

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
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

async function fetchLifecycleIssues() {
  const results = await Promise.all(
    stages.map(async (stage) => {
      const issues = await fetchIssuesByState(stage.state);
      return issues.map((issue) => ({ ...issue, stage }));
    }),
  );
  return results.flat();
}

async function dispatchIssue(issue) {
  return fetchJson(`${config.paperclipApiUrl}/routines/${issue.stage.routineId}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: "api",
      projectId: config.projectId,
      projectWorkspaceId: config.projectWorkspaceId,
      assigneeAgentId: config.assigneeAgentId,
      idempotencyKey: `linear-stage:${issue.id}:${issue.stage.slug}:${issue.updatedAt}`,
      variables: {
        linear_identifier: issue.identifier,
        linear_title: issue.title,
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
  const issues = await fetchJson(
    `${config.paperclipApiUrl}/companies/${config.companyId}/issues`,
  );
  if (!Array.isArray(issues)) {
    throw new Error("Paperclip company issues endpoint returned an invalid response");
  }
  return issues;
}

async function postIssueComment(issueId, body) {
  return fetchJson(`${config.paperclipApiUrl}/issues/${issueId}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
}

async function patchIssue(issueId, body) {
  return fetchJson(`${config.paperclipApiUrl}/issues/${issueId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function reportCycleGuard(issue, paperclipIssues, count) {
  const prefix = `[${issue.identifier}]`;
  const candidates = paperclipIssues
    .filter((entry) =>
      typeof entry?.title === "string" &&
      entry.title.startsWith(prefix) &&
      !["done", "cancelled"].includes(entry.status),
    )
    .sort((left, right) =>
      String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")),
    );
  const target = candidates[0];
  if (!target?.id) {
    throw new Error(`No active Paperclip issue found for lifecycle guard ${issue.identifier}`);
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
}

async function enforceDeliveryMonitorInvariant(paperclipIssues, previousNotifications) {
  const notifications = { ...(previousNotifications || {}) };
  const violations = [];
  const repaired = [];
  for (const issue of paperclipIssues) {
    const isMonitor =
      typeof issue?.title === "string" &&
      issue.title.endsWith("— Delivery QA-return monitor");
    const eligibleStatus = ["in_progress", "in_review"].includes(issue?.status);
    if (!isMonitor || !eligibleStatus) continue;

    const hasLiveExecutionPath =
      Boolean(issue.executionRunId) ||
      Boolean(issue.checkoutRunId) ||
      ["queued", "running"].includes(issue.executionState?.status);
    if (hasLiveExecutionPath) {
      delete notifications[issue.id];
      continue;
    }

    const violation =
      issue.assigneeAgentId !== config.deliveryAgentId ||
      issue.assigneeUserId != null ||
      !issue.monitorNextCheckAt;
    if (!violation) {
      delete notifications[issue.id];
      continue;
    }
    const nextCheckAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const timeoutAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const linearIdentifier =
      typeof issue.title === "string"
        ? issue.title.match(/^\[(KSNV-\d+)\]/)?.[1]
        : null;
    await patchIssue(issue.id, {
      assigneeAgentId: config.deliveryAgentId,
      assigneeUserId: null,
      executionPolicy: {
        mode: issue.executionPolicy?.mode || "normal",
        stages: Array.isArray(issue.executionPolicy?.stages)
          ? issue.executionPolicy.stages
          : [],
        monitor: {
          kind: "external_service",
          serviceName: "Kasanova QA lifecycle",
          externalRef: [
            linearIdentifier ? `linear:${linearIdentifier}` : null,
            `paperclip:${issue.identifier}`,
          ].filter(Boolean).join("|"),
          nextCheckAt: nextCheckAt.toISOString(),
          timeoutAt: timeoutAt.toISOString(),
          maxAttempts: 96,
          recoveryPolicy: "wake_owner",
          notes:
            "Persist the existing QA-return delivery loop, recheck the immutable rejection and canonical KSNVQA task, and never advance a QA-owned gate.",
        },
        commentRequired: true,
      },
    });
    repaired.push(issue.identifier);
    if (notifications[issue.id]) continue;
    await postIssueComment(
      issue.id,
      [
        "## Delivery monitor invariant repaired",
        "",
        "The zero-token Kasanova lifecycle watcher restored this active QA-return monitor's persisted wake path.",
        "",
        "- Owner: Kasanova Delivery; no user assignee.",
        `- Next check: \`${nextCheckAt.toISOString()}\`.`,
        "- Recovery: `wake_owner`, 72-hour timeout, 96-attempt cap.",
        "- Preserve the same Linear issue, immutable rejection ID, and canonical KSNVQA task.",
      ].join("\n"),
    );
    notifications[issue.id] = new Date().toISOString();
  }
  return { notifications, violations, repaired };
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
  if (/\bbrowser\b/i.test(`${headline} ${details}`)) {
    return "Browser access cannot be granted through a Paperclip interaction.";
  }
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
  const realProvisioning =
    /\b(provision|credential|funded|fixture|lock transfer|lock release|ownership transfer)\b/i.test(
      `${headline} ${details}`,
    );
  if (deviceUse && !realProvisioning) {
    return "Assigned Android-device and emulator use is preauthorized.";
  }
  return null;
}

async function enforceInteractionPolicy(previousHandled) {
  const handled = { ...(previousHandled || {}) };
  const feed = await fetchJson(
    `${config.paperclipApiUrl}/companies/${config.companyId}/attention`,
  );
  const items = Array.isArray(feed?.items) ? feed.items : [];
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
    const reason = forbiddenConfirmationReason(interaction);
    if (!reason) continue;
    await fetchJson(
      `${config.paperclipApiUrl}/issues/${issueId}/interactions/${interactionId}/reject`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason }),
      },
    );
    await postIssueComment(
      issueId,
      [
        "## Invalid confirmation rejected",
        "",
        reason,
        "",
        "- Continue the preauthorized operation directly.",
        "- If a real dependency is missing, request only the concrete provisioning.",
        "- Browser access still requires Ren's exact current-message phrase `USA EL NAVEGADOR`.",
      ].join("\n"),
    );
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

function countByState(issues) {
  return Object.fromEntries(
    stages.map((stage) => [
      stage.state,
      issues.filter((issue) => issue.stage.state === stage.state).length,
    ]),
  );
}

async function main() {
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const previous = await readJson(stateFile, null);
  const issues = await fetchLifecycleIssues();
  const now = new Date().toISOString();
  const nowMs = new Date(now).getTime();
  const paperclipIssues = await fetchPaperclipIssues();

  if (previous && ![2, 3].includes(previous.version)) {
    throw new Error(`Unsupported lifecycle watcher state version: ${previous.version}`);
  }

  let state = previous;
  if (previous?.version === 2) {
    state = {
      ...previous,
      version: 3,
      migratedAt: now,
      transitionHistory: {},
      guardNotifications: {},
      monitorInvariantNotifications: {},
      withdrawnPolicyInteractions: {},
    };
  }

  if (!state) {
    const active = {};
    const transitionHistory = {};
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
        const run = await dispatchIssue(issue);
        active[issue.id] = {
          identifier: issue.identifier,
          state: issue.stage.state,
          enteredAt: issue.updatedAt,
          routineRunId: run.id,
        };
        transitionHistory[historyKey(issue)] = [now];
        dispatched += 1;
      } catch (error) {
        process.stderr.write(
          `${now} failed initial dispatch ${issue.identifier} in ${issue.stage.state}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
    const monitorResult = await enforceDeliveryMonitorInvariant(paperclipIssues, {});
    const interactionResult = await enforceInteractionPolicy({});
    await writeJsonAtomic(stateFile, {
      version: 3,
      initializedAt: now,
      lastPollAt: now,
      active,
      transitionHistory,
      guardNotifications: {},
      monitorInvariantNotifications: monitorResult.notifications,
      withdrawnPolicyInteractions: interactionResult.handled,
    });
    await writeJsonAtomic(healthFile, {
      status: "ok",
      lastPollAt: now,
      activeByState: countByState(issues),
      initializedFromBaseline: true,
      dispatched,
      monitorInvariantViolations: monitorResult.violations,
      monitorInvariantRepairs: monitorResult.repaired,
      withdrawnInvalidConfirmations: interactionResult.withdrawn,
    });
    process.stdout.write(
      `${now} initialized lifecycle watcher with ${issues.length} Kasanova issue(s), ${dispatched} non-Done dispatch(es)\n`,
    );
    return;
  }

  const nextActive = {};
  const transitionHistory = pruneHistory(state.transitionHistory, nowMs);
  const guardNotifications = { ...(state.guardNotifications || {}) };
  let dispatched = 0;
  let guarded = 0;
  for (const issue of issues) {
    const existing = state.active?.[issue.id];
    if (existing?.state === issue.stage.state) {
      nextActive[issue.id] = existing;
      continue;
    }
    const key = historyKey(issue);
    const entries = transitionHistory[key] || [];
    if (entries.length >= config.maxStageEntries) {
      if (!guardNotifications[key]) {
        await reportCycleGuard(issue, paperclipIssues, entries.length);
        guardNotifications[key] = now;
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
      const run = await dispatchIssue(issue);
      nextActive[issue.id] = {
        identifier: issue.identifier,
        state: issue.stage.state,
        enteredAt: issue.updatedAt,
        routineRunId: run.id,
      };
      transitionHistory[key] = [...entries, now];
      dispatched += 1;
      process.stdout.write(
        `${now} dispatched ${issue.identifier} in ${issue.stage.state} as routine run ${run.id}\n`,
      );
    } catch (error) {
      process.stderr.write(
        `${now} failed to dispatch ${issue.identifier} in ${issue.stage.state}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  const monitorResult = await enforceDeliveryMonitorInvariant(
    paperclipIssues,
    state.monitorInvariantNotifications,
  );
  const interactionResult = await enforceInteractionPolicy(
    state.withdrawnPolicyInteractions,
  );

  await writeJsonAtomic(stateFile, {
    version: 3,
    initializedAt: state.initializedAt || now,
    migratedAt: state.migratedAt,
    lastPollAt: now,
    active: nextActive,
    transitionHistory,
    guardNotifications,
    monitorInvariantNotifications: monitorResult.notifications,
    withdrawnPolicyInteractions: interactionResult.handled,
  });
  await writeJsonAtomic(healthFile, {
    status: "ok",
    lastPollAt: now,
    activeByState: countByState(issues),
    dispatched,
    guarded,
    monitorInvariantViolations: monitorResult.violations,
    monitorInvariantRepairs: monitorResult.repaired,
    withdrawnInvalidConfirmations: interactionResult.withdrawn,
  });
  process.stdout.write(
    `${now} lifecycle poll complete: ${issues.length} active, ${dispatched} dispatched, ${guarded} guarded\n`,
  );
}

await main();
