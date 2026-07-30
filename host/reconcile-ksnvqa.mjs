const apiBase = (
  process.env.PAPERCLIP_API_BASE || "http://127.0.0.1:3100/api"
).replace(/\/+$/, "");
const checkOnly = process.argv.includes("--check");

const ids = {
  company: "0590afb4-7120-45c8-9109-62ad5098bb5f",
  project: "07f395d6-b361-4331-b326-adad957aaf1d",
  projectWorkspace: "4f5e4412-0d9b-46a9-8c0e-80d3196877e3",
  qa: "c4917415-0eb2-4122-9adb-4868343c9850",
  delivery: "e6f72275-d3c5-4caf-baa5-d01adca1568d",
  intake: "8a0574a8-c666-4926-ba96-59dc351cd8fd",
  routines: {
    done: "9806d6af-3fc7-4232-9d28-be456d13f562",
    release: "fc6245c6-dde0-4755-b313-a67d55ad0b01",
    production: "bc35cbe2-631a-4840-bae6-61ed6abce5aa",
    qa: "d9e19810-ca44-4472-91e8-2ee1d1ab820e",
    fallback: "9a48acd0-3ac3-4f62-b685-2f7411bb0de4",
  },
  fallbackTrigger: "e9b7b55b-c4f3-45e0-8987-e1568f1dba65",
};

const sourceVariables = [
  {
    name: "linear_identifier",
    type: "text",
    label: "Linear ticket",
    options: [],
    required: true,
    defaultValue: null,
  },
  {
    name: "linear_title",
    type: "text",
    label: "Linear subject",
    options: [],
    required: true,
    defaultValue: null,
  },
];

const routineTitles = {
  [ids.routines.qa]:
    "[{{linear_identifier}}] {{linear_title}} — Ready for QA",
  [ids.routines.release]:
    "[{{linear_identifier}}] {{linear_title}} — production promotion",
  [ids.routines.production]:
    "[{{linear_identifier}}] {{linear_title}} — production validation",
  [ids.routines.done]:
    "[{{linear_identifier}}] {{linear_title}} — Done evidence audit",
  [ids.routines.fallback]:
    "[LINEAR-SWEEP] Kasanova lifecycle fallback monitor — every 8 hours",
};

const routineDescriptions = {
  [ids.routines.qa]:
    "Event task for one Kasanova Linear issue that just entered Ready for QA. Use the issue payload as the exact source ticket. Require development artifact/build/version, deployed commit or PR, QA instructions, automated-test evidence, limitations, and real TN10 acceptance. PASS records complete evidence and moves the same Linear issue to Ready for Release. A defect, missing criterion, missing readiness evidence, or deployment problem preserves the existing assignee, posts exactly one structured QA REJECTED comment whose first line and required labels follow company policy, records its immutable comment ID in the KSNVQA ticket, and returns the same Linear issue to In Progress. The zero-token intake then durably routes that immutable rejection to the single Delivery monitor. Every read-only operation and assigned Android-device/emulator use is preauthorized and must run without an interaction. Create a Ren-facing interaction only for a named state-changing, provisioning, destructive, financial, security-sensitive, publication, merge, deployment, or production effect. Browser and web access remain prohibited unless Ren's current message says USA EL NAVEGADOR; an interaction cannot grant browser access. Never use mocks or another company profile.",
  [ids.routines.release]:
    "Event task for one Kasanova Linear issue that just entered Ready for Release. Verify the exact QA-approved artifact, TN10 evidence, release commit/build, rollout and rollback notes, and unresolved blockers. KSNVQA owns the production-promotion gate: execute only the exact authorized release path and route every genuinely required state-changing, deployment, publication, security-sensitive, financial, or production approval to Ren. A promotion confirmation must use a custom target key KSNV-###:production-promotion:<release-path>, bind target.revisionId to the immutable approved artifact or release revision, and name the artifact, digest, release path, and rollback evidence. Immediately before promotion, re-read the live Ready for Release state and accepted interaction and prove the target still matches; drift requires a new confirmation. Read-only checks and assigned Android-device/emulator use are preauthorized and must not create interactions. After production is verified by immutable deployment ID, timestamp, service/app version, and artifact digest, attach promotion evidence and move the same Linear issue to Production Validation. On release blocker, regression, or required implementation change, preserve ownership, record evidence, and return the issue to In Progress. Browser and web access remain prohibited unless Ren's current message says USA EL NAVEGADOR; an interaction cannot grant browser access. Never use mocks or move funds.",
  [ids.routines.production]:
    "Event task for one Kasanova Linear issue that just entered Production Validation. Gather real production evidence for every acceptance criterion: deployment/build/version identifier, timestamp, affected service or app, direct behavior evidence, health and regression signals, and confirmation that no scoped work remains. PASS writes a structured closeout evidence comment and moves the same Linear issue to Done. FAIL records exact production evidence and returns the issue to In Progress with its owner preserved. Execute every read-only check directly without an interaction. Create a Ren-facing interaction only for a named state-changing, provisioning, destructive, financial, security-sensitive, publication, merge, deployment, or production effect. Do not infer production correctness from deployment alone, mocks, or stale evidence. Browser and web access remain prohibited unless Ren's current message says USA EL NAVEGADOR; an interaction cannot grant browser access.",
  [ids.routines.done]:
    "Event task for one Kasanova Linear issue that just entered Done. Audit that the issue has immutable TN10 evidence, production deployment and validation evidence, every acceptance criterion satisfied, and no unresolved blocker, regression, deployment task, or validation task. If complete, add or normalize one concise closeout evidence record and leave the issue Done. If production evidence is missing, return it to Production Validation; if implementation or regression work remains, return it to In Progress. Preserve the existing owner and explain the exact missing closeout condition. Execute every read-only check directly without an interaction. Create a Ren-facing interaction only for a named state-changing, provisioning, destructive, financial, security-sensitive, publication, merge, deployment, or production effect. Browser and web access remain prohibited unless Ren's current message says USA EL NAVEGADOR; an interaction cannot grant browser access. Never use mocks.",
  [ids.routines.fallback]:
    "Fallback only; the zero-token Linear intake is the primary signal. Every 8 hours, use the Kasanova profile and exact linear-kasanova connection to reconcile KSNV tickets in Ready for QA, Ready for Release, Production Validation, or Done. Run only the matching gate when the event intake missed a real state entry or when durable evidence is incomplete. Ready for QA tests the exact development artifact and advances PASS to Ready for Release or returns one structured rejection to In Progress; the intake ledger routes that immutable rejection to one Delivery monitor. Ready for Release owns exact-artifact production promotion through the existing authorized path, with an immutable custom approval target and all genuinely required state-changing or production approvals routed to Ren, then advances to Production Validation. Revalidate the accepted target immediately before promotion. Production Validation gathers direct production evidence and advances PASS to Done or returns failure to In Progress. Done audits TN10 evidence, production evidence, acceptance criteria, and unresolved work. Every read-only operation and assigned Android-device/emulator use is preauthorized and must run without an interaction. Create a Ren-facing interaction only for a named state-changing, provisioning, destructive, financial, security-sensitive, publication, merge, deployment, or production effect. Browser and web access remain prohibited unless Ren's current message says USA EL NAVEGADOR; an interaction cannot grant browser access. Never use mocks or fabricated evidence.",
};

async function fetchJson(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    signal: options.signal || AbortSignal.timeout(10_000),
    headers: {
      accept: "application/json",
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${path}: ${body?.error || response.status}`);
  }
  return body;
}

async function patch(path, body, label) {
  if (checkOnly) {
    process.stderr.write(`drift: ${label}\n`);
    return;
  }
  await fetchJson(path, { method: "PATCH", body: JSON.stringify(body) });
  process.stdout.write(`reconciled ${label}\n`);
}

function plain(value) {
  return { type: "plain", value };
}

async function reconcileAgent(agentId, mutate, label, mutateRuntime = null) {
  const agent = await fetchJson(`/agents/${agentId}`);
  const nextConfig = mutate(structuredClone(agent.adapterConfig || {}));
  const nextRuntime = mutateRuntime
    ? mutateRuntime(structuredClone(agent.runtimeConfig || {}))
    : agent.runtimeConfig || {};
  const body = {};
  if (JSON.stringify(nextConfig) !== JSON.stringify(agent.adapterConfig || {})) {
    body.adapterConfig = nextConfig;
  }
  if (JSON.stringify(nextRuntime) !== JSON.stringify(agent.runtimeConfig || {})) {
    body.runtimeConfig = nextRuntime;
  }
  if (Object.keys(body).length > 0) {
    await patch(`/agents/${agentId}`, body, label);
  }
  if (agent.pauseReason === "manual") {
    if (checkOnly) {
      process.stderr.write(`drift: ${label} manual pause reason\n`);
    } else {
      await fetchJson(`/agents/${agentId}/resume`, {
        method: "POST",
        body: "{}",
      });
      process.stdout.write(`cleared ${label} manual pause reason\n`);
    }
  }
}

async function reconcileRoutines() {
  const routines = await fetchJson(`/companies/${ids.company}/routines`);
  const eventRoutineIds = new Set([
    ids.routines.qa,
    ids.routines.release,
    ids.routines.production,
    ids.routines.done,
  ]);
  for (const routineId of Object.values(ids.routines)) {
    const routine = routines.find((entry) => entry.id === routineId);
    if (!routine) throw new Error(`Missing KSNVQA routine ${routineId}`);
    const description = routineDescriptions[routineId];
    const title = routineTitles[routineId];
    const concurrencyPolicy = eventRoutineIds.has(routineId)
      ? "always_enqueue"
      : "coalesce_if_active";
    const variables = eventRoutineIds.has(routineId) ? sourceVariables : [];
    if (
      routine.concurrencyPolicy !== concurrencyPolicy ||
      routine.description !== description ||
      routine.title !== title ||
      JSON.stringify(routine.variables || []) !== JSON.stringify(variables)
    ) {
      await patch(
        `/routines/${routineId}`,
        { concurrencyPolicy, description, title, variables },
        `routine ${routine.title}`,
      );
    }
  }
  const fallback = routines.find((entry) => entry.id === ids.routines.fallback);
  const trigger = fallback?.triggers?.find(
    (entry) => entry.id === ids.fallbackTrigger,
  );
  if (!trigger) throw new Error(`Missing KSNVQA fallback trigger ${ids.fallbackTrigger}`);
  if (
    trigger.kind !== "schedule" ||
    trigger.enabled !== true ||
    trigger.cronExpression !== "0 */8 * * *" ||
    trigger.timezone !== "America/Monterrey"
  ) {
    await patch(
      `/routine-triggers/${ids.fallbackTrigger}`,
      {
        enabled: true,
        cronExpression: "0 */8 * * *",
        timezone: "America/Monterrey",
      },
      "Kasanova lifecycle fallback schedule",
    );
  }
}

async function reconcileIssueMetadata() {
  const issues = await fetchJson(`/companies/${ids.company}/issues`);
  for (const issue of issues) {
    if (
      typeof issue.title === "string" &&
      issue.title.endsWith("— QA-return delivery monitor")
    ) {
      await patch(
        `/issues/${issue.id}`,
        {
          title: issue.title.replace(
            /— QA-return delivery monitor$/,
            "— Delivery QA-return monitor",
          ),
        },
        `${issue.identifier} canonical Delivery monitor title`,
      );
    }
    if (
      issue.projectId === ids.project &&
      !/^\[(?:KSNV-\d+|LINEAR-SWEEP)\]\s+\S/.test(String(issue.title || ""))
    ) {
      throw new Error(
        `${issue.identifier} has a Kasanova lifecycle title without an exact Linear prefix: ${issue.title}`,
      );
    }
  }
}

let drift = false;
const originalWrite = process.stderr.write.bind(process.stderr);
if (checkOnly) {
  process.stderr.write = (chunk, ...args) => {
    if (String(chunk).startsWith("drift:")) drift = true;
    return originalWrite(chunk, ...args);
  };
}

await reconcileAgent(
  ids.qa,
  (config) => {
    config.env ||= {};
    config.env.CODEX_HOME = plain("/paperclip-codex/kasanova-qa");
    config.env.ADB_SERVER_SOCKET = plain("tcp:host.docker.internal:5038");
    config.env.ODESSA_ANDROID_DEVICE_LOCK = plain(
      "/odessa-root/USING_ANDROID_DEVICE.lock",
    );
    // Ren explicitly authorized Kasanova QA on 2026-07-30 to bypass Codex's
    // unavailable nested sandbox/approval layer. Paperclip Landlock remains
    // the mandatory filesystem boundary, and governed effects still route
    // through Paperclip plus DECK·7.
    config.dangerouslyBypassApprovalsAndSandbox = true;
    config.extraArgs = ["--skip-git-repo-check"];
    config.timeoutSec = 3600;
    config.outputInactivityTimeoutMs = 420000;
    config.filesystemScope = "workspace";
    config.filesystemSandboxBackend = "landlock";
    config.filesystemSandboxCommand = "/usr/local/bin/paperclip-landlock";
    config.filesystemExtraPaths = [
      { path: "/odessa-root/USING_ANDROID_DEVICE.lock", access: "ro" },
      {
        path: "/Volumes/OdessaExt/Paperclip/companies/KSNVQA",
        access: "ro",
      },
    ];
    return config;
  },
  "Kasanova QA agent",
);

await reconcileAgent(
  ids.delivery,
  (config) => {
    config.env ||= {};
    config.env.CODEX_HOME = plain("/paperclip-codex/kasanova-delivery");
    config.env.ODESSA_ANDROID_DEVICE_LOCK = plain(
      "/odessa-root/USING_ANDROID_DEVICE.lock",
    );
    config.filesystemScope = "workspace";
    config.filesystemSandboxBackend = "landlock";
    config.filesystemSandboxCommand = "/usr/local/bin/paperclip-landlock";
    config.filesystemExtraPaths = [
      { path: "/odessa-root/USING_ANDROID_DEVICE.lock", access: "ro" },
      {
        path: "/Volumes/OdessaExt/Paperclip/companies/KSNVQA",
        access: "ro",
      },
    ];
    return config;
  },
  "Kasanova Delivery agent",
);

await reconcileAgent(
  ids.intake,
  (config) => {
    config.env ||= {};
    config.cwd = "/app";
    config.command = "node";
    config.args = ["/opt/paperclip-watcher/ksnvqa-rfqa-intake.mjs"];
    config.timeoutSec = 45;
    config.env.STATE_DIR = plain(
      "/paperclip/instances/default/data/ksnvqa-rfqa-intake",
    );
    config.env.KSNVQA_PAPERCLIP_API_URL = plain("http://127.0.0.1:3101/api");
    config.env.LINEAR_IDENTIFIER_PREFIX = plain("KSNV-");
    config.env.PAPERCLIP_COMPANY_ID = plain(ids.company);
    config.env.PAPERCLIP_PROJECT_ID = plain(ids.project);
    config.env.PAPERCLIP_PROJECT_WORKSPACE_ID = plain(ids.projectWorkspace);
    config.env.PAPERCLIP_ASSIGNEE_AGENT_ID = plain(ids.qa);
    config.env.PAPERCLIP_DELIVERY_AGENT_ID = plain(ids.delivery);
    config.env.PAPERCLIP_RFQA_ROUTINE_ID = plain(ids.routines.qa);
    config.env.PAPERCLIP_RFR_ROUTINE_ID = plain(ids.routines.release);
    config.env.PAPERCLIP_PRODUCTION_VALIDATION_ROUTINE_ID = plain(
      ids.routines.production,
    );
    config.env.PAPERCLIP_DONE_ROUTINE_ID = plain(ids.routines.done);
    return config;
  },
  "Kasanova Lifecycle Intake agent",
  (runtime) => {
    runtime.heartbeat = {
      ...(runtime.heartbeat || {}),
      enabled: true,
      intervalSec: 60,
      wakeOnOnDemand: true,
      wakeOnAssignment: false,
      wakeOnAutomation: true,
      maxConcurrentRuns: 1,
    };
    return runtime;
  },
);

await reconcileRoutines();
await reconcileIssueMetadata();

if (checkOnly && drift) process.exitCode = 1;
