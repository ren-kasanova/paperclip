#!/usr/bin/env node

import {
  mkdir,
  open,
  readFile,
  rmdir,
  stat,
} from "node:fs/promises";

const lockPath =
  process.env.ODESSA_ANDROID_DEVICE_LOCK ||
  "/odessa-root/USING_ANDROID_DEVICE.lock";
const command = process.argv[2];
const guardPath = "/tmp/paperclip-android-device-lock/update.guard";
const args = new Map();
for (let index = 3; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || value === undefined) {
    throw new Error(`Invalid argument near ${key || "<end>"}`);
  }
  args.set(key.slice(2), value);
}

async function readLock() {
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  if (lock.schema !== "odessa.android-device-lock.v1") {
    throw new Error(`Unsupported Android lock schema at ${lockPath}`);
  }
  return lock;
}

async function writeLockInPlace(lock) {
  const payload = `${JSON.stringify(lock, null, 2)}\n`;
  const handle = await open(lockPath, "r+");
  try {
    await handle.truncate(0);
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function acquireGuard() {
  try {
    await mkdir(guardPath);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const guard = await stat(guardPath);
    if (Date.now() - guard.mtimeMs <= 10_000) {
      throw new Error("Another Android lease update is in progress");
    }
    await rmdir(guardPath);
    await mkdir(guardPath);
  }
}

async function updateLock(mutate) {
  await acquireGuard();
  try {
    const lock = await readLock();
    const next = await mutate(lock);
    if (next) await writeLockInPlace(next);
    return next;
  } finally {
    await rmdir(guardPath);
  }
}

function leaseIsExpired(lock, nowMs = Date.now()) {
  if (lock.status !== "reserved") return false;
  const expiresAt = Date.parse(lock.leaseExpiresAt || "");
  return Number.isFinite(expiresAt) && expiresAt <= nowMs;
}

function availableLock(lock, reason) {
  return {
    ...lock,
    status: "available",
    owner: null,
    issue: null,
    sourceIssue: null,
    purpose: "Available for the next assigned KSNVQA Android QA task",
    acquiredAt: null,
    leaseExpiresAt: null,
    activeEmulatorSerial: null,
    releaseCondition: null,
    notes: reason,
  };
}

if (command === "--help" || command === "-h" || command === "help") {
  process.stdout.write(
    [
      "Usage: android-device-lock.mjs inspect",
      "       android-device-lock.mjs probe",
      "       android-device-lock.mjs reclaim-expired",
      "       android-device-lock.mjs claim --issue KSNVQA-### --source-issue KSNV-### --purpose TEXT [--owner TEXT] [--lease-minutes 5..30]",
      "       android-device-lock.mjs release --issue KSNVQA-### [--owner TEXT]",
      "",
    ].join("\n"),
  );
} else if (command === "inspect") {
  process.stdout.write(`${JSON.stringify(await readLock(), null, 2)}\n`);
} else if (command === "probe") {
  await acquireGuard();
  try {
    const lock = await readLock();
    process.stdout.write(
      `${JSON.stringify({
        status: lock.status,
        guard: "available",
        leaseExpiresAt: lock.leaseExpiresAt || null,
      })}\n`,
    );
  } finally {
    await rmdir(guardPath);
  }
} else if (command === "claim") {
  const issue = args.get("issue");
  const sourceIssue = args.get("source-issue");
  const purpose = args.get("purpose");
  const owner = args.get("owner") || "KSNVQA";
  const leaseMinutes = Number(args.get("lease-minutes") || 30);
  if (!issue || !sourceIssue || !purpose) {
    throw new Error(
      "claim requires --issue, --source-issue, and --purpose",
    );
  }
  if (!Number.isFinite(leaseMinutes) || leaseMinutes < 5 || leaseMinutes > 30) {
    throw new Error("--lease-minutes must be between 5 and 30");
  }
  const claimed = await updateLock(async (lock) => {
    const sameAssignment =
      lock.status === "reserved" &&
      lock.owner === owner &&
      lock.issue === issue &&
      lock.sourceIssue === sourceIssue;
    if (
      lock.status === "reserved" &&
      !sameAssignment &&
      !leaseIsExpired(lock)
    ) {
      throw new Error(
        `Android device is reserved by ${lock.owner}/${lock.issue} until ${lock.leaseExpiresAt || "explicit release"}`,
      );
    }
    const now = new Date();
    return {
      ...lock,
      status: "reserved",
      owner,
      issue,
      sourceIssue,
      purpose,
      acquiredAt: sameAssignment
        ? lock.acquiredAt || now.toISOString()
        : now.toISOString(),
      leaseExpiresAt: new Date(
        now.getTime() + leaseMinutes * 60 * 1000,
      ).toISOString(),
      releaseCondition:
        `${issue} stops active Android work, changes disposition, or the lease expires`,
      notes:
        "Short-lived device lease. Refresh only while an Android command is actively needed; release before blocking, review, or run exit.",
    };
  });
  process.stdout.write(
    `${JSON.stringify({
      status: claimed.status,
      owner: claimed.owner,
      issue: claimed.issue,
      sourceIssue: claimed.sourceIssue,
      leaseExpiresAt: claimed.leaseExpiresAt,
    })}\n`,
  );
} else if (command === "release") {
  const issue = args.get("issue");
  const owner = args.get("owner") || "KSNVQA";
  if (!issue) throw new Error("release requires --issue");
  await updateLock(async (lock) => {
    if (lock.status === "available") return null;
    if (lock.owner !== owner || lock.issue !== issue) {
      throw new Error(
        `Cannot release Android reservation owned by ${lock.owner}/${lock.issue}`,
      );
    }
    return availableLock(
      lock,
      `Released by ${owner}/${issue}; no Android command remains active.`,
    );
  });
  process.stdout.write('{"status":"available"}\n');
} else if (command === "reclaim-expired") {
  const result = await updateLock(async (lock) =>
    leaseIsExpired(lock)
      ? availableLock(
          lock,
          `Automatically released expired lease previously held by ${lock.owner}/${lock.issue}.`,
        )
      : null,
  );
  if (!result) {
    const lock = await readLock();
    process.stdout.write(
      `${JSON.stringify({
        status: lock.status,
        reclaimed: false,
        leaseExpiresAt: lock.leaseExpiresAt || null,
      })}\n`,
    );
  } else {
    process.stdout.write('{"status":"available","reclaimed":true}\n');
  }
} else {
  throw new Error(
    "Usage: android-device-lock.mjs --help|inspect|probe|claim|release|reclaim-expired",
  );
}
