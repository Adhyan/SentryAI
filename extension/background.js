"use strict";

/**
 * SentryAI Agent — Background Service Worker
 * ---------------------------------------------
 * Responsibilities (per the architecture doc, Section 4.1):
 *   1. Register this browser install as a "device" with the backend on
 *      first run, and cache the device token in chrome.storage.local.
 *   2. Receive events from content scripts (via chrome.runtime.sendMessage)
 *      and forward them to the Ingestion API, attaching the device token.
 *
 * Why this lives in the background worker and not the content script:
 * content scripts run in the page's context per-tab and are torn down
 * when the tab closes; the service worker is the durable place to hold
 * the auth token and make the actual network call.
 */

const API_BASE = "http://127.0.0.1:3000"; // MVP: local dev API. Swap for the deployed org endpoint in production.
const DEVICE_TOKEN_KEY = "sentryai_device_token";

async function getOrRegisterDevice() {
  const stored = await chrome.storage.local.get([DEVICE_TOKEN_KEY]);
  if (stored[DEVICE_TOKEN_KEY]) {
    return stored[DEVICE_TOKEN_KEY];
  }

  try {
    const res = await fetch(`${API_BASE}/v1/auth/device`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // MVP note: userId is a placeholder. Production would resolve this
      // via SSO/enterprise-managed Chrome profile, not a hardcoded value.
      body: JSON.stringify({ userId: "demo.user@sentryai.test" }),
    });
    if (!res.ok) throw new Error(`device registration failed: ${res.status}`);
    const data = await res.json();
    await chrome.storage.local.set({ [DEVICE_TOKEN_KEY]: data.deviceToken });
    console.log("[SentryAI] device registered:", data.deviceId);
    return data.deviceToken;
  } catch (err) {
    console.error("[SentryAI] device registration failed — is the API running on 127.0.0.1:3000?", err);
    return null;
  }
}

/**
 * POST to the API with the device token. If the API rejects the token
 * (401 -- e.g. the backend's data was reset), re-register once and retry.
 */
async function authedPost(path, payload, timeoutMs = 60000) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getOrRegisterDevice();
    if (!token) return { ok: false, reason: "no_device_token" };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && attempt === 0) {
        await chrome.storage.local.remove(DEVICE_TOKEN_KEY);
        continue;
      }
      if (!res.ok) {
        console.error(`[SentryAI] ${path} failed`, res.status, data);
        return { ok: false, reason: data.error || `http_${res.status}` };
      }
      return { ok: true, ...data };
    } catch (err) {
      console.error(`[SentryAI] ${path} network error`, err);
      return { ok: false, reason: err.name === "AbortError" ? "timeout" : "network_error" };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, reason: "auth_failed" };
}

const sendEvent = (event) => authedPost("/v1/events", event, 15000);
// Scan text/files BEFORE they reach the AI tool (nothing is logged by this call).
const scanContent = (payload) => authedPost("/v1/scan", payload, 60000);
async function getApproval(scanId) {
  const token = await getOrRegisterDevice();
  if (!token) return { ok: false, reason: "no_device_token" };
  try {
    const res = await fetch(`${API_BASE}/v1/approvals/${encodeURIComponent(scanId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, ...data } : { ok: false, reason: data.error || `http_${res.status}` };
  } catch (err) {
    return { ok: false, reason: "network_error" };
  }
}

// Content scripts message this worker rather than calling fetch()
// directly, so all network/auth logic stays in one place.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "SENTRYAI_EVENT") {
    sendEvent(message.payload).then(sendResponse);
    return true; // keep the channel open for the async response
  }
  if (message?.type === "SENTRYAI_SCAN") {
    scanContent(message.payload).then(sendResponse);
    return true;
  }
  if (message?.type === "SENTRYAI_GET_APPROVAL") {
    getApproval(message.scanId).then(sendResponse);
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  getOrRegisterDevice();
});
