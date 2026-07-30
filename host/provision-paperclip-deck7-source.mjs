import { randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const registryPath =
  process.env.PAPERCLIP_DECK7_AGENT_REGISTRY ||
  path.join(os.homedir(), ".deck7", "agents.json");
const source = "paperclip";

const raw = await readFile(registryPath, "utf8");
const registry = JSON.parse(raw);
if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
  throw new Error("DECK7 agent registry is invalid");
}
for (const [key, value] of Object.entries(registry)) {
  if (
    !/^[a-zA-Z0-9_-]{1,32}$/.test(key) ||
    typeof value !== "string" ||
    !value.trim()
  ) {
    throw new Error("DECK7 agent registry contains an invalid entry");
  }
}

if (typeof registry[source] === "string" && registry[source].trim()) {
  process.stdout.write("DECK7 paperclip source credential preserved\n");
  process.exit(0);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = `${registryPath}.pre-paperclip-router-${timestamp}`;
await copyFile(registryPath, backupPath);
await chmod(backupPath, 0o600);

registry[source] = randomBytes(32).toString("hex");
const temporary = `${registryPath}.tmp-${process.pid}`;
await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, {
  mode: 0o600,
});
await chmod(temporary, 0o600);
await rename(temporary, registryPath);
await chmod(registryPath, 0o600);
process.stdout.write("DECK7 paperclip source credential provisioned\n");
