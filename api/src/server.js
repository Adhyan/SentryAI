"use strict";

/**
 * SentryAI Ingestion & Dashboard API (MVP)
 * ------------------------------------------
 * Deliberately built on Node's built-in `http` module instead of Express,
 * because this sandbox has no network access to `npm install` anything.
 * The route handlers below are written to be a near 1:1 mapping onto
 * Express route handlers (req, res) => {...}, so porting to Express in
 * Phase 2 is a mechanical exercise, not a rewrite:
 *   app.post("/v1/events", handleCreateEvent)  // same function, new framework
 *
 * Endpoints (see README.md for full contract):
 *   GET  /health
 *   POST /v1/auth/device      register a browser-extension install
 *   POST /v1/scan             extension -> scan text/files BEFORE they are sent (no logging)
 *   POST /v1/events           extension -> log the outcome (scanId + userAction) / legacy ingest
 *   GET  /v1/events           dashboard -> list recent events
 *   GET  /v1/summary          dashboard -> counts for the summary chart
 *   GET  /v1/tools            reference list of known AI tool domains
 *   GET  /*                   static files for the dashboard UI
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const db = require("./db");
const policyEngine = require("./policyEngine");
const classificationClient = require("./classificationClient");

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const DASHBOARD_DIR = path.join(__dirname, "..", "..", "dashboard");
const DEFAULT_ORG_ID = "org_demo"; // MVP runs single-tenant; orgId plumbed through for the Phase-2 multi-tenant swap.

// ---------------------------------------------------------------------------
// Seed the reference AI-tools list on first run (idempotent).
// ---------------------------------------------------------------------------
function seedAiTools() {
  const seedTools = [
    { domain: "chatgpt.com", name: "ChatGPT", riskTier: "unapproved" },
    { domain: "chat.openai.com", name: "ChatGPT", riskTier: "unapproved" },
    { domain: "claude.ai", name: "Claude", riskTier: "unapproved" },
    { domain: "gemini.google.com", name: "Gemini", riskTier: "unapproved" },
    { domain: "chat.deepseek.com", name: "DeepSeek", riskTier: "unapproved" },
    { domain: "perplexity.ai", name: "Perplexity", riskTier: "unapproved" },
    { domain: "www.perplexity.ai", name: "Perplexity", riskTier: "unapproved" },
    { domain: "grok.com", name: "Grok", riskTier: "unapproved" },
    { domain: "grammarly.com", name: "Grammarly", riskTier: "unapproved" },
    { domain: "quillbot.com", name: "QuillBot", riskTier: "unapproved" },
  ];
  const allowedDomains = new Set(seedTools.map((tool) => tool.domain));
  const existingTools = db.find("aiTools");
  const retainedTools = existingTools.filter((tool) => allowedDomains.has(tool.domain));
  const removedCount = existingTools.length - retainedTools.length;
  const additions = seedTools.filter((tool) => !retainedTools.some((entry) => entry.domain === tool.domain));

  const sync = db.replace("aiTools", retainedTools);
  return sync.then(async () => {
    for (const tool of additions) await db.insert("aiTools", tool);
    if (removedCount || additions.length) {
      console.log(`[seed] AI tool catalog updated: ${additions.length} added, ${removedCount} removed`);
    }
  });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    const MAX_BYTES = maxBytes || 1_000_000; // 1MB default guardrail; /v1/scan allows file uploads
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        reject(new Error("payload_too_large"));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function hashText(text) {
  return crypto.createHash("sha256").update(text || "").digest("hex");
}

function fingerprintContent(deviceToken, kind, value) {
  return crypto
    .createHmac("sha256", deviceToken)
    .update(`${kind}\0`)
    .update(value)
    .digest("hex");
}

function authenticateDevice(req) {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return null;
  return db.findOne("devices", (d) => d.deviceToken === token);
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleRegisterDevice(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }

  const device = await db.insert("devices", {
    orgId: body.orgId || DEFAULT_ORG_ID,
    userId: body.userId || "unknown@example.com",
    deviceToken: crypto.randomUUID(),
    lastSeen: new Date().toISOString(),
  });

  return sendJson(res, 201, {
    deviceId: device._id,
    deviceToken: device.deviceToken,
    orgId: device.orgId,
  });
}

// ---------------------------------------------------------------------------
// Scan store: /v1/scan results are kept in memory for a few minutes so the
// audit event that follows (/v1/events with scanId + userAction) is built
// from what the SERVER found -- the extension can't rewrite the categories.
// Only metadata is kept; file bytes are dropped as soon as they're scanned.
// ---------------------------------------------------------------------------
const SCAN_TTL_MS = 15 * 60 * 1000;
const MAX_SCAN_BYTES = 20 * 1024 * 1024;
const scans = new Map();

function putScan(record) {
  const now = Date.now();
  for (const [id, r] of scans) if (now - r.at > SCAN_TTL_MS) scans.delete(id);
  const scanId = crypto.randomUUID();
  scans.set(scanId, { ...record, at: now, decision: record.decision || null });
  return scanId;
}

function listPendingApprovals() {
  const now = Date.now();
  for (const [id, scan] of scans) if (now - scan.at > SCAN_TTL_MS) scans.delete(id);
  return [...scans.entries()]
    .filter(([, scan]) => scan.needsPermission && !scan.decision)
    .map(([scanId, scan]) => ({
      scanId,
      tool: scan.tool,
      createdAt: new Date(scan.at).toISOString(),
      items: scan.items.map(({ kind, name, categories, scanStatus }) => ({ kind, name, categories, scanStatus })),
    }));
}

async function rememberDeclinedContent(deviceId, scan) {
  for (const item of scan.items) {
    if (!item.fingerprint || !policyEngine.requiresPermission(item.categories, item.scanStatus)) continue;
    const exists = db.findOne("declinedFingerprints", (entry) =>
      entry.deviceId === deviceId && entry.fingerprint === item.fingerprint
    );
    if (!exists) {
      await db.insert("declinedFingerprints", {
        deviceId,
        fingerprint: item.fingerprint,
        kind: item.kind,
        categories: item.categories,
        scanStatus: item.scanStatus,
        highestRiskCategory: item.highest_risk_category || null,
      });
    }
  }
}

async function handleApprovalDecision(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return sendJson(res, 400, { error: err.message }); }
  const scan = scans.get(body.scanId);
  if (!scan || !scan.needsPermission) return sendJson(res, 404, { error: "pending_approval_not_found" });
  if (scan.decision) return sendJson(res, 409, { error: "approval_already_decided" });
  if (!["allow", "decline"].includes(body.decision)) return sendJson(res, 400, { error: "decision_must_be_allow_or_decline" });
  if (body.decision === "decline") await rememberDeclinedContent(scan.deviceId, scan);
  scan.decision = body.decision;
  return sendJson(res, 200, { scanId: body.scanId, decision: scan.decision });
}

async function handleScan(req, res) {
  const device = authenticateDevice(req);
  if (!device) return sendJson(res, 401, { error: "invalid_or_missing_device_token" });

  let body;
  try {
    body = await readJsonBody(req, MAX_SCAN_BYTES);
  } catch (err) {
    return sendJson(res, err.message === "payload_too_large" ? 413 : 400, { error: err.message });
  }

  const { tool, text, files } = body;
  if (!tool) return sendJson(res, 400, { error: "`tool` is required" });
  if (text == null && !Array.isArray(files)) {
    return sendJson(res, 400, { error: "provide `text` and/or `files`" });
  }

  const items = [];
  let autoDeclined = false;

  if (typeof text === "string" && text.length > 0) {
    const fingerprint = fingerprintContent(device.deviceToken, "text", text);
    const declined = db.findOne("declinedFingerprints", (entry) =>
      entry.deviceId === device._id && entry.fingerprint === fingerprint
    );
    if (declined) {
      autoDeclined = true;
      items.push({
        kind: "text", name: "message", categories: declined.categories || [],
        scanStatus: declined.scanStatus || "unscannable", redactedText: null,
        maskable: false, sha256: hashText(text), fingerprint,
        size: Buffer.byteLength(text),
        highest_risk_category: declined.highestRiskCategory || null,
      });
    } else {
      const c = await classificationClient.classify(text, tool);
      const failed = Boolean(c._error);
      let maskable = false;
      if (!failed && c.categories.length > 0 && c.redacted_text) {
        // Only offer "send masked version" if the masked text is genuinely
        // clean when re-scanned (source-code / financial-context flags
        // can't be fixed by masking a few tokens).
        const recheck = await classificationClient.classify(c.redacted_text, tool);
        maskable = !recheck._error && recheck.categories.length === 0;
      }
      items.push({
        kind: "text",
        name: "message",
        categories: c.categories || [],
        scanStatus: failed ? "unscannable" : "scanned",
        redactedText: c.redacted_text || null,
        maskable,
        sha256: hashText(text),
        fingerprint,
        size: Buffer.byteLength(text),
        highest_risk_category: c.highest_risk_category || null,
      });
    }
  }

  for (const f of Array.isArray(files) ? files : []) {
    const name = String(f.name || "unnamed").slice(0, 200);
    const declaredSize = Number(f.size) || 0;
    let c;
    let sha = null;
    let fingerprint = null;
    if (f.tooLarge || typeof f.dataBase64 !== "string") {
      c = { categories: [], scan_status: "unscannable" };
      const parts = f.fingerprintParts;
      const validParts = Array.isArray(parts) && parts.length > 0 && parts.length <= 100_000 &&
        parts.every((part) => typeof part === "string" && /^[a-f0-9]{64}$/i.test(part));
      if (validParts) {
        // Large-file bytes stay on the client; HMAC the ordered per-chunk
        // SHA-256 digests so an exact repeat is still recognized.
        const signature = JSON.stringify({ size: declaredSize, parts });
        fingerprint = fingerprintContent(device.deviceToken, "file-chunks", signature);
        const declined = db.findOne("declinedFingerprints", (entry) =>
          entry.deviceId === device._id && entry.fingerprint === fingerprint
        );
        if (declined) {
          c = { categories: declined.categories || [], scan_status: declined.scanStatus || "unscannable", highest_risk_category: declined.highestRiskCategory || null };
          autoDeclined = true;
        }
      }
    } else {
      const fileBytes = Buffer.from(f.dataBase64, "base64");
      sha = crypto.createHash("sha256").update(fileBytes).digest("hex");
      fingerprint = fingerprintContent(device.deviceToken, "file", fileBytes);
      const declined = db.findOne("declinedFingerprints", (entry) =>
        entry.deviceId === device._id && entry.fingerprint === fingerprint
      );
      if (declined) {
        c = { categories: declined.categories || [], scan_status: declined.scanStatus || "unscannable", highest_risk_category: declined.highestRiskCategory || null };
        autoDeclined = true;
      } else {
        c = await classificationClient.classifyFile({ name, dataBase64: f.dataBase64 }, tool);
      }
      f.dataBase64 = null; // drop the bytes immediately
    }
    items.push({
      kind: "file",
      name,
      mime: String(f.mime || "").slice(0, 100),
      categories: c.categories || [],
      scanStatus: c.scan_status || "unscannable",
      reason: c.reason || null,
      maskable: false, // files can't be masked in the MVP -- allow or decline only
      sha256: sha,
      fingerprint,
      size: declaredSize,
      highest_risk_category: c.highest_risk_category || null,
    });
  }

  const needsPermission = autoDeclined || items.some((i) => policyEngine.requiresPermission(i.categories, i.scanStatus));
  const scanId = putScan({
    deviceId: device._id,
    tool,
    needsPermission,
    decision: autoDeclined ? "decline" : null,
    autoDeclined,
    // redactedText is held server-side only for the audit trail.
    items: items.map((i) => ({ ...i })),
  });

  return sendJson(res, 200, {
    scanId,
    requiresPermission: needsPermission && !autoDeclined,
    autoDeclined,
    items: items.map((i) => ({
      kind: i.kind,
      name: i.name,
      categories: i.categories,
      scanStatus: i.scanStatus,
      reason: i.reason,
      maskable: i.maskable,
      redactedText: i.kind === "text" ? i.redactedText : undefined,
    })),
  });
}

async function handleCreateEvent(req, res) {
  const device = authenticateDevice(req);
  if (!device) {
    return sendJson(res, 401, { error: "invalid_or_missing_device_token" });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    const code = err.message === "payload_too_large" ? 413 : 400;
    return sendJson(res, code, { error: err.message });
  }

  const { tool, url, text, timestamp, eventType, scanId, userAction } = body;
  if (!tool || !eventType) {
    return sendJson(res, 400, { error: "`tool` and `eventType` are required" });
  }

  // ---- New flow: outcome of a scan + the employee's choice ----
  if (scanId) {
    const scan = scans.get(scanId);
    if (!scan || scan.deviceId !== device._id) {
      return sendJson(res, 410, { error: "scan_expired_or_unknown" });
    }
    if (scan.outcomeRecorded) {
      return sendJson(res, 409, { error: "scan_outcome_already_recorded" });
    }
    if (!policyEngine.USER_ACTIONS.has(userAction)) {
      return sendJson(res, 400, { error: "invalid `userAction`" });
    }
    if (scan.needsPermission && !scan.decision) {
      return sendJson(res, 403, { error: "dashboard_approval_pending" });
    }
    if (scan.needsPermission && scan.decision !== "allow" && userAction !== "declined") {
      return sendJson(res, 403, { error: "dashboard_declined_sensitive_content" });
    }
    if (scan.needsPermission && scan.decision === "allow" && !["allowed", "redacted_sent", "declined"].includes(userAction)) {
      return sendJson(res, 403, { error: "dashboard_approval_required_for_sensitive_content" });
    }
    // Content that needs permission can never be logged as "clean".
    if (scan.needsPermission && userAction === "clean") {
      return sendJson(res, 400, { error: "userAction_clean_not_allowed_for_flagged_content" });
    }
    if (userAction === "declined") {
      await rememberDeclinedContent(device._id, scan);
    }
    scan.outcomeRecorded = true;
    scans.delete(scanId);

    const categories = [...new Set(scan.items.flatMap((i) => i.categories))];
    const anyUnscannable = scan.items.some((i) => i.scanStatus === "unscannable");
    const anyPartial = scan.items.some((i) => i.scanStatus === "partial");
    const worst = scan.items.find((i) => i.highest_risk_category);
    const merged = {
      categories,
      highest_risk_category: worst ? worst.highest_risk_category : null,
      scan_status: anyUnscannable ? "unscannable" : anyPartial ? "partial" : "scanned",
    };
    const toolInfo = policyEngine.getToolInfo(tool);
    const result = policyEngine.evaluate(merged, toolInfo, userAction);
    const textItem = scan.items.find((i) => i.kind === "text");
    const fileItems = scan.items.filter((i) => i.kind === "file");

    const event = await db.insert("events", {
      orgId: device.orgId,
      deviceId: device._id,
      userId: device.userId,
      tool,
      url: url || null,
      eventType: fileItems.length ? "file_upload" : "content_submit",
      clientTimestamp: timestamp || null,
      rawTextHash: textItem ? textItem.sha256 : null,
      redactedText: textItem ? textItem.redactedText : null, // never the raw text
      destinationCountry: null,
      destinationStatus: "not_verified",
      files: fileItems.map((f) => ({
        name: f.name, mime: f.mime, size: f.size, sha256: f.sha256,
        categories: f.categories, scanStatus: f.scanStatus, reason: f.reason || null,
      })),
      categories,
      highestRiskCategory: merged.highest_risk_category,
      userAction,
      decision: result.decision,
      decisionReason: result.reason,
    });
    await db.updateOne("devices", (d) => d._id === device._id, { lastSeen: new Date().toISOString() });
    return sendJson(res, 201, {
      eventId: event._id, decision: result.decision, reason: result.reason, categories,
    });
  }

  // Discovery-only events (just visiting an AI tool, no text submitted
  // yet) skip classification entirely — this is what makes Discovery
  // cheap and safe to ship before Data-Flow Inspection is fully tuned.
  let classification = { categories: [], confidence: {}, highest_risk_category: null };
  let policyResult = { decision: "allow", reason: "Discovery event — no content submitted." };

  if (eventType === "content_submit" && typeof text === "string" && text.length > 0) {
    classification = await classificationClient.classify(text, tool);
    const toolInfo = policyEngine.getToolInfo(tool);
    policyResult = policyEngine.evaluate(classification, toolInfo);
  }

  const event = await db.insert("events", {
    orgId: device.orgId,
    deviceId: device._id,
    userId: device.userId,
    tool,
    url: url || null,
    eventType,
    clientTimestamp: timestamp || null,
    rawTextHash: typeof text === "string" ? hashText(text) : null,
    redactedText: classification.redacted_text || null,
    destinationCountry: null,
    destinationStatus: "not_verified",
    categories: classification.categories || [],
    highestRiskCategory: classification.highest_risk_category || null,
    decision: policyResult.decision,
    decisionReason: policyResult.reason,
  });

  await db.updateOne("devices", (d) => d._id === device._id, {
    lastSeen: new Date().toISOString(),
  });

  return sendJson(res, 201, {
    eventId: event._id,
    decision: policyResult.decision,
    reason: policyResult.reason,
    categories: classification.categories,
  });
}

function handleListEvents(req, res, query) {
  const limit = Math.min(parseInt(query.get("limit") || "50", 10) || 50, 500);
  const events = db
    .find("events", (e) => e.orgId === DEFAULT_ORG_ID)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, limit);
  return sendJson(res, 200, { events, count: events.length });
}

function handleRopa(req, res) {
  const events = db.find("events", (e) => e.orgId === DEFAULT_ORG_ID);
  const rows = new Map();
  for (const event of events) {
    for (const category of (event.categories && event.categories.length ? event.categories : ["UNCLASSIFIED"])) {
      const key = `${event.tool}\\0${category}`;
      const row = rows.get(key) || { tool: event.tool, dataCategory: category, activityCount: 0, firstSeen: event.createdAt, lastSeen: event.createdAt };
      row.activityCount++;
      if (new Date(event.createdAt) < new Date(row.firstSeen)) row.firstSeen = event.createdAt;
      if (new Date(event.createdAt) > new Date(row.lastSeen)) row.lastSeen = event.createdAt;
      rows.set(key, row);
    }
  }
  return sendJson(res, 200, { generatedAt: new Date().toISOString(), purpose: "AI interaction; business purpose not captured", department: "Not recorded", destination: "Not verified", records: [...rows.values()] });
}

async function handleCreateIncident(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (err) { return sendJson(res, 400, { error: err.message }); }
  const title = String(body.title || "").trim().slice(0, 160);
  if (!title) return sendJson(res, 400, { error: "title_required" });
  const incident = await db.insert("incidents", {
    orgId: DEFAULT_ORG_ID, title,
    occurredAt: body.occurredAt || null,
    discoveredAt: body.discoveredAt || new Date().toISOString(),
    tool: String(body.tool || "Unknown").slice(0, 100),
    severity: ["low", "medium", "high", "critical"].includes(body.severity) ? body.severity : "medium",
    dataCategories: Array.isArray(body.dataCategories) ? body.dataCategories.map((v) => String(v).slice(0, 60)).slice(0, 20) : [],
    affectedPeople: body.affectedPeople === "" || body.affectedPeople == null ? null : Math.max(0, Math.min(100000000, Number(body.affectedPeople) || 0)),
    affectedPeopleBasis: String(body.affectedPeopleBasis || "unknown").slice(0, 100),
    containment: String(body.containment || "").slice(0, 4000),
    notes: String(body.notes || "").slice(0, 8000),
    destinationCountry: null, destinationStatus: "not_verified", status: "open",
    reportType: "internal_draft_not_submitted",
    applicabilityNote: "Assess applicable DPDP/CERT-In/sector reporting duties and deadlines with the organization’s responsible team.",
    reportingGuidance: {
      certIn: "Specified Annexure-I cyber incidents: assess the six-hour reporting requirement from noticing; not every AI policy event is automatically reportable.",
      dpdp: "DPDP breach-notification duties are subject to staged commencement and applicability; verify the effective provisions and Rules at incident time.",
      sector: "Check current RBI, IRDAI or SEBI obligations for the regulated entity and incident type.",
    },
  });
  return sendJson(res, 201, { incident });
}

function handleListIncidents(req, res) {
  const incidents = db.find("incidents", (i) => i.orgId === DEFAULT_ORG_ID).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return sendJson(res, 200, { incidents });
}

function handleSummary(req, res) {
  const events = db.find("events", (e) => e.orgId === DEFAULT_ORG_ID);
  const byDecision = {};
  const byCategory = {};
  const byTool = {};

  for (const e of events) {
    byDecision[e.decision] = (byDecision[e.decision] || 0) + 1;
    byTool[e.tool] = (byTool[e.tool] || 0) + 1;
    for (const cat of e.categories || []) {
      byCategory[cat] = (byCategory[cat] || 0) + 1;
    }
  }

  return sendJson(res, 200, {
    totalEvents: events.length,
    byDecision,
    byCategory,
    byTool,
  });
}

function handleListTools(req, res) {
  const tools = db.find("aiTools");
  return sendJson(res, 200, { tools });
}

// ---------------------------------------------------------------------------
// Static file serving for the dashboard (no framework needed for a
// handful of static assets).
// ---------------------------------------------------------------------------
const MIME_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
};

function serveStatic(req, res, pathname) {
  let filePath = pathname === "/" ? "/index.html" : pathname;
  const resolved = path.join(DASHBOARD_DIR, filePath);

  // Prevent path traversal outside the dashboard directory.
  if (!resolved.startsWith(DASHBOARD_DIR)) {
    return sendJson(res, 403, { error: "forbidden" });
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      return sendJson(res, 404, { error: "not_found" });
    }
    const ext = path.extname(resolved);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const { pathname, searchParams } = parsedUrl;

  // Basic CORS preflight support (extension calls this API cross-origin).
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    return res.end();
  }

  try {
    if (req.method === "GET" && pathname === "/health") {
      return sendJson(res, 200, { status: "ok", service: "sentryai-api" });
    }
    if (req.method === "POST" && pathname === "/v1/auth/device") {
      return await handleRegisterDevice(req, res);
    }
    if (req.method === "POST" && pathname === "/v1/scan") {
      return await handleScan(req, res);
    }
    if (req.method === "GET" && pathname === "/v1/approvals") {
      return sendJson(res, 200, { approvals: listPendingApprovals() });
    }
    if (req.method === "POST" && pathname === "/v1/approvals") {
      return await handleApprovalDecision(req, res);
    }
    if (req.method === "GET" && pathname.startsWith("/v1/approvals/")) {
      const device = authenticateDevice(req);
      if (!device) return sendJson(res, 401, { error: "invalid_or_missing_device_token" });
      const scan = scans.get(pathname.slice("/v1/approvals/".length));
      if (!scan || !scan.needsPermission || scan.deviceId !== device._id) return sendJson(res, 404, { error: "approval_not_found" });
      return sendJson(res, 200, { decision: scan.decision });
    }
    if (req.method === "POST" && pathname === "/v1/events") {
      return await handleCreateEvent(req, res);
    }
    if (req.method === "GET" && pathname === "/v1/events") {
      return handleListEvents(req, res, searchParams);
    }
    if (req.method === "GET" && pathname === "/v1/summary") {
      return handleSummary(req, res);
    }
    if (req.method === "GET" && pathname === "/v1/ropa") return handleRopa(req, res);
    if (req.method === "GET" && pathname === "/v1/incidents") return handleListIncidents(req, res);
    if (req.method === "POST" && pathname === "/v1/incidents") return await handleCreateIncident(req, res);
    if (req.method === "GET" && pathname === "/v1/tools") {
      return handleListTools(req, res);
    }
    if (req.method === "GET") {
      return serveStatic(req, res, pathname);
    }

    return sendJson(res, 404, { error: "not_found" });
  } catch (err) {
    console.error("[server] unhandled error", err);
    return sendJson(res, 500, { error: "internal_server_error" });
  }
});

seedAiTools()
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`SentryAI API listening on http://${HOST}:${PORT}`);
      console.log(`Dashboard:   http://${HOST}:${PORT}/`);
      console.log("Classifier:  http://127.0.0.1:5001 (separate process)");
    });
  })
  .catch((err) => {
    console.error("[seed] failed to sync AI tool catalog", err);
    process.exitCode = 1;
  });

module.exports = server;
