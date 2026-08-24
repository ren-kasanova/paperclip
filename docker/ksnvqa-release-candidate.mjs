#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASE_CANDIDATE_SCHEMA = "ksnvqa.release-candidate.v2";
export const DEFAULT_RELEASE_CANDIDATE_PATH =
  "/Volumes/OdessaExt/Kasanova/KSNVQA_RELEASE_CANDIDATE.lock";

const blockingStatuses = new Set(["preparing", "active", "repairing"]);
const allowedMergeKinds = new Set([
  "main-sync",
  "qa-rejection-revert",
  "candidate-repair",
  "promotion",
]);
const repositoryNames = ["app", "core", "design"];
const repositories = new Set(repositoryNames);
const mutationLockStaleMs = 2 * 60 * 1000;
const mutationLockWaitMs = 10_000;

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`Missing ${label}`);
  return normalized;
}

function sha(value, label) {
  const normalized = required(value, label).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`${label} must be a full 40-character Git SHA`);
  }
  return normalized;
}

function historyFile(file) {
  return `${file}.history.jsonl`;
}

function audit(candidate, action, details, now) {
  return [
    ...(Array.isArray(candidate?.audit) ? candidate.audit : []),
    { action, at: now, ...(details || {}) },
  ];
}

function requireOwner(candidate, input) {
  const paperclipIssueId = required(
    input?.paperclipIssueId,
    "candidate owner Paperclip issue ID",
  );
  if (candidate?.owner?.paperclipIssueId !== paperclipIssueId) {
    throw new Error(
      `Candidate ${candidate?.batchId || "unknown"} is owned by ${candidate?.owner?.paperclipIdentifier || candidate?.owner?.paperclipIssueId || "unknown"}; ${paperclipIssueId} cannot mutate it`,
    );
  }
  return paperclipIssueId;
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function acquireMutationLock(file) {
  const lockFile = `${file}.mutation.lock`;
  const deadline = Date.now() + mutationLockWaitMs;
  while (Date.now() < deadline) {
    try {
      const handle = await open(lockFile, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, token: randomUUID(), acquiredAt: new Date().toISOString() })}\n`,
      );
      return { handle, lockFile };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const lockStat = await stat(lockFile);
        if (Date.now() - lockStat.mtimeMs > mutationLockStaleMs) {
          await unlink(lockFile);
          continue;
        }
      } catch (lockError) {
        if (lockError?.code === "ENOENT") continue;
        throw lockError;
      }
      await wait(25);
    }
  }
  throw new Error(`Timed out waiting for candidate mutation lock ${lockFile}`);
}

async function withMutationLock(file, mutation) {
  await mkdir(path.dirname(file), { recursive: true });
  const lock = await acquireMutationLock(file);
  try {
    return await mutation();
  } finally {
    await lock.handle.close().catch(() => {});
    await unlink(lock.lockFile).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

export function normalizeTicketIdentifiers(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(",");
  const identifiers = [
    ...new Set(source.map((entry) => String(entry).trim()).filter(Boolean)),
  ].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true }),
  );
  for (const identifier of identifiers) {
    if (!/^KSNV-\d+$/.test(identifier)) {
      throw new Error(`Invalid Kasanova Linear identifier: ${identifier}`);
    }
  }
  if (identifiers.length === 0) {
    throw new Error("At least one KSNV ticket is required");
  }
  return identifiers;
}

export function candidateFingerprint({
  appDevSha,
  coreDevSha,
  designDevSha,
  tickets,
}) {
  return createHash("sha256")
    .update(
      `${sha(appDevSha, "app dev SHA")}:${sha(coreDevSha, "core dev SHA")}:${sha(designDevSha, "design dev SHA")}:${normalizeTicketIdentifiers(tickets).join(",")}`,
    )
    .digest("hex");
}

export function mergeGate(candidate, mergeKind = "feature") {
  if (!candidate || !blockingStatuses.has(candidate.status)) {
    return { allowed: true, reason: "No active KSNVQA release-candidate lock." };
  }
  if (allowedMergeKinds.has(mergeKind)) {
    return {
      allowed: true,
      reason: `Merge kind ${mergeKind} is allowed while candidate ${candidate.batchId} is ${candidate.status}.`,
    };
  }
  return {
    allowed: false,
    reason:
      `Candidate ${candidate.batchId} is ${candidate.status}; unrelated merges into dev are paused. ` +
      "Only main sync, QA-rejection revert, candidate repair, and promotion mutations may proceed.",
  };
}

export async function readCandidate(file = DEFAULT_RELEASE_CANDIDATE_PATH) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeCandidate(file, candidate) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(candidate, null, 2)}\n`, {
    mode: 0o644,
  });
  await rename(temporary, file);
  return candidate;
}

async function historyContains(file, batchId) {
  try {
    return (await readFile(historyFile(file), "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .some((line) => {
        try {
          return JSON.parse(line)?.batchId === batchId;
        } catch {
          return false;
        }
      });
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function appendHistoryOnce(file, candidate) {
  if (await historyContains(file, candidate.batchId)) return;
  await appendFile(historyFile(file), `${JSON.stringify(candidate)}\n`, {
    mode: 0o644,
  });
}

export async function openCandidate(file, input, now = new Date().toISOString()) {
  return withMutationLock(file, async () => {
    const existing = await readCandidate(file);
    if (existing && blockingStatuses.has(existing.status)) {
      if (existing.owner?.paperclipIssueId === input.paperclipIssueId) return existing;
      throw new Error(
        `Candidate ${existing.batchId} is already ${existing.status} under ${existing.owner?.paperclipIdentifier || existing.owner?.paperclipIssueId}`,
      );
    }
    if (existing?.status === "released") await appendHistoryOnce(file, existing);
    const tickets = normalizeTicketIdentifiers(input.tickets);
    const ownerIssueId = required(input.paperclipIssueId, "Paperclip issue ID");
    const seed = `${now}:${tickets.join(",")}:${ownerIssueId}`;
    const batchId =
      `ksnvqa-${now.replace(/[-:.TZ]/g, "").slice(0, 14)}-` +
      createHash("sha256").update(seed).digest("hex").slice(0, 8);
    return writeCandidate(file, {
      schema: RELEASE_CANDIDATE_SCHEMA,
      status: "preparing",
      batchId,
      createdAt: now,
      updatedAt: now,
      owner: {
        paperclipIssueId: ownerIssueId,
        paperclipIdentifier: required(
          input.paperclipIdentifier,
          "Paperclip identifier",
        ),
      },
      tickets,
      source: null,
      candidateFingerprint: null,
      repair: null,
      repairHistory: [],
      promotion: null,
      audit: [{ action: "opened", at: now, paperclipIssueId: ownerIssueId }],
    });
  });
}

function compensationComplete(candidate) {
  const previous = candidate?.repair?.previousPromotion;
  if (!previous) return true;
  return repositoryNames.every((repository) => {
    if (!previous?.[repository]?.mergedMainSha) return true;
    return Boolean(candidate?.repair?.compensation?.[repository]?.restoredMainSha);
  });
}

function requireRecordedReleasedPromotion(candidate) {
  if (
    !candidate?.releasedAt ||
    candidate?.promotion?.state !== "released" ||
    !candidate?.candidateFingerprint
  ) {
    throw new Error(
      `Released candidate ${candidate?.batchId || "unknown"} has no complete recorded promotion to compensate`,
    );
  }

  const tickets = normalizeTicketIdentifiers(candidate.tickets);
  const source = {};
  for (const repository of repositoryNames) {
    const pinned = candidate.source?.[repository];
    const promoted = candidate.promotion?.[repository];
    source[repository] = {
      devSha: sha(pinned?.devSha, `${repository} pinned dev SHA`),
      mainSha: sha(pinned?.mainSha, `${repository} pre-candidate main SHA`),
    };
    const headSha = sha(promoted?.headSha, `${repository} promotion head SHA`);
    const mergedHeadSha = sha(
      promoted?.mergedHeadSha,
      `${repository} merged promotion head SHA`,
    );
    sha(promoted?.mergedMainSha, `${repository} merged main SHA`);
    required(promoted?.pullRequest, `${repository} promotion pull request`);
    required(promoted?.mergedAt, `${repository} promotion merge timestamp`);
    if (headSha !== source[repository].devSha || mergedHeadSha !== headSha) {
      throw new Error(
        `Released candidate ${candidate.batchId} has an invalid ${repository} promotion record`,
      );
    }
  }

  const fingerprint = candidateFingerprint({
    appDevSha: source.app.devSha,
    coreDevSha: source.core.devSha,
    designDevSha: source.design.devSha,
    tickets,
  });
  if (candidate.candidateFingerprint !== fingerprint) {
    throw new Error(
      `Released candidate ${candidate.batchId} fingerprint does not match its recorded source`,
    );
  }
  return candidate.promotion;
}

export async function pinCandidate(file, input, now = new Date().toISOString()) {
  return withMutationLock(file, async () => {
    const existing = await readCandidate(file);
    if (!existing || !["preparing", "repairing", "active"].includes(existing.status)) {
      throw new Error("Open a release candidate before pinning it");
    }
    const ownerIssueId = requireOwner(existing, input);
    if (existing.status === "repairing" && !compensationComplete(existing)) {
      throw new Error(
        `Candidate ${existing.batchId} has an unreconciled partial promotion; record every compensating revert before pinning`,
      );
    }
    const tickets = normalizeTicketIdentifiers(input.tickets || existing.tickets);
    const source = {
      app: {
        devSha: sha(input.appDevSha, "app dev SHA"),
        mainSha: sha(input.appMainSha, "app main SHA"),
      },
      core: {
        devSha: sha(input.coreDevSha, "core dev SHA"),
        mainSha: sha(input.coreMainSha, "core main SHA"),
      },
      design: {
        devSha: sha(input.designDevSha, "design dev SHA"),
        mainSha: sha(input.designMainSha, "design main SHA"),
      },
    };
    const fingerprint = candidateFingerprint({
      appDevSha: source.app.devSha,
      coreDevSha: source.core.devSha,
      designDevSha: source.design.devSha,
      tickets,
    });
    if (existing.status === "active" && existing.candidateFingerprint !== fingerprint) {
      throw new Error(
        `Active candidate ${existing.batchId} is immutable; mark it repairing before changing its source SHAs`,
      );
    }
    const samePinnedCandidate =
      existing.status === "active" &&
      existing.candidateFingerprint === fingerprint;
    const repairHistory = [
      ...(existing.repairHistory || []),
      ...(existing.status === "repairing" && existing.repair
        ? [{ ...existing.repair, completedAt: now }]
        : []),
    ];
    return writeCandidate(file, {
      ...existing,
      schema: RELEASE_CANDIDATE_SCHEMA,
      status: "active",
      updatedAt: now,
      tickets,
      source,
      candidateFingerprint: fingerprint,
      repair: null,
      repairHistory,
      promotion: samePinnedCandidate ? existing.promotion : null,
      audit: audit(existing, "pinned", { paperclipIssueId: ownerIssueId, fingerprint }, now),
    });
  });
}

export async function repairCandidate(file, input, now = new Date().toISOString()) {
  return withMutationLock(file, async () => {
    const existing = await readCandidate(file);
    if (
      !existing ||
      !["preparing", "active", "repairing", "released"].includes(existing.status)
    ) {
      throw new Error("No active release candidate can enter repair");
    }
    const ownerIssueId = requireOwner(existing, input);
    const reason = required(input.reason, "repair reason");
    const rejectionId = input.rejectionId
      ? required(input.rejectionId, "rejection ID")
      : existing.repair?.rejectionId || null;
    const linearIdentifier = input.linearIdentifier
      ? required(input.linearIdentifier, "Linear identifier")
      : existing.repair?.linearIdentifier || null;
    if (
      existing.status === "repairing" &&
      existing.repair?.reason === reason &&
      existing.repair?.rejectionId === rejectionId &&
      existing.repair?.linearIdentifier === linearIdentifier
    ) {
      return existing;
    }
    const previousPromotion =
      existing.status === "released"
        ? requireRecordedReleasedPromotion(existing)
        : existing.promotion || existing.repair?.previousPromotion || null;
    return writeCandidate(file, {
      ...existing,
      status: "repairing",
      updatedAt: now,
      repair: {
        reason,
        rejectionId,
        linearIdentifier,
        enteredAt: existing.repair?.enteredAt || now,
        previousPromotion,
        compensation: existing.repair?.compensation || {},
      },
      promotion: null,
      audit: audit(existing, "repairing", { paperclipIssueId: ownerIssueId }, now),
    });
  });
}

export async function stageCandidatePromotion(
  file,
  input,
  now = new Date().toISOString(),
) {
  return withMutationLock(file, async () => {
    const existing = await readCandidate(file);
    if (!existing || existing.status !== "active" || !existing.candidateFingerprint) {
      throw new Error("Only a pinned active candidate can stage promotion");
    }
    const ownerIssueId = requireOwner(existing, input);
    const appPullRequest = required(input.appPullRequest, "app pull request");
    const corePullRequest = required(input.corePullRequest, "core pull request");
    const designPullRequest = required(
      input.designPullRequest,
      "design pull request",
    );
    const appHeadSha = sha(input.appHeadSha, "app promotion head SHA");
    const coreHeadSha = sha(input.coreHeadSha, "core promotion head SHA");
    const designHeadSha = sha(
      input.designHeadSha,
      "design promotion head SHA",
    );
    if (
      appHeadSha !== existing.source?.app?.devSha ||
      coreHeadSha !== existing.source?.core?.devSha ||
      designHeadSha !== existing.source?.design?.devSha
    ) {
      throw new Error(
        `Promotion heads must equal the pinned app/core/design dev SHAs for candidate ${existing.batchId}`,
      );
    }
    if (
      existing.promotion &&
      (existing.promotion.app?.pullRequest !== appPullRequest ||
        existing.promotion.core?.pullRequest !== corePullRequest ||
        existing.promotion.design?.pullRequest !== designPullRequest ||
        existing.promotion.app?.headSha !== appHeadSha ||
        existing.promotion.core?.headSha !== coreHeadSha ||
        existing.promotion.design?.headSha !== designHeadSha)
    ) {
      throw new Error(`Candidate ${existing.batchId} already staged different promotion PRs or heads`);
    }
    return writeCandidate(file, {
      ...existing,
      updatedAt: now,
      promotion: existing.promotion || {
        state: "ready",
        stagedAt: now,
        app: {
          pullRequest: appPullRequest,
          headSha: appHeadSha,
          mergedMainSha: null,
          mergedAt: null,
        },
        core: {
          pullRequest: corePullRequest,
          headSha: coreHeadSha,
          mergedMainSha: null,
          mergedAt: null,
        },
        design: {
          pullRequest: designPullRequest,
          headSha: designHeadSha,
          mergedMainSha: null,
          mergedAt: null,
        },
      },
      audit: audit(existing, "promotion-staged", { paperclipIssueId: ownerIssueId }, now),
    });
  });
}

export async function recordCandidateMerge(
  file,
  input,
  now = new Date().toISOString(),
) {
  return withMutationLock(file, async () => {
    const existing = await readCandidate(file);
    if (!existing || existing.status !== "active" || !existing.promotion) {
      throw new Error("Stage all three promotion PRs before recording a merge");
    }
    const ownerIssueId = requireOwner(existing, input);
    const repository = required(input.repository, "repository");
    if (!repositories.has(repository)) {
      throw new Error("repository must be app, core, or design");
    }
    const mergedHeadSha = sha(input.headSha, `${repository} merged PR head SHA`);
    const mergedMainSha = sha(input.mainSha, `${repository} merged main SHA`);
    const current = existing.promotion[repository];
    if (mergedHeadSha !== current.headSha) {
      throw new Error(
        `${repository} merged head ${mergedHeadSha} does not equal staged head ${current.headSha}`,
      );
    }
    if (current.mergedMainSha && current.mergedMainSha !== mergedMainSha) {
      throw new Error(
        `Candidate ${existing.batchId} already recorded ${repository} main at ${current.mergedMainSha}`,
      );
    }
    const promotion = structuredClone(existing.promotion);
    promotion[repository] = {
      ...current,
      mergedHeadSha,
      mergedMainSha,
      mergedAt: current.mergedAt || now,
    };
    promotion.state =
      repositoryNames.every((name) => promotion[name]?.mergedMainSha)
        ? "merged"
        : "partial";
    return writeCandidate(file, {
      ...existing,
      updatedAt: now,
      promotion,
      audit: audit(
        existing,
        "promotion-merge-recorded",
        { paperclipIssueId: ownerIssueId, repository, mergedHeadSha, mergedMainSha },
        now,
      ),
    });
  });
}

export async function recordCompensatingRevert(
  file,
  input,
  now = new Date().toISOString(),
) {
  return withMutationLock(file, async () => {
    const existing = await readCandidate(file);
    if (!existing || existing.status !== "repairing" || !existing.repair) {
      throw new Error("Only a repairing candidate can record a compensating revert");
    }
    const ownerIssueId = requireOwner(existing, input);
    const repository = required(input.repository, "repository");
    if (!repositories.has(repository)) {
      throw new Error("repository must be app, core, or design");
    }
    const previousMerge = existing.repair.previousPromotion?.[repository];
    if (!previousMerge?.mergedMainSha) {
      throw new Error(`${repository} has no recorded partial promotion to compensate`);
    }
    const restoredMainSha = sha(input.mainSha, `${repository} restored main SHA`);
    const expectedMainSha = existing.source?.[repository]?.mainSha;
    if (expectedMainSha && restoredMainSha !== expectedMainSha) {
      throw new Error(
        `${repository} compensation restored ${restoredMainSha}, expected pre-candidate main ${expectedMainSha}`,
      );
    }
    const repair = structuredClone(existing.repair);
    repair.compensation ||= {};
    const current = repair.compensation[repository];
    if (current?.restoredMainSha && current.restoredMainSha !== restoredMainSha) {
      throw new Error(
        `Candidate ${existing.batchId} already recorded ${repository} compensation at ${current.restoredMainSha}`,
      );
    }
    repair.compensation[repository] = {
      revertedPromotionMainSha: previousMerge.mergedMainSha,
      restoredMainSha,
      recordedAt: current?.recordedAt || now,
    };
    repair.compensationComplete = repositoryNames.every((name) =>
      repair.previousPromotion?.[name]?.mergedMainSha
        ? Boolean(repair.compensation?.[name]?.restoredMainSha)
        : true,
    );
    return writeCandidate(file, {
      ...existing,
      updatedAt: now,
      repair,
      audit: audit(
        existing,
        "compensating-revert-recorded",
        { paperclipIssueId: ownerIssueId, repository, restoredMainSha },
        now,
      ),
    });
  });
}

export async function adoptCandidate(file, input, now = new Date().toISOString()) {
  return withMutationLock(file, async () => {
    const existing = await readCandidate(file);
    if (!existing || !blockingStatuses.has(existing.status)) {
      throw new Error("No active release candidate can be adopted");
    }
    const previousOwnerId = required(input.previousOwnerPaperclipIssueId, "previous owner Paperclip issue ID");
    if (existing.owner?.paperclipIssueId !== previousOwnerId) {
      throw new Error(`Candidate owner is ${existing.owner?.paperclipIssueId}, not ${previousOwnerId}`);
    }
    const paperclipIssueId = required(input.paperclipIssueId, "new owner Paperclip issue ID");
    const paperclipIdentifier = required(input.paperclipIdentifier, "new owner Paperclip identifier");
    const reason = required(input.reason, "adoption reason");
    return writeCandidate(file, {
      ...existing,
      updatedAt: now,
      owner: { paperclipIssueId, paperclipIdentifier },
      audit: audit(
        existing,
        "adopted",
        { previousOwnerPaperclipIssueId: previousOwnerId, paperclipIssueId, reason },
        now,
      ),
    });
  });
}

export async function cancelCandidate(
  file,
  input,
  now = new Date().toISOString(),
) {
  return withMutationLock(file, async () => {
    const existing = await readCandidate(file);
    if (existing?.status === "cancelled") {
      requireOwner(existing, input);
      return existing;
    }
    if (!existing || !blockingStatuses.has(existing.status)) {
      throw new Error("No active release candidate can be cancelled");
    }
    const ownerIssueId = requireOwner(existing, input);
    const reason = required(input.reason, "cancellation reason");
    const promotions = [existing.promotion, existing.repair?.previousPromotion];
    const hasRecordedPromotion = promotions.some((promotion) =>
      repositoryNames.some((repository) => promotion?.[repository]?.mergedMainSha),
    );
    if (hasRecordedPromotion) {
      throw new Error(
        `Candidate ${existing.batchId} has a recorded promotion merge; compensate it before cancellation`,
      );
    }
    return writeCandidate(file, {
      ...existing,
      status: "cancelled",
      updatedAt: now,
      cancelledAt: now,
      cancelReason: reason,
      audit: audit(existing, "cancelled", { paperclipIssueId: ownerIssueId, reason }, now),
    });
  });
}

export async function releaseCandidate(
  file,
  input = {},
  now = new Date().toISOString(),
) {
  return withMutationLock(file, async () => {
    const existing = await readCandidate(file);
    if (existing?.status === "released") {
      requireOwner(existing, input);
      await appendHistoryOnce(file, existing);
      return existing;
    }
    if (
      !existing ||
      existing.status !== "active" ||
      !existing.candidateFingerprint ||
      existing.promotion?.state !== "merged" ||
      !existing.promotion.app?.mergedMainSha ||
      !existing.promotion.core?.mergedMainSha ||
      !existing.promotion.design?.mergedMainSha
    ) {
      throw new Error(
        "All three staged promotion PRs must be recorded as merged before release",
      );
    }
    const ownerIssueId = requireOwner(existing, input);
    for (const repository of repositoryNames) {
      if (
        existing.promotion[repository].headSha !==
        existing.source?.[repository]?.devSha
      ) {
        throw new Error(`${repository} promotion head no longer matches the pinned source SHA`);
      }
    }
    const released = {
      ...existing,
      status: "released",
      updatedAt: now,
      releasedAt: now,
      promotion: { ...existing.promotion, state: "released" },
      audit: audit(existing, "released", { paperclipIssueId: ownerIssueId }, now),
    };
    await writeCandidate(file, released);
    await appendHistoryOnce(file, released);
    return released;
  });
}

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : null;
}

function ownerInput(args) {
  return {
    paperclipIssueId:
      option(args, "paperclip-issue-id") || process.env.PAPERCLIP_TASK_ID,
  };
}

async function runCli() {
  const [command, ...args] = process.argv.slice(2);
  const file =
    process.env.KSNVQA_RELEASE_CANDIDATE_LOCK?.trim() ||
    DEFAULT_RELEASE_CANDIDATE_PATH;
  let result;
  if (command === "status") {
    result =
      (await readCandidate(file)) || {
        schema: RELEASE_CANDIDATE_SCHEMA,
        status: "none",
      };
  } else if (command === "open") {
    result = await openCandidate(file, {
      paperclipIssueId:
        option(args, "paperclip-issue-id") || process.env.PAPERCLIP_TASK_ID,
      paperclipIdentifier: option(args, "paperclip-identifier"),
      tickets: option(args, "tickets"),
    });
  } else if (command === "pin") {
    result = await pinCandidate(file, {
      ...ownerInput(args),
      appDevSha: option(args, "app-dev"),
      appMainSha: option(args, "app-main"),
      coreDevSha: option(args, "core-dev"),
      coreMainSha: option(args, "core-main"),
      designDevSha: option(args, "design-dev"),
      designMainSha: option(args, "design-main"),
      tickets: option(args, "tickets"),
    });
  } else if (command === "repair") {
    result = await repairCandidate(file, {
      ...ownerInput(args),
      reason: option(args, "reason"),
      rejectionId: option(args, "rejection-id"),
      linearIdentifier: option(args, "linear-identifier"),
    });
  } else if (command === "stage") {
    result = await stageCandidatePromotion(file, {
      ...ownerInput(args),
      appPullRequest: option(args, "app-pr"),
      appHeadSha: option(args, "app-head"),
      corePullRequest: option(args, "core-pr"),
      coreHeadSha: option(args, "core-head"),
      designPullRequest: option(args, "design-pr"),
      designHeadSha: option(args, "design-head"),
    });
  } else if (command === "record-merge") {
    result = await recordCandidateMerge(file, {
      ...ownerInput(args),
      repository: option(args, "repo"),
      headSha: option(args, "head"),
      mainSha: option(args, "main"),
    });
  } else if (command === "record-compensating-revert") {
    result = await recordCompensatingRevert(file, {
      ...ownerInput(args),
      repository: option(args, "repo"),
      mainSha: option(args, "main"),
    });
  } else if (command === "adopt") {
    result = await adoptCandidate(file, {
      previousOwnerPaperclipIssueId: option(args, "previous-owner-id"),
      paperclipIssueId: option(args, "paperclip-issue-id"),
      paperclipIdentifier: option(args, "paperclip-identifier"),
      reason: option(args, "reason"),
    });
  } else if (command === "cancel") {
    result = await cancelCandidate(file, {
      ...ownerInput(args),
      reason: option(args, "reason"),
    });
  } else if (command === "release") {
    result = await releaseCandidate(file, ownerInput(args));
  } else if (command === "gate") {
    const candidate = await readCandidate(file);
    result = mergeGate(candidate, option(args, "kind") || "feature");
    if (!result.allowed) process.exitCode = 3;
  } else {
    throw new Error(
      "Usage: ksnvqa-release-candidate.mjs status|open|pin|repair|stage|record-merge|record-compensating-revert|adopt|cancel|release|gate",
    );
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
