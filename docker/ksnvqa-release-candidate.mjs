#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASE_CANDIDATE_SCHEMA = "ksnvqa.release-candidate.v3";
export const DEFAULT_RELEASE_CANDIDATE_PATH =
  "/Volumes/OdessaExt/Kasanova/KSNVQA_RELEASE_CANDIDATE.lock";

const blockingStatuses = new Set(["preparing", "active", "repairing"]);
const allowedMergeKinds = new Set([
  "main-sync",
  "qa-rejection-revert",
  "candidate-repair",
  "promotion",
]);
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

function singleTicket(value) {
  const tickets = normalizeTicketIdentifiers(value);
  if (tickets.length !== 1) {
    throw new Error("A release candidate must contain exactly one KSNV ticket");
  }
  return tickets;
}

export function normalizeRepositoryNames(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(",");
  const names = [
    ...new Set(source.map((entry) => String(entry).trim()).filter(Boolean)),
  ].sort((left, right) => left.localeCompare(right));
  if (names.length === 0) {
    throw new Error("At least one touched repository is required");
  }
  for (const name of names) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
      throw new Error(`Invalid repository name: ${name}`);
    }
  }
  return names;
}

function normalizeSource(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Repository source must be a map keyed by repository name");
  }
  const source = {};
  for (const repository of normalizeRepositoryNames(Object.keys(value))) {
    source[repository] = {
      devSha: sha(value[repository]?.devSha, `${repository} dev SHA`),
      mainSha: sha(value[repository]?.mainSha, `${repository} main SHA`),
    };
  }
  return source;
}

function candidateRepositoryNames(candidate) {
  return normalizeRepositoryNames(
    candidate?.repositoryNames || Object.keys(candidate?.source || {}),
  );
}

function requireExactRepositoryScope(expected, actual, label) {
  const expectedNames = normalizeRepositoryNames(expected);
  const actualNames = normalizeRepositoryNames(actual);
  if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames)) {
    throw new Error(
      `${label} repositories must exactly match candidate scope: ${expectedNames.join(", ")}`,
    );
  }
  return expectedNames;
}

export function candidateFingerprint({ source, tickets }) {
  const normalizedSource = normalizeSource(source);
  return createHash("sha256")
    .update(
      JSON.stringify({ tickets: singleTicket(tickets), source: normalizedSource }),
    )
    .digest("hex");
}

export function candidateSummary(candidate) {
  if (!candidate) return { status: "none", ticket: null, repositories: [] };
  const repositoryNames = candidateRepositoryNames(candidate);
  return {
    batchId: candidate.batchId,
    status: candidate.status,
    ticket: singleTicket(candidate.tickets)[0],
    repositories: repositoryNames.map((repository) => ({
      repository,
      devSha: candidate.source?.[repository]?.devSha || null,
      mainSha: candidate.source?.[repository]?.mainSha || null,
      pullRequest: candidate.promotion?.[repository]?.pullRequest || null,
      promotionState: candidate.promotion?.[repository]?.mergedMainSha
        ? "merged"
        : candidate.promotion?.[repository]
          ? "staged"
          : "pending",
    })),
    candidateFingerprint: candidate.candidateFingerprint || null,
  };
}

export function mergeGate(candidate, mergeKind = "feature", repository = null) {
  if (!candidate || !blockingStatuses.has(candidate.status)) {
    return { allowed: true, reason: "No active KSNVQA release-candidate lock." };
  }
  if (allowedMergeKinds.has(mergeKind)) {
    return {
      allowed: true,
      reason: `Merge kind ${mergeKind} is allowed while candidate ${candidate.batchId} is ${candidate.status}.`,
    };
  }
  const repositoryNames = candidateRepositoryNames(candidate);
  if (repository && !repositoryNames.includes(repository)) {
    return {
      allowed: true,
      reason: `Candidate ${candidate.batchId} does not pin repository ${repository}; its dev head is outside this lock.`,
    };
  }
  return {
    allowed: false,
    reason:
      `Candidate ${candidate.batchId} is ${candidate.status} and pins ${repositoryNames.join(", ")}; ` +
      `${repository ? `repository ${repository} is locked` : "provide --repo to prove the target repository is outside its scope"}. ` +
      "Only main sync, QA-rejection revert, candidate repair, and promotion mutations may proceed on pinned repositories.",
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
      if (existing.owner?.paperclipIssueId === input.paperclipIssueId) {
        const tickets = singleTicket(input.tickets);
        const repositoryNames = normalizeRepositoryNames(input.repositoryNames);
        if (
          tickets[0] === singleTicket(existing.tickets)[0] &&
          JSON.stringify(repositoryNames) ===
            JSON.stringify(candidateRepositoryNames(existing))
        ) {
          return existing;
        }
        throw new Error(
          `Candidate ${existing.batchId} is already open with different ticket or repository scope`,
        );
      }
      throw new Error(
        `Candidate ${existing.batchId} is already ${existing.status} under ${existing.owner?.paperclipIdentifier || existing.owner?.paperclipIssueId}`,
      );
    }
    if (existing?.status === "released") await appendHistoryOnce(file, existing);
    const tickets = singleTicket(input.tickets);
    const repositoryNames = normalizeRepositoryNames(input.repositoryNames);
    const ownerIssueId = required(input.paperclipIssueId, "Paperclip issue ID");
    const seed = `${now}:${tickets[0]}:${repositoryNames.join(",")}:${ownerIssueId}`;
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
      repositoryNames,
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
  const repositoryNames = candidateRepositoryNames(candidate);
  return repositoryNames.every((repository) => {
    const promotedMainSha = previous?.[repository]?.mergedMainSha;
    if (!promotedMainSha) return true;
    const record = candidate?.repair?.compensation?.[repository];
    const restorationTargetMainSha = candidate?.source?.[repository]?.mainSha;
    return Boolean(
      record &&
        record.paperclipIssueId === candidate?.owner?.paperclipIssueId &&
        record.repository === repository &&
        record.revertedPromotionMainSha === promotedMainSha &&
        record.restorationTargetMainSha === restorationTargetMainSha &&
        /^[0-9a-f]{40}$/.test(record.restoredMainSha || "") &&
        record.restoredMainSha !== promotedMainSha &&
        record.restoredMainSha !== restorationTargetMainSha &&
        /^[0-9a-f]{40}$/.test(record.restoredTreeSha || ""),
    );
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

  const tickets = singleTicket(candidate.tickets);
  const repositoryNames = candidateRepositoryNames(candidate);
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

  const fingerprint = candidateFingerprint({ source, tickets });
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
    const tickets = singleTicket(input.tickets || existing.tickets);
    const source = normalizeSource(input.source);
    const repositoryNames = requireExactRepositoryScope(
      candidateRepositoryNames(existing),
      Object.keys(source),
      "Pinned source",
    );
    const fingerprint = candidateFingerprint({ source, tickets });
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
      repositoryNames,
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
    if (
      !input.promotion ||
      Array.isArray(input.promotion) ||
      typeof input.promotion !== "object"
    ) {
      throw new Error("Promotion must be a map keyed by repository name");
    }
    const repositoryNames = requireExactRepositoryScope(
      candidateRepositoryNames(existing),
      Object.keys(input.promotion),
      "Promotion",
    );
    const promotion = {
      state: "ready",
      stagedAt: existing.promotion?.stagedAt || now,
    };
    for (const repository of repositoryNames) {
      const headSha = sha(
        input.promotion[repository]?.headSha,
        `${repository} promotion head SHA`,
      );
      if (headSha !== existing.source?.[repository]?.devSha) {
        throw new Error(
          `${repository} promotion head must equal its pinned dev SHA for candidate ${existing.batchId}`,
        );
      }
      promotion[repository] = {
        pullRequest: required(
          input.promotion[repository]?.pullRequest,
          `${repository} pull request`,
        ),
        headSha,
        mergedHeadSha: null,
        mergedMainSha: null,
        mergedAt: null,
      };
    }
    if (
      existing.promotion &&
      JSON.stringify(existing.promotion) !== JSON.stringify(promotion)
    ) {
      throw new Error(`Candidate ${existing.batchId} already staged different promotion PRs or heads`);
    }
    return writeCandidate(file, {
      ...existing,
      updatedAt: now,
      promotion: existing.promotion || promotion,
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
      throw new Error("Stage every scoped repository promotion before recording a merge");
    }
    const ownerIssueId = requireOwner(existing, input);
    const repository = required(input.repository, "repository");
    const repositoryNames = candidateRepositoryNames(existing);
    if (!repositoryNames.includes(repository)) {
      throw new Error(`repository must be one of: ${repositoryNames.join(", ")}`);
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
    const repositoryNames = candidateRepositoryNames(existing);
    if (!repositoryNames.includes(repository)) {
      throw new Error(`repository must be one of: ${repositoryNames.join(", ")}`);
    }
    const previousMerge = existing.repair.previousPromotion?.[repository];
    if (!previousMerge?.mergedMainSha) {
      throw new Error(`${repository} has no recorded partial promotion to compensate`);
    }
    const restoredMainSha = sha(input.mainSha, `${repository} restored main SHA`);
    const restorationTargetMainSha = sha(
      input.targetMainSha,
      `${repository} restoration target main SHA`,
    );
    const restoredTreeSha = sha(input.treeSha, `${repository} restored tree SHA`);
    const expectedMainSha = sha(
      existing.source?.[repository]?.mainSha,
      `${repository} pre-candidate main SHA`,
    );
    if (restorationTargetMainSha !== expectedMainSha) {
      throw new Error(
        `${repository} compensation target ${restorationTargetMainSha} does not match pre-candidate main ${expectedMainSha}`,
      );
    }
    if (restoredMainSha === previousMerge.mergedMainSha) {
      throw new Error(
        `${repository} compensation main must differ from promoted main ${previousMerge.mergedMainSha}`,
      );
    }
    if (restoredMainSha === restorationTargetMainSha) {
      throw new Error(
        `${repository} compensation main must differ from historical restoration target ${restorationTargetMainSha}`,
      );
    }
    const repair = structuredClone(existing.repair);
    repair.compensation ||= {};
    const current = repair.compensation[repository];
    const record = {
      paperclipIssueId: ownerIssueId,
      repository,
      revertedPromotionMainSha: previousMerge.mergedMainSha,
      restorationTargetMainSha,
      restoredMainSha,
      restoredTreeSha,
      recordedAt: current?.recordedAt || now,
    };
    if (current) {
      const matches = Object.entries(record).every(
        ([key, value]) => current[key] === value,
      );
      if (matches && Object.keys(current).length === Object.keys(record).length) {
        return existing;
      }
      throw new Error(
        `Candidate ${existing.batchId} already recorded different ${repository} compensation evidence`,
      );
    }
    repair.compensation[repository] = record;
    repair.compensationComplete = compensationComplete({ ...existing, repair });
    return writeCandidate(file, {
      ...existing,
      updatedAt: now,
      repair,
      audit: audit(
        existing,
        "compensating-revert-recorded",
        {
          paperclipIssueId: ownerIssueId,
          repository,
          restoredMainSha,
          restorationTargetMainSha,
          restoredTreeSha,
        },
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
      candidateRepositoryNames(existing).some(
        (repository) => promotion?.[repository]?.mergedMainSha,
      ),
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
      existing.promotion?.state !== "merged"
    ) {
      throw new Error(
        "Every scoped promotion PR must be recorded as merged before release",
      );
    }
    const ownerIssueId = requireOwner(existing, input);
    const repositoryNames = candidateRepositoryNames(existing);
    for (const repository of repositoryNames) {
      if (
        !existing.promotion[repository]?.mergedMainSha ||
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

function options(args, name) {
  const flag = `--${name}`;
  return args.flatMap((value, index) =>
    value === flag && args[index + 1] ? [args[index + 1]] : [],
  );
}

function parseRepositoryMap(args, flag, valueLabels) {
  const result = {};
  for (const specification of options(args, flag)) {
    const [repository, ...values] = specification
      .split(",")
      .map((value) => value.trim());
    if (
      !repository ||
      values.length !== valueLabels.length ||
      values.some((value) => !value)
    ) {
      throw new Error(
        `--${flag} must use ${["repository", ...valueLabels].join(",")} format`,
      );
    }
    if (result[repository]) {
      throw new Error(`Duplicate --${flag} repository: ${repository}`);
    }
    result[repository] = Object.fromEntries(
      valueLabels.map((label, index) => [label, values[index]]),
    );
  }
  return result;
}

function ownerInput(args) {
  return {
    paperclipIssueId:
      option(args, "paperclip-issue-id") || process.env.PAPERCLIP_TASK_ID,
  };
}

async function runSelfCheck(notBatchId = null) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "ksnvqa-candidate-self-check-"),
  );
  const file = path.join(directory, "candidate.json");
  const owner = `self-check-${randomUUID()}`;
  const source = {
    sterling: {
      devSha: "1971971971971971971971971971971971971971",
      mainSha: "1971971971971971971971971971971971971970",
    },
  };
  try {
    const opened = await openCandidate(file, {
      paperclipIssueId: owner,
      paperclipIdentifier: "KSNVQA-SELF-CHECK",
      tickets: ["KSNV-197"],
      repositoryNames: ["sterling"],
    });
    if (notBatchId && opened.batchId === notBatchId) {
      throw new Error(`Scratch candidate reused forbidden batch identity ${notBatchId}`);
    }
    await pinCandidate(file, {
      paperclipIssueId: owner,
      tickets: ["KSNV-197"],
      source,
    });
    await stageCandidatePromotion(file, {
      paperclipIssueId: owner,
      promotion: {
        sterling: {
          pullRequest: "self-check-pr",
          headSha: source.sterling.devSha,
        },
      },
    });
    await recordCandidateMerge(file, {
      paperclipIssueId: owner,
      repository: "sterling",
      headSha: source.sterling.devSha,
      mainSha: "1971971971971971971971971971971971971972",
    });
    const released = await releaseCandidate(file, { paperclipIssueId: owner });
    const summary = candidateSummary(released);
    if (
      summary.status !== "released" ||
      summary.ticket !== "KSNV-197" ||
      summary.repositories.length !== 1 ||
      summary.repositories[0].repository !== "sterling" ||
      ["app", "core", "design"].some((name) => name in released.source)
    ) {
      throw new Error(
        "Scratch backend-only candidate did not preserve exact repository scope",
      );
    }
    return {
      schema: RELEASE_CANDIDATE_SCHEMA,
      pass: true,
      scratchOnly: true,
      batchId: released.batchId,
      summary,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runCli() {
  const [command, ...args] = process.argv.slice(2);
  const file =
    process.env.KSNVQA_RELEASE_CANDIDATE_LOCK?.trim() ||
    DEFAULT_RELEASE_CANDIDATE_PATH;
  let result;
  if (command === "status") {
    const candidate = await readCandidate(file);
    result = candidate
      ? { ...candidate, summary: candidateSummary(candidate) }
      : {
        schema: RELEASE_CANDIDATE_SCHEMA,
        status: "none",
        summary: candidateSummary(null),
      };
  } else if (command === "open") {
    result = await openCandidate(file, {
      paperclipIssueId:
        option(args, "paperclip-issue-id") || process.env.PAPERCLIP_TASK_ID,
      paperclipIdentifier: option(args, "paperclip-identifier"),
      tickets: option(args, "tickets"),
      repositoryNames: option(args, "repositories"),
    });
  } else if (command === "pin") {
    result = await pinCandidate(file, {
      ...ownerInput(args),
      source: parseRepositoryMap(args, "source", ["devSha", "mainSha"]),
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
      promotion: parseRepositoryMap(args, "promotion", [
        "pullRequest",
        "headSha",
      ]),
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
      targetMainSha: option(args, "target"),
      treeSha: option(args, "tree"),
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
    result = mergeGate(
      candidate,
      option(args, "kind") || "feature",
      option(args, "repo"),
    );
    if (!result.allowed) process.exitCode = 3;
  } else if (command === "self-check") {
    result = await runSelfCheck(option(args, "not-batch-id"));
  } else {
    throw new Error(
      "Usage: ksnvqa-release-candidate.mjs status|open|pin|repair|stage|record-merge|record-compensating-revert|adopt|cancel|release|gate|self-check",
    );
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
