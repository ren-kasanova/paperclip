import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Request } from "express";
import type { DecisionProvenance } from "@paperclipai/shared";
import { forbidden } from "../errors.js";

function secureEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function authenticateDeck7Decision(
  req: Request,
): DecisionProvenance | null {
  const provenance = req.body?.decisionProvenance as DecisionProvenance | undefined;
  if (!provenance) return null;

  const tokenPath = process.env.PAPERCLIP_DECK7_ROUTER_TOKEN_FILE?.trim();
  if (!tokenPath) {
    throw forbidden("Authenticated DECK7 decision routing is not configured");
  }
  let expectedToken = "";
  try {
    expectedToken = readFileSync(tokenPath, "utf8").trim();
  } catch {
    throw forbidden("Authenticated DECK7 decision routing is unavailable");
  }
  const suppliedToken = req.get("x-paperclip-deck7-token")?.trim() ?? "";
  if (
    !/^[a-f0-9]{64}$/i.test(expectedToken) ||
    !secureEqual(suppliedToken, expectedToken)
  ) {
    throw forbidden("Invalid DECK7 decision provenance credential");
  }
  return provenance;
}
