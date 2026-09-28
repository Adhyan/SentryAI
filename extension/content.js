"use strict";

/**
 * SentryAI Agent — Content Script (ask-before-send)
 * ---------------------------------------------------
 * Runs on the AI tool pages listed in manifest.json. Nothing the employee
 * types, pastes, drops or attaches reaches the AI tool until SentryAI has
 * checked it:
 *
 *   TEXT      Enter key / Send button / form submit is held, the text is
 *             scanned, and if it contains sensitive data it stays on hold
 *             until an admin chooses Allow or Decline in the dashboard.
 *   FILES     File-picker selections, drag-and-drop and pasted screenshots are
 *             held, OCR'd / text-extracted server-side and scanned the same way.
 *             Files can only be Allowed or Declined (no masking in the MVP).
 *             A declined file is removed and the AI tool never sees it.
 *
 * Clean content is released automatically. If the scan itself fails (API
 * down, timeout), the submission remains blocked and the employee is notified.
 *
 * Approved actions are replayed with the `bypass` flag set so our own
 * listeners don't intercept them a second time.
 *
 * Selector note: AI front-ends change their DOM often; the selectors below are
 * deliberately generic but will need periodic maintenance.
 */

const TOOL_DOMAIN = window.location.hostname;
const MAX_SCAN_FILE_BYTES = 10 * 1024 * 1024; // larger files are treated as "could not be inspected"

const INPUT_SELECTOR = 'textarea, [contenteditable="true"], [role="textbox"]';
const SEND_SPECIFIC = 'button[data-testid*="send" i], button[aria-label*="send" i]';
const SEND_ANY = SEND_SPECIFIC + ', button[type="submit"]';

const CATEGORY_LABELS = {
  PII_AADHAAR: "Aadhaar number",
  PII_PAN: "PAN number",
  PII_PHONE: "Phone number",
  PII_EMAIL: "Email address",
  CUSTOMER_DATA: "Customer data",
  EMPLOYEE_DATA: "Employee / HR data",
  COMPANY_CONFIDENTIAL: "Company confidential data",
  DATABASE_EXPORT: "Database / CRM export",
  PII_ID_DOCUMENT: "ID document",
  FINANCIAL_CARD: "Card number",
  FINANCIAL_IFSC: "Bank IFSC code",
  FINANCIAL_DATA: "Financial data",
  SOURCE_CODE: "Source code",
  SECRET_CREDENTIAL: "Password / API key",
};

let bypass = false; // true only while WE re-dispatch an approved action
let textBusy = false; // a text submission is being checked / awaiting a decision
let fileBusyCount = 0; // prevent a submit from racing an attachment scan

// ---------------------------------------------------------------------------
// Messaging helpers
// ---------------------------------------------------------------------------
function bg(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError || !response) resolve({ ok: false, reason: "no_response" });
        else resolve(response);
      });
    } catch (err) {
      resolve({ ok: false, reason: "extension_context_invalid" });
    }
  });
}

async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function fileFingerprintParts(file) {
  const CHUNK = 1024 * 1024;
  const parts = [];
  for (let offset = 0; offset < file.size; offset += CHUNK) {
    const bytes = await file.slice(offset, Math.min(offset + CHUNK, file.size)).arrayBuffer();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    parts.push(Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""));
  }
  return parts;
}

async function scan({ text, files }) {
  const fileParts = [];
  for (const f of files || []) {
    if (f.size > MAX_SCAN_FILE_BYTES) {
      fileParts.push({
        name: f.name,
        mime: f.type,
        size: f.size,
        tooLarge: true,
        fingerprintParts: await fileFingerprintParts(f),
      });
    } else {
      fileParts.push({ name: f.name, mime: f.type, size: f.size, dataBase64: await fileToBase64(f) });
    }
  }
  return bg({
    type: "SENTRYAI_SCAN",
    payload: { tool: TOOL_DOMAIN, url: window.location.href, text, files: fileParts },
  });
}

async function waitForAdminApproval(scanId) {
  const pending = showStatusSoon("Sensitive data found; waiting for admin dashboard approval…");
  // Poll from the content script. Chrome can suspend a background worker
  // after a few minutes, so one long-lived worker request is unreliable.
  for (let attempt = 0; attempt < 150; attempt++) { // 5 minutes maximum
    const result = await bg({ type: "SENTRYAI_GET_APPROVAL", scanId });
    if (result.ok && result.decision) {
      pending();
      return result.decision === "allow" ? "allow" : "decline";
    }
    if (!result.ok) {
      console.warn("[SentryAI] approval status check failed", result.reason);
      await sleep(2000);
      continue;
    }
    await sleep(2000);
  }
  pending();
  return "decline";
}

function logOutcome(scanId, userAction) {
  if (!scanId) return;
  bg({
    type: "SENTRYAI_EVENT",
    payload: {
      tool: TOOL_DOMAIN,
      url: window.location.href,
      eventType: "content_submit",
      scanId,
      userAction,
      timestamp: new Date().toISOString(),
    },
  });
}

function reportDiscoveryEvent() {
  bg({
    type: "SENTRYAI_EVENT",
    payload: {
      tool: TOOL_DOMAIN,
      url: window.location.href,
      eventType: "page_visit",
      timestamp: new Date().toISOString(),
    },
  });
}

// ---------------------------------------------------------------------------
// UI: status and outcome toasts (Shadow DOM so page CSS can't touch them, and
// every string is inserted with textContent so file names can't inject HTML)
// ---------------------------------------------------------------------------
const UI_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; }
  .overlay { position: fixed; inset: 0; background: rgba(15,20,45,.55); z-index: 2147483647;
             display: flex; align-items: center; justify-content: center; padding: 16px; }
  .card { background: #fff; color: #1b2340; width: min(480px, 100%); border-radius: 12px;
          box-shadow: 0 20px 60px rgba(0,0,0,.35); overflow: hidden; }
  .head { background: #1e2761; color: #fff; padding: 14px 18px; font-size: 15px; font-weight: 600; }
  .body { padding: 16px 18px; font-size: 13.5px; line-height: 1.5; max-height: 60vh; overflow: auto; }
  .body p { margin: 0 0 10px; }
  .item { border: 1px solid #e3e8f4; border-radius: 8px; padding: 8px 10px; margin: 0 0 8px; }
  .item .name { font-weight: 600; word-break: break-all; }
  .chip { display: inline-block; background: #fdecea; color: #b3261e; border-radius: 999px;
          padding: 1px 8px; margin: 4px 4px 0 0; font-size: 12px; }
  .chip.warn { background: #fff4e0; color: #8a5a00; }
  .chip.ok { background: #e6f6ef; color: #1b7f4b; }
  .toast.ok { background: #1b7f4b; }
  .toast.warn { background: #8a5a00; }
  .toast.danger { background: #b3261e; }
  .preview { background: #f5f7fc; border-radius: 8px; padding: 8px 10px; font-size: 12.5px;
             white-space: pre-wrap; word-break: break-word; max-height: 120px; overflow: auto; }
  .note { color: #5b6480; font-size: 12px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 18px 16px; justify-content: flex-end; }
  button { font-size: 13.5px; border-radius: 8px; padding: 9px 14px; cursor: pointer; border: 1px solid #c8d0e6; background: #fff; color: #1b2340; }
  button.primary { background: #1e2761; color: #fff; border-color: #1e2761; }
  button.danger { background: #fff; color: #b3261e; border-color: #e0a9a5; }
  button:focus-visible { outline: 3px solid #f2a63a; outline-offset: 2px; }
  .toast { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; background: #1e2761; color: #fff;
           padding: 10px 14px; border-radius: 8px; font-size: 13px; box-shadow: 0 6px 24px rgba(0,0,0,.3); max-width: 340px; }
`;

function makeHost() {
  const host = document.createElement("div");
  host.setAttribute("data-sentryai", "1");
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = UI_CSS;
  root.appendChild(style);
  (document.documentElement || document).appendChild(host);
  return { host, root };
}

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function showToast(message, ms = 4500, variant = "") {
  const { host, root } = makeHost();
  root.appendChild(el("div", `toast ${variant}`.trim(), message));
  const remove = () => host.remove();
  if (ms) setTimeout(remove, ms);
  return remove;
}

/**
 * One short confirmation toast per submission, for every outcome (not just
 * blocks) — so the employee always sees SentryAI acted, even when the
 * content was clean and went straight through.
 */
function notifyOutcome(kind, extra) {
  const what = extra?.what || "message";
  const map = {
    file_attached: [`File scanned and attached. Click Send in ${TOOL_DOMAIN} when ready.`, "ok", 4500],
    clean: [`✓ No sensitive data found — sent to ${TOOL_DOMAIN}`, "ok", 2200],
    allowed: [`⚠ Sent as-is to ${TOOL_DOMAIN} (you allowed it)`, "warn", 3000],
    redacted_sent: [`🔒 Masked and sent to ${TOOL_DOMAIN}`, "ok", 3000],
    declined: [`⛔ Blocked — ${what} was NOT sent to ${TOOL_DOMAIN}`, "danger", 3500],
    scan_failed_allowed: [`⚠ Sent without verification to ${TOOL_DOMAIN} (scanner unreachable)`, "warn", 3500],
    scan_failed_declined: [`⛔ Blocked — could not verify ${what}, so it was not sent`, "danger", 3500],
  };
  map.send_failed = [`Could not send to ${TOOL_DOMAIN}; your message is still in the composer.`, "warn", 3500];
  map.scan_in_progress = ["SentryAI is still checking an attachment. Click Send again when the check finishes.", "warn", 3500];
  map.auto_declined = [`Blocked automatically: this exact ${what} was declined before.`, "danger", 4000];
  const [msg, variant, ms] = map[kind] || [kind, "", 3000];
  showToast(msg, ms, variant);
}

/** Shows a "checking…" toast only if the scan takes longer than 300ms. */
function showStatusSoon(message) {
  let remove = null;
  const t = setTimeout(() => (remove = showToast(message, 0)), 300);
  return () => {
    clearTimeout(t);
    if (remove) remove();
  };
}

// ---------------------------------------------------------------------------
// Text handling
// ---------------------------------------------------------------------------
function findInputElement(target) {
  return target && target.closest ? target.closest(INPUT_SELECTOR) : null;
}

function extractText(node) {
  if (!node) return "";
  if (node.tagName === "TEXTAREA" || node.tagName === "INPUT") return node.value || "";
  return node.innerText || node.textContent || "";
}

function findSendButton(inputEl) {
  let node = inputEl;
  for (let i = 0; i < 8 && node; i++, node = node.parentElement) {
    const b = Array.from(node.querySelectorAll('button, [role="button"]')).find(isSubmitAction);
    if (b) return b;
  }
  return null;
}

function isSubmitAction(button) {
  if (!button) return false;
  if (button.matches(SEND_ANY)) return true;
  const label = [button.getAttribute("aria-label"), button.getAttribute("title"), button.innerText, button.textContent]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const host = window.location.hostname.toLowerCase();
  if (host === "grammarly.com" || host.endsWith(".grammarly.com")) {
    return /\b(rewrite|improve|generate|paraphrase|shorten|expand|continue)\b/.test(label);
  }
  if (host === "quillbot.com" || host.endsWith(".quillbot.com")) {
    return /^(paraphrase|rephrase|rewrite|summarize|expand|shorten|translate|humanize)\b/.test(label);
  }
  return false;
}

function setInputText(inputEl, text) {
  inputEl.focus();
  if (inputEl.tagName === "TEXTAREA" || inputEl.tagName === "INPUT") {
    const proto = inputEl.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(inputEl, text);
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, text);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withBypass(fn) {
  bypass = true;
  try {
    return fn();
  } finally {
    bypass = false;
  }
}

/** Re-triggers the send the employee originally attempted.
 * AI pages often re-render their composer while an admin reviews content,
 * so an old button reference cannot be trusted after a wait. */
async function replaySend(inputEl, originBtn) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const originalIsUsable = originBtn && originBtn.isConnected && !originBtn.disabled && originBtn.getAttribute("aria-disabled") !== "true";
    const currentBtn = findSendButton(inputEl);
    const btn = originalIsUsable ? originBtn : currentBtn;
    if (btn && btn.isConnected && !btn.disabled && btn.getAttribute("aria-disabled") !== "true") {
      withBypass(() => btn.click());
      return true;
    }
    await sleep(250);
  }
  // Do not synthesize Enter when we cannot identify a real send action:
  // it can trigger editor shortcuts without reliably submitting the prompt.
  return false;
}

async function guardText(inputEl, text, originBtn) {
  textBusy = true;
  try {
    const hideStatus = showStatusSoon("SentryAI is checking your message…");
    const result = await scan({ text });
    hideStatus();

    if (!result.ok) {
      notifyOutcome("scan_failed_declined", { what: "your message" });
      return;
    }

    if (result.autoDeclined) {
      logOutcome(result.scanId, "declined");
      notifyOutcome("auto_declined", { what: "message" });
      return;
    }

    if (!result.requiresPermission) {
      if (!(await replaySend(inputEl, originBtn))) {
        notifyOutcome("send_failed");
        return;
      }
      logOutcome(result.scanId, "clean");
      notifyOutcome("clean");
      return;
    }

    const decision = await waitForAdminApproval(result.scanId);
    if (decision !== "allow") {
      logOutcome(result.scanId, "declined");
      notifyOutcome("declined", { what: "your message" });
      return;
    }
    if (!(await replaySend(inputEl, originBtn))) {
      notifyOutcome("send_failed");
      return;
    }
    logOutcome(result.scanId, "allowed");
    notifyOutcome("allowed");
  } finally {
    textBusy = false;
  }
}

function holdEvent(e) {
  e.preventDefault();
  e.stopImmediatePropagation();
}

// Enter key. Capture phase + document_start => we run before the page's handlers.
document.addEventListener(
  "keydown",
  (e) => {
    if (bypass || e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    const inputEl = findInputElement(e.target);
    if (!inputEl) return;
    const text = extractText(inputEl).trim();
    if (!text && !fileBusyCount) return;
    holdEvent(e);
    if (fileBusyCount) {
      notifyOutcome("scan_in_progress");
      return;
    }
    if (textBusy) return; // already checking a message
    guardText(inputEl, text, null);
  },
  true
);

// Send button.
document.addEventListener(
  "click",
  (e) => {
    if (bypass || !e.target.closest) return;
    const btn = e.target.closest('button, [role="button"]');
    if (!isSubmitAction(btn)) return;
    let inputEl = null;
    let node = btn.closest("form") || btn.parentElement;
    for (let i = 0; i < 7 && node && !inputEl; i++, node = node.parentElement) {
      inputEl = node.querySelector(INPUT_SELECTOR);
    }
    const text = extractText(inputEl).trim();
    if (!text && !fileBusyCount) return; // checked attachments-only sends are handled by the site
    holdEvent(e);
    if (fileBusyCount) {
      notifyOutcome("scan_in_progress");
      return;
    }
    if (textBusy) return;
    guardText(inputEl, text, btn);
  },
  true
);

// Native form submission (belt and braces).
document.addEventListener(
  "submit",
  (e) => {
    if (bypass) return;
    const form = e.target;
    const inputEl = form && form.querySelector ? form.querySelector(INPUT_SELECTOR) : null;
    const text = extractText(inputEl).trim();
    if (!text && !fileBusyCount) return;
    holdEvent(e);
    if (fileBusyCount) {
      notifyOutcome("scan_in_progress");
      return;
    }
    if (textBusy) return;
    guardText(inputEl, text, form.querySelector('button[type="submit"]'));
  },
  true
);

// ---------------------------------------------------------------------------
// File handling: picker, drag-and-drop, pasted screenshots/photos
// ---------------------------------------------------------------------------
function toDataTransfer(files) {
  const dt = new DataTransfer();
  files.forEach((f) => dt.items.add(f));
  return dt;
}

async function guardFiles(files, { allow, decline }) {
  fileBusyCount += 1;
  try {
  const what = files.length === 1 ? `"${files[0].name}"` : `${files.length} files`;
  const hideStatus = showStatusSoon(`SentryAI is checking ${what}…`);
  let result;
  try {
    result = await scan({ files });
  } catch (err) {
    console.error("[SentryAI] file scan failed", err);
    hideStatus();
    decline();
    notifyOutcome("scan_failed_declined", { what });
    return;
  }
  hideStatus();

  if (!result.ok) {
    decline();
    notifyOutcome("scan_failed_declined", { what });
    return;
  }

  if (result.autoDeclined) {
    decline();
    logOutcome(result.scanId, "declined");
    notifyOutcome("auto_declined", { what });
    return;
  }

  if (!result.requiresPermission) {
    allow();
    logOutcome(result.scanId, "clean");
    notifyOutcome("file_attached");
    return;
  }

  const decision = await waitForAdminApproval(result.scanId);
  if (decision !== "allow") {
    decline();
    logOutcome(result.scanId, "declined");
    notifyOutcome("declined", { what });
    return;
  }
  allow();
  logOutcome(result.scanId, "allowed");
  notifyOutcome("file_attached");
  } finally {
    fileBusyCount -= 1;
  }
}

// File picker (<input type="file">). Block both `input` and `change`; the
// files are put back and the events replayed only if the employee allows it.
function isFileInput(t) {
  return t && t.tagName === "INPUT" && t.type === "file";
}
document.addEventListener(
  "input",
  (e) => {
    if (!bypass && isFileInput(e.target) && e.target.files && e.target.files.length) e.stopImmediatePropagation();
  },
  true
);
document.addEventListener(
  "change",
  (e) => {
    const input = e.target;
    if (bypass || !isFileInput(input) || !input.files || !input.files.length) return;
    holdEvent(e);
    const files = Array.from(input.files);
    guardFiles(files, {
      allow: () =>
        withBypass(() => {
          input.files = toDataTransfer(files).files;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }),
      decline: () => {
        input.value = "";
      },
    });
  },
  true
);

// Drag-and-drop of files onto the page.
document.addEventListener(
  "drop",
  (e) => {
    const dt = e.dataTransfer;
    if (bypass || !dt || !dt.files || !dt.files.length) return;
    holdEvent(e);
    const files = Array.from(dt.files);
    const { target, clientX, clientY } = e;
    guardFiles(files, {
      allow: () =>
        withBypass(() =>
          target.dispatchEvent(
            new DragEvent("drop", {
              bubbles: true, cancelable: true, composed: true,
              dataTransfer: toDataTransfer(files), clientX, clientY,
            })
          )
        ),
      decline: () => {},
    });
  },
  true
);

// Pasted screenshots / images / files (Ctrl+V).
document.addEventListener(
  "paste",
  (e) => {
    const cd = e.clipboardData;
    if (bypass || !cd || !cd.files || !cd.files.length) return;
    holdEvent(e);
    const files = Array.from(cd.files);
    const plain = cd.getData("text/plain");
    const html = cd.getData("text/html");
    const target = e.target;
    guardFiles(files, {
      allow: () =>
        withBypass(() => {
          const dt = toDataTransfer(files);
          if (plain) dt.setData("text/plain", plain);
          if (html) dt.setData("text/html", html);
          const notHandled = target.dispatchEvent(
            new ClipboardEvent("paste", { bubbles: true, cancelable: true, composed: true, clipboardData: dt })
          );
          // A synthetic paste has no default action; if the page didn't
          // consume it, insert the accompanying text ourselves.
          if (notHandled && plain) document.execCommand("insertText", false, plain);
        }),
      decline: () => {},
    });
  },
  true
);

reportDiscoveryEvent();
console.log(`[SentryAI] Agent active on ${TOOL_DOMAIN} (ask-before-send: text + files)`);
