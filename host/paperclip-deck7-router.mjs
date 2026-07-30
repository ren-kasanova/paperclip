import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const home = os.homedir();
const config = {
  apiBase: (process.env.PAPERCLIP_DECK7_API_BASE || "http://127.0.0.1:3100/api").replace(
    /\/+$/,
    "",
  ),
  stateDir:
    process.env.PAPERCLIP_DECK7_STATE_DIR ||
    path.join(home, ".paperclip-deck7-router"),
  deck7Path: process.env.PAPERCLIP_DECK7_CLI || path.join(home, ".deck7", "deck7"),
  agentRegistryPath:
    process.env.PAPERCLIP_DECK7_AGENT_REGISTRY ||
    path.join(home, ".deck7", "agents.json"),
  paperclipAuthTokenPath:
    process.env.PAPERCLIP_DECK7_AUTH_TOKEN_FILE ||
    path.join(
      process.env.PAPERCLIP_DECK7_STATE_DIR ||
        path.join(home, ".paperclip-deck7-router"),
      "auth-token",
    ),
  deck7Source: "paperclip",
  requestTimeoutMs: 20_000,
  deck7TimeoutMs: 10_000,
  promptTtlSec: 86_400,
  baselineRearmMs: 5 * 60 * 1000,
};

const stateFile = path.join(config.stateDir, "state.json");
const lockFile = path.join(config.stateDir, "router.lock");
const mode = process.argv.includes("--bootstrap")
  ? "bootstrap"
  : process.argv.includes("--check")
    ? "check"
    : "once";

function log(message, details = undefined) {
  const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
  process.stdout.write(`${new Date().toISOString()} ${message}${suffix}\n`);
}

function logError(message, error) {
  const safeMessage = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `${new Date().toISOString()} ${message} ${JSON.stringify({ error: safeMessage })}\n`,
  );
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}

async function acquireLock() {
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  await chmod(config.stateDir, 0o700);

  try {
    await writeFile(
      lockFile,
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  const existingLock = await readJson(lockFile, null);
  const existingPid = Number(existingLock?.pid);
  if (Number.isSafeInteger(existingPid) && existingPid > 0) {
    try {
      process.kill(existingPid, 0);
      process.exitCode = 0;
      return false;
    } catch (error) {
      if (error?.code === "EPERM") {
        process.exitCode = 0;
        return false;
      }
      if (error?.code !== "ESRCH") throw error;
    }
  }

  const lockStat = await stat(lockFile);
  if (Date.now() - lockStat.mtimeMs < 120_000) {
    process.exitCode = 0;
    return false;
  }

  await unlink(lockFile);
  await writeFile(
    lockFile,
    `${JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      recoveredStaleLock: true,
    })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return true;
}

async function releaseLock() {
  try {
    await unlink(lockFile);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(
      `${options.method || "GET"} ${url} returned non-JSON HTTP ${response.status}`,
    );
  }
  if (!response.ok) {
    const message =
      typeof body?.error === "string"
        ? body.error
        : typeof body?.message === "string"
          ? body.message
          : `HTTP ${response.status}`;
    throw new Error(`${options.method || "GET"} ${url} failed: ${message}`);
  }
  return body;
}

async function loadDeck7Credential() {
  const registry = await readJson(config.agentRegistryPath, null);
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    throw new Error("DECK7 agent registry is unavailable or invalid");
  }
  const token = registry[config.deck7Source];
  if (typeof token !== "string" || !token.trim()) {
    throw new Error(
      `DECK7 source ${config.deck7Source} is not provisioned in the agent registry`,
    );
  }
  return token.trim();
}

async function loadPaperclipAuthToken() {
  const token = (await readFile(config.paperclipAuthTokenPath, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    throw new Error("Paperclip DECK7 router auth token is unavailable or invalid");
  }
  return token;
}

class Deck7CommandError extends Error {
  constructor(message, { httpStatus = null } = {}) {
    super(message);
    this.name = "Deck7CommandError";
    this.httpStatus = httpStatus;
  }
}

async function runDeck7(args, token) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(config.deck7Path, args, {
      env: {
        ...process.env,
        DECK7_AGENT_SOURCE: config.deck7Source,
        DECK7_AGENT_TOKEN: token,
      },
      timeout: config.deck7TimeoutMs,
      maxBuffer: 1024 * 1024,
    }));
  } catch (error) {
    const stderr = truncateAscii(error?.stderr || "", 500);
    const httpStatusMatch = stderr.match(/\bHTTP(?: Error)?\s+(\d{3})\b/i);
    throw new Deck7CommandError(
      stderr
        ? `DECK7 ${args[0] || "command"} failed: ${stderr}`
        : `DECK7 ${args[0] || "command"} failed`,
      {
        httpStatus: httpStatusMatch ? Number(httpStatusMatch[1]) : null,
      },
    );
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`DECK7 CLI returned invalid JSON for ${args[0] || "command"}`);
  }
}

function ascii(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateAscii(value, maxBytes) {
  const normalized = ascii(value);
  if (Buffer.byteLength(normalized, "utf8") <= maxBytes) return normalized;
  return `${normalized.slice(0, Math.max(0, maxBytes - 3)).trimEnd()}...`;
}

function readRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function isRoutable(item) {
  return (
    item?.sourceKind === "approval" ||
    item?.sourceKind === "issue_thread_interaction"
  );
}

function isActionable(item) {
  if (item?.sourceKind === "approval") return true;
  const metadata = readRecord(item?.subject?.metadata);
  return (
    item?.sourceKind === "issue_thread_interaction" &&
    metadata.kind === "request_confirmation"
  );
}

function fingerprint(item) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: item.id,
        sourceKind: item.sourceKind,
        activityAt: item.activityAt,
        title: item.subject?.title,
        status: item.subject?.status,
        metadata: item.subject?.metadata,
        detail: item.detail,
        decisionVerbs: item.decisionVerbs,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

function safeCompanyKey(company) {
  return ascii(company.issuePrefix || company.name || company.id)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 12) || company.id.replace(/-/g, "").slice(0, 8);
}

function promptId(company, item, itemFingerprint, attempt) {
  const subjectId = String(item.subject?.id || item.id)
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 20);
  return truncateAscii(
    `pc.${safeCompanyKey(company)}.${subjectId}.${itemFingerprint.slice(0, 8)}.${attempt}`,
    64,
  );
}

function decisionLabel(item) {
  const accepted = Array.isArray(item.decisionVerbs)
    ? item.decisionVerbs.find((entry) =>
        ["accept", "approve"].includes(String(entry?.id || "").toLowerCase()),
      )
    : null;
  return truncateAscii(accepted?.label || "Approve", 64) || "Approve";
}

function promptCopy(company, item, actionable) {
  const ticket = item.relatedIssue?.identifier || company.issuePrefix || "Paperclip";
  const subjectTitle = item.subject?.title || "Decision required";
  const relatedTitle = item.relatedIssue?.title;
  const excerpt =
    item.detail?.promptExcerpt ||
    item.detail?.summaryExcerpt ||
    item.detail?.firstQuestionText ||
    item.whyNow ||
    "";
  const title = truncateAscii(`${ticket}: ${subjectTitle}`, 80);
  const lines = [
    relatedTitle ? truncateAscii(relatedTitle, 180) : null,
    excerpt ? truncateAscii(excerpt, 360) : null,
    actionable
      ? "Approve relays only to this exact pending Paperclip decision. Hold leaves it pending for changes."
      : `Open Paperclip ${ticket} to answer; this notice does not resolve it.`,
  ].filter(Boolean);
  return {
    title,
    body: truncateAscii(lines.join(" "), 700),
  };
}

function retryDelayMs(status) {
  if (status === "dismissed") return 60 * 60 * 1000;
  return 60 * 1000;
}

async function getCompaniesAndAttention() {
  await fetchJson(`${config.apiBase}/health`);
  const companies = await fetchJson(`${config.apiBase}/companies`);
  if (!Array.isArray(companies)) {
    throw new Error("Paperclip companies endpoint returned an invalid response");
  }

  const activeCompanies = companies.filter(
    (company) => company && company.status !== "archived",
  );
  const feeds = await Promise.all(
    activeCompanies.map(async (company) => {
      const feed = await fetchJson(
        `${config.apiBase}/companies/${encodeURIComponent(company.id)}/attention`,
      );
      const items = Array.isArray(feed?.items) ? feed.items.filter(isRoutable) : [];
      return { company, items };
    }),
  );
  return feeds;
}

async function createPrompt(company, item, itemFingerprint, attempt, token) {
  const actionable = isActionable(item);
  const copy = promptCopy(company, item, actionable);
  const id = promptId(company, item, itemFingerprint, attempt);
  const args = [
    "prompt",
    "--id",
    id,
    "--title",
    copy.title,
    "--body",
    copy.body,
    "--priority",
    actionable ? "urgent" : "high",
    "--ttl",
    String(config.promptTtlSec),
  ];
  if (actionable) {
    args.push("--choice", `approve=${decisionLabel(item)}`);
    args.push("--choice", "hold=Hold - open Paperclip");
  }
  let result;
  try {
    result = await runDeck7(args, token);
  } catch (promptError) {
    try {
      result = await runDeck7(["result", "--id", id], token);
      log("recovered DECK7 prompt after transport timeout", {
        promptId: id,
        status: result?.status ?? null,
      });
    } catch {
      throw promptError;
    }
  }
  if (
    !["queued", "answered", "acknowledged", "dismissed", "expired"].includes(
      result?.status,
    )
  ) {
    throw new Error(`DECK7 did not persist prompt ${id}`);
  }
  return {
    promptId: id,
    promptStatus: result.status,
    actionable,
    attempt,
  };
}

function decisionProvenance(existing) {
  return {
    source: "deck7",
    promptId: existing.promptId,
    choiceId: "approve",
    respondedAt: new Date().toISOString(),
    responseDigest: createHash("sha256")
      .update(
        JSON.stringify({
          attentionId: existing.attentionId,
          promptId: existing.promptId,
          fingerprint: existing.fingerprint,
          choiceId: "approve",
        }),
      )
      .digest("hex"),
  };
}

async function acceptExactDecision(item, existing, paperclipAuthToken) {
  const provenance = decisionProvenance(existing);
  const authenticatedHeaders = {
    "x-paperclip-deck7-token": paperclipAuthToken,
  };
  if (item.sourceKind === "issue_thread_interaction") {
    const metadata = readRecord(item.subject?.metadata);
    const issueId = metadata.issueId;
    const interactionId = item.subject?.id;
    if (
      metadata.kind !== "request_confirmation" ||
      typeof issueId !== "string" ||
      typeof interactionId !== "string"
    ) {
      throw new Error("Pending interaction is not an exact request_confirmation target");
    }
    const interactions = await fetchJson(
      `${config.apiBase}/issues/${encodeURIComponent(issueId)}/interactions`,
    );
    const current = Array.isArray(interactions)
      ? interactions.find((entry) => entry?.id === interactionId)
      : null;
    if (!current || current.status !== "pending") {
      return { outcome: "already_resolved" };
    }
    if (current.kind !== "request_confirmation") {
      throw new Error("Interaction kind changed before DECK7 acceptance");
    }
    const accepted = await fetchJson(
      `${config.apiBase}/issues/${encodeURIComponent(issueId)}/interactions/${encodeURIComponent(interactionId)}/accept`,
      {
        method: "POST",
        headers: authenticatedHeaders,
        body: JSON.stringify({ decisionProvenance: provenance }),
      },
    );
    return {
      outcome: accepted?.status === "accepted" ? "accepted" : "unexpected_status",
      status: accepted?.status ?? null,
    };
  }

  if (item.sourceKind === "approval") {
    const approvalId = item.subject?.id;
    if (typeof approvalId !== "string") {
      throw new Error("Pending approval has no stable subject ID");
    }
    const current = await fetchJson(
      `${config.apiBase}/approvals/${encodeURIComponent(approvalId)}`,
    );
    if (current?.status !== "pending") {
      return { outcome: "already_resolved" };
    }
    const approved = await fetchJson(
      `${config.apiBase}/approvals/${encodeURIComponent(approvalId)}/approve`,
      {
        method: "POST",
        headers: authenticatedHeaders,
        body: JSON.stringify({
          decisionNote: `Approved through authenticated DECK7 prompt ${provenance.promptId}.`,
          decisionProvenance: provenance,
        }),
      },
    );
    return {
      outcome: approved?.status === "approved" ? "approved" : "unexpected_status",
      status: approved?.status ?? null,
    };
  }

  throw new Error("Unsupported Paperclip decision source");
}

async function handleActiveItem(
  company,
  item,
  entries,
  deck7Token,
  paperclipAuthToken,
) {
  const itemFingerprint = fingerprint(item);
  const existing = entries[item.id];

  if (
    existing?.status === "baseline_ignored" &&
    existing.fingerprint === itemFingerprint
  ) {
    const baselineAt = new Date(existing.baselineAt || 0).getTime();
    if (Date.now() - baselineAt < config.baselineRearmMs) return false;
    log("re-arming pending Paperclip attention after bounded bootstrap suppression", {
      issue: existing.issueIdentifier,
      attentionId: item.id,
      baselineAt: existing.baselineAt,
    });
  }
  if (
    ["relayed", "held", "notified"].includes(existing?.status) &&
    existing.fingerprint === itemFingerprint
  ) {
    return false;
  }

  if (
    existing?.status === "awaiting_retry" &&
    existing.fingerprint === itemFingerprint &&
    Date.now() < new Date(existing.retryAfter).getTime()
  ) {
    return false;
  }

  if (
    !existing ||
    existing.fingerprint !== itemFingerprint ||
    existing.status === "awaiting_retry" ||
    existing.status === "baseline_ignored"
  ) {
    const attempt =
      existing?.fingerprint === itemFingerprint ? (existing.attempt || 0) + 1 : 1;
    const queued = await createPrompt(
      company,
      item,
      itemFingerprint,
      attempt,
      deck7Token,
    );
    entries[item.id] = {
      attentionId: item.id,
      companyId: company.id,
      companyKey: company.issuePrefix || company.name,
      subjectId: item.subject?.id ?? null,
      issueId: item.subject?.metadata?.issueId ?? item.relatedIssue?.id ?? null,
      issueIdentifier: item.relatedIssue?.identifier ?? null,
      sourceKind: item.sourceKind,
      fingerprint: itemFingerprint,
      status: "queued",
      queuedAt: new Date().toISOString(),
      ...queued,
    };
    log("queued Paperclip attention on DECK7", {
      company: company.issuePrefix || company.name,
      issue: item.relatedIssue?.identifier ?? null,
      attentionId: item.id,
      promptId: queued.promptId,
      actionable: queued.actionable,
    });
    return true;
  }

  if (existing.status !== "queued") return false;
  let result;
  try {
    result = await runDeck7(["result", "--id", existing.promptId], deck7Token);
  } catch (error) {
    if (!(error instanceof Deck7CommandError) || error.httpStatus !== 404) {
      throw error;
    }
    entries[item.id] = {
      ...existing,
      status: "awaiting_retry",
      terminalDeckStatus: "missing",
      retryAfter: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    log("scheduled replacement for missing DECK7 prompt", {
      issue: existing.issueIdentifier,
      attentionId: item.id,
      promptId: existing.promptId,
      attempt: existing.attempt,
    });
    return true;
  }
  if (result?.status === "queued") return false;

  if (result?.status === "answered") {
    const choiceId = result?.response?.choice_id;
    if (choiceId === "hold") {
      entries[item.id] = {
        ...existing,
        status: "held",
        answeredAt: new Date().toISOString(),
        choiceId,
      };
      log("Paperclip decision held on DECK7", {
        issue: existing.issueIdentifier,
        attentionId: item.id,
      });
      return true;
    }
    if (choiceId !== "approve") {
      throw new Error(`Unexpected DECK7 choice for ${existing.promptId}`);
    }
    const relay = await acceptExactDecision(
      item,
      existing,
      paperclipAuthToken,
    );
    if (
      !["accepted", "approved", "already_resolved"].includes(relay.outcome)
    ) {
      throw new Error(
        `Paperclip returned ${relay.status || relay.outcome} while relaying approval`,
      );
    }
    entries[item.id] = {
      ...existing,
      status: "relayed",
      answeredAt: new Date().toISOString(),
      relayedAt: new Date().toISOString(),
      choiceId,
      paperclipOutcome: relay.outcome,
    };
    log("relayed DECK7 approval to exact Paperclip decision", {
      issue: existing.issueIdentifier,
      attentionId: item.id,
      outcome: relay.outcome,
    });
    return true;
  }

  if (result?.status === "acknowledged") {
    entries[item.id] = {
      ...existing,
      status: "notified",
      acknowledgedAt: new Date().toISOString(),
    };
    log("Paperclip attention notice acknowledged on DECK7", {
      issue: existing.issueIdentifier,
      attentionId: item.id,
    });
    return true;
  }

  if (["dismissed", "expired", "cancelled"].includes(result?.status)) {
    entries[item.id] = {
      ...existing,
      status: "awaiting_retry",
      terminalDeckStatus: result.status,
      retryAfter: new Date(Date.now() + retryDelayMs(result.status)).toISOString(),
      updatedAt: new Date().toISOString(),
    };
    log("scheduled DECK7 attention retry", {
      issue: existing.issueIdentifier,
      attentionId: item.id,
      deckStatus: result.status,
      attempt: existing.attempt,
    });
    return true;
  }

  throw new Error(
    `DECK7 returned unsupported lifecycle status ${String(result?.status)}`,
  );
}

async function reconcileMissing(activeIds, entries, token) {
  let changed = false;
  for (const [attentionId, entry] of Object.entries(entries)) {
    if (activeIds.has(attentionId) || entry.status !== "queued") continue;
    try {
      const result = await runDeck7(["result", "--id", entry.promptId], token);
      if (result?.status === "queued") {
        await runDeck7(["cancel", "--id", entry.promptId], token);
      }
    } catch (error) {
      logError("could not cancel stale DECK7 prompt", error);
    }
    entries[attentionId] = {
      ...entry,
      status: "resolved_elsewhere",
      resolvedElsewhereAt: new Date().toISOString(),
    };
    changed = true;
  }
  return changed;
}

async function bootstrap(feeds, state) {
  let count = 0;
  for (const { company, items } of feeds) {
    for (const item of items) {
      if (state.entries[item.id]) continue;
      state.entries[item.id] = {
        attentionId: item.id,
        companyId: company.id,
        companyKey: company.issuePrefix || company.name,
        subjectId: item.subject?.id ?? null,
        issueId: item.subject?.metadata?.issueId ?? item.relatedIssue?.id ?? null,
        issueIdentifier: item.relatedIssue?.identifier ?? null,
        sourceKind: item.sourceKind,
        fingerprint: fingerprint(item),
        status: "baseline_ignored",
        baselineAt: new Date().toISOString(),
      };
      count += 1;
    }
  }
  state.updatedAt = new Date().toISOString();
  await writeJsonAtomic(stateFile, state);
  log("bootstrapped existing Paperclip attention without prompting", { count });
}

async function runOnce(feeds, state, deck7Token, paperclipAuthToken) {
  let changed = false;
  const activeIds = new Set();
  for (const { company, items } of feeds) {
    for (const item of items) {
      activeIds.add(item.id);
      try {
        if (
          await handleActiveItem(
            company,
            item,
            state.entries,
            deck7Token,
            paperclipAuthToken,
          )
        ) {
          changed = true;
          state.updatedAt = new Date().toISOString();
          await writeJsonAtomic(stateFile, state);
        }
      } catch (error) {
        logError(
          `failed to route ${item.relatedIssue?.identifier || item.id}`,
          error,
        );
      }
    }
  }
  if (await reconcileMissing(activeIds, state.entries, deck7Token)) changed = true;
  if (changed) {
    state.updatedAt = new Date().toISOString();
    await writeJsonAtomic(stateFile, state);
  }
}

async function main() {
  let lockHeld = false;
  if (mode !== "check") {
    const acquired = await acquireLock();
    if (acquired === false) return;
    lockHeld = true;
  }
  try {
    const deck7Token = await loadDeck7Credential();
    const paperclipAuthToken = await loadPaperclipAuthToken();
    const feeds = await getCompaniesAndAttention();
    const state = await readJson(stateFile, {
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      entries: {},
    });
    if (state.version !== 1 || typeof state.entries !== "object") {
      throw new Error("Paperclip DECK7 router state has an unsupported schema");
    }

    if (mode === "check") {
      log("Paperclip DECK7 router check passed", {
        companies: feeds.length,
        routableAttention: feeds.reduce((sum, feed) => sum + feed.items.length, 0),
        source: config.deck7Source,
      });
      return;
    }
    if (mode === "bootstrap") {
      await bootstrap(feeds, state);
      return;
    }
    await runOnce(feeds, state, deck7Token, paperclipAuthToken);
  } finally {
    if (lockHeld) await releaseLock();
  }
}

main().catch((error) => {
  logError("Paperclip DECK7 router failed", error);
  process.exitCode = 1;
});
