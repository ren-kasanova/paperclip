const apiBase = (
  process.env.PAPERCLIP_API_BASE || "http://127.0.0.1:3100/api"
).replace(/\/+$/, "");
const checkOnly = process.argv.includes("--check");

const ids = {
  company: "0590afb4-7120-45c8-9109-62ad5098bb5f",
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
};

const routineDescriptions = {
  [ids.routines.qa]:
    "Event task for one Kasanova Linear issue that just entered Ready for QA. Use the issue payload as the exact source ticket. Require development artifact/build/version, deployed commit or PR, QA instructions, automated-test evidence, limitations, and real TN10 acceptance. PASS records complete evidence and moves the same Linear issue to Ready for Release. A defect, missing criterion, missing readiness evidence, or deployment problem preserves the existing assignee, posts exactly one structured QA REJECTED comment, records its immutable comment ID in the KSNVQA ticket, and returns the same Linear issue to In Progress. Every read-only operation and assigned Android-device/emulator use is preauthorized and must run without an interaction. Create a Ren-facing interaction only for a named state-changing, provisioning, destructive, financial, security-sensitive, publication, merge, deployment, or production effect. Browser and web access remain prohibited unless Ren's current message says USA EL NAVEGADOR; an interaction cannot grant browser access. Never use mocks or another company profile.",
  [ids.routines.release]:
    "Event task for one Kasanova Linear issue that just entered Ready for Release. Verify the exact QA-approved artifact, TN10 evidence, release commit/build, rollout and rollback notes, and unresolved blockers. KSNVQA owns the production-promotion gate: execute only the exact authorized release path and route every genuinely required state-changing, deployment, publication, security-sensitive, financial, or production approval to Ren. Read-only checks and assigned Android-device/emulator use are preauthorized and must not create interactions. After production is verified by immutable deployment ID, timestamp, service/app version, and artifact digest, attach promotion evidence and move the same Linear issue to Production Validation. On release blocker, regression, or required implementation change, preserve ownership, record evidence, and return the issue to In Progress. Browser and web access remain prohibited unless Ren's current message says USA EL NAVEGADOR; an interaction cannot grant browser access. Never use mocks or move funds.",
  [ids.routines.production]:
    "Event task for one Kasanova Linear issue that just entered Production Validation. Gather real production evidence for every acceptance criterion: deployment/build/version identifier, timestamp, affected service or app, direct behavior evidence, health and regression signals, and confirmation that no scoped work remains. PASS writes a structured closeout evidence comment and moves the same Linear issue to Done. FAIL records exact production evidence and returns the issue to In Progress with its owner preserved. Execute every read-only check directly without an interaction. Create a Ren-facing interaction only for a named state-changing, provisioning, destructive, financial, security-sensitive, publication, merge, deployment, or production effect. Do not infer production correctness from deployment alone, mocks, or stale evidence. Browser and web access remain prohibited unless Ren's current message says USA EL NAVEGADOR; an interaction cannot grant browser access.",
  [ids.routines.done]:
    "Event task for one Kasanova Linear issue that just entered Done. Audit that the issue has immutable TN10 evidence, production deployment and validation evidence, every acceptance criterion satisfied, and no unresolved blocker, regression, deployment task, or validation task. If complete, add or normalize one concise closeout evidence record and leave the issue Done. If production evidence is missing, return it to Production Validation; if implementation or regression work remains, return it to In Progress. Preserve the existing owner and explain the exact missing closeout condition. Execute every read-only check directly without an interaction. Create a Ren-facing interaction only for a named state-changing, provisioning, destructive, financial, security-sensitive, publication, merge, deployment, or production effect. Browser and web access remain prohibited unless Ren's current message says USA EL NAVEGADOR; an interaction cannot grant browser access. Never use mocks.",
  [ids.routines.fallback]:
    "Fallback only; the zero-token Linear intake is the primary signal. Every 8 hours, use the Kasanova profile and exact linear-kasanova connection to reconcile KSNV tickets in Ready for QA, Ready for Release, Production Validation, or Done. Run only the matching gate when the event intake missed a real state entry or when durable evidence is incomplete. Ready for QA tests the exact development artifact and advances PASS to Ready for Release or returns one structured rejection to In Progress. Ready for Release owns exact-artifact production promotion through the existing authorized path, with real required state-changing or production approvals routed to Ren, then advances to Production Validation. Production Validation gathers direct production evidence and advances PASS to Done or returns failure to In Progress. Done audits TN10 evidence, production evidence, acceptance criteria, and unresolved work. Every read-only operation and assigned Android-device/emulator use is preauthorized and must run without an interaction. Create a Ren-facing interaction only for a named state-changing, provisioning, destructive, financial, security-sensitive, publication, merge, deployment, or production effect. Browser and web access remain prohibited unless Ren's current message says USA EL NAVEGADOR; an interaction cannot grant browser access. Never use mocks or fabricated evidence.",
};

async function fetchJson(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
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

async function reconcileAgent(agentId, mutate, label) {
  const agent = await fetchJson(`/agents/${agentId}`);
  const nextConfig = mutate(structuredClone(agent.adapterConfig || {}));
  if (JSON.stringify(nextConfig) !== JSON.stringify(agent.adapterConfig || {})) {
    await patch(`/agents/${agentId}`, { adapterConfig: nextConfig }, label);
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
    const concurrencyPolicy = eventRoutineIds.has(routineId)
      ? "always_enqueue"
      : "coalesce_if_active";
    if (routine.concurrencyPolicy !== concurrencyPolicy || routine.description !== description) {
      await patch(
        `/routines/${routineId}`,
        { concurrencyPolicy, description },
        `routine ${routine.title}`,
      );
    }
  }
}

async function reconcileIssueMetadata() {
  const issues = await fetchJson(`/companies/${ids.company}/issues`);
  const productivity = issues.find((entry) => entry.identifier === "KSNVQA-50");
  const productivityTitle =
    "[KSNV-161] dApp browser signPsbt/signPsbts QA return — productivity review for KSNVQA-35";
  if (productivity && productivity.title !== productivityTitle) {
    await patch(
      `/issues/${productivity.id}`,
      { title: productivityTitle },
      "KSNVQA-50 title",
    );
  }

  const monitor = issues.find((entry) => entry.identifier === "KSNVQA-53");
  if (!monitor) throw new Error("Missing KSNVQA-53 delivery monitor");
  const hasLiveExecutionPath =
    Boolean(monitor.executionRunId) ||
    Boolean(monitor.checkoutRunId) ||
    ["queued", "running"].includes(monitor.executionState?.status);
  if (!monitor.monitorNextCheckAt && !hasLiveExecutionPath) {
    const nextCheckAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const timeoutAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
    await patch(
      `/issues/${monitor.id}`,
      {
        executionPolicy: {
          mode: "normal",
          stages: [],
          monitor: {
            kind: "external_service",
            serviceName: "Kasanova QA lifecycle",
            externalRef: "linear:KSNV-121;paperclip:KSNVQA-52",
            nextCheckAt: nextCheckAt.toISOString(),
            timeoutAt: timeoutAt.toISOString(),
            maxAttempts: 96,
            recoveryPolicy: "wake_owner",
            notes:
              "Watch the canonical KSNV-121 QA handoff and KSNVQA-52 closeout evidence; re-arm at two hours while QA or an external owner is active.",
          },
          commentRequired: true,
        },
      },
      "KSNVQA-53 persisted monitor",
    );
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
    config.env.PAPERCLIP_COMPANY_ID = plain(ids.company);
    config.env.PAPERCLIP_DELIVERY_AGENT_ID = plain(ids.delivery);
    return config;
  },
  "Kasanova Lifecycle Intake agent",
);

await reconcileRoutines();
await reconcileIssueMetadata();

if (checkOnly && drift) process.exitCode = 1;
