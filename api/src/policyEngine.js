"use strict";

/**
 * SentryAI Policy Engine (MVP)
 * -----------------------------
 * MVP scope (per the architecture doc, Section 10.1): a single policy
 * type — "flag PII/financial data sent to an unapproved AI tool" — with
 * decisions limited to "allow" and "alert" (no real-time blocking yet).
 *
 * The rule shape below intentionally mirrors what a `json-rules-engine`
 * policy document would look like, so migrating to that library in
 * Phase 2 (full no-code policy builder) is a straightforward port
 * rather than a redesign.
 */

const db = require("./db");

// Categories from the classification service that are always
// sensitive enough to alert on, regardless of which AI tool was used.
const SENSITIVE_CATEGORIES = new Set([
  "PII_AADHAAR",
  "PII_PAN",
  "FINANCIAL_CARD",
  "FINANCIAL_IFSC",
  "PII_PHONE",
  "PII_EMAIL",
  "CUSTOMER_DATA",
  "EMPLOYEE_DATA",
  "COMPANY_CONFIDENTIAL",
  "DATABASE_EXPORT",
  "FINANCIAL_DATA",
  "SOURCE_CODE",
  "PII_ID_DOCUMENT",
  "SECRET_CREDENTIAL",
  "HEALTH_DATA",
  "BIOMETRIC_DATA",
  "CHILD_DATA",
]);

// Files we could not inspect (unknown binary, OCR unavailable, too large,
// encrypted ...). When true, the user is asked for permission before such
// a file goes to an AI tool, exactly like for detected sensitive data.
const PROMPT_ON_UNSCANNABLE = true;

const USER_ACTIONS = new Set(["clean", "allowed", "declined", "redacted_sent"]);

/**
 * Should the user be asked before this content goes to the AI tool?
 * @param {string[]} categories
 * @param {string} scanStatus  "scanned" | "partial" | "unscannable"
 */
function requiresPermission(categories, scanStatus) {
  if ((categories || []).some((c) => SENSITIVE_CATEGORIES.has(c))) return true;
  return PROMPT_ON_UNSCANNABLE && (scanStatus === "unscannable" || scanStatus === "partial");
}

/**
 * @param {object} classification - { categories, highest_risk_category }
 * @param {object} toolInfo - { domain, riskTier } for the AI tool used
 * @param {string} [userAction] - what the employee chose when prompted:
 *        "clean" | "allowed" | "declined" | "redacted_sent" (omitted = legacy alert-only flow)
 * @returns {{ decision: "allow"|"alert"|"blocked"|"redacted", reason: string }}
 */
function evaluate(classification, toolInfo, userAction) {
  const categories = classification.categories || [];
  const flagged = categories.filter((c) => SENSITIVE_CATEGORIES.has(c));
  const scanStatus = classification.scan_status || "scanned";
  const unscannable = PROMPT_ON_UNSCANNABLE && (scanStatus === "unscannable" || scanStatus === "partial");
  const tool = (toolInfo && toolInfo.domain) || "unknown";
  const what = flagged.length ? `Sensitive data (${flagged.join(", ")})` : "Content that could not be inspected";

  if (flagged.length === 0 && !unscannable) {
    return { decision: "allow", reason: "No sensitive data detected." };
  }

  switch (userAction) {
    case "declined":
      return { decision: "blocked", reason: `${what} — user declined; NOT sent to "${tool}".` };
    case "redacted_sent":
      return { decision: "redacted", reason: `${what} — masked before sending to "${tool}"; original NOT sent.` };
    case "allowed":
      return { decision: "alert", reason: `${what} — user allowed it to be sent to "${tool}".` };
    default: {
      const tier = (toolInfo && toolInfo.riskTier) || "unapproved";
      return {
        decision: "alert",
        reason:
          tier === "unapproved"
            ? `${what} sent to unapproved AI tool "${tool}".`
            : `${what} detected — tool is approved, logged for audit.`,
      };
    }
  }
}

/** Look up (or lazily register) an AI tool's risk tier from the reference list. */
function getToolInfo(domain) {
  let tool = db.findOne("aiTools", (t) => t.domain === domain);
  if (!tool) {
    // Unknown domain reaching the API at all means the extension's
    // static domain list already scoped it to a known AI tool — default
    // new/unclassified tools to "unapproved" until an admin reviews them.
    tool = { domain, name: domain, riskTier: "unapproved" };
  }
  return tool;
}

module.exports = { evaluate, getToolInfo, requiresPermission, SENSITIVE_CATEGORIES, USER_ACTIONS };
