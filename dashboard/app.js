"use strict";

/**
 * SentryAI Dashboard (MVP) - vanilla JS, no build step.
 * Polls the API every 5s. Good enough for an MVP demo; a production
 * dashboard would use websockets/SSE for live push instead of polling.
 */

const API_BASE = ""; // same-origin: dashboard is served by the API itself
const REFRESH_INTERVAL_MS = 5000;
const NOTIFY_DECISIONS = new Set(["alert", "blocked", "redacted"]); // "clean" never pops a desktop alert

const el = {
  status: document.getElementById("connectionStatus"),
  statTotal: document.getElementById("statTotal"),
  statAlerts: document.getElementById("statAlerts"),
  statBlocked: document.getElementById("statBlocked"),
  statRedacted: document.getElementById("statRedacted"),
  statTools: document.getElementById("statTools"),
  statTopCategory: document.getElementById("statTopCategory"),
  eventsBody: document.getElementById("eventsBody"),
  approvalsList: document.getElementById("approvalsList"),
  pendingCount: document.getElementById("pendingCount"),
  refreshBtn: document.getElementById("refreshBtn"),
  notifyBtn: document.getElementById("notifyBtn"),
  ropaBody: document.getElementById("ropaBody"),
  incidentForm: document.getElementById("incidentForm"),
  incidentStatus: document.getElementById("incidentStatus"),
  activityDateFilter: document.getElementById("activityDateFilter"),
  customDateRange: document.getElementById("customDateRange"),
  activityDateFrom: document.getElementById("activityDateFrom"),
  activityDateTo: document.getElementById("activityDateTo"),
  activityDecisionFilter: document.getElementById("activityDecisionFilter"),
  activityTypeFilter: document.getElementById("activityTypeFilter"),
  activitySearch: document.getElementById("activitySearch"),
  clearActivityFilters: document.getElementById("clearActivityFilters"),
  activityFilterStatus: document.getElementById("activityFilterStatus"),
};

let loadedEvents = [];

async function downloadJson(endpoint, filename) {
  const response = await fetch(`${API_BASE}${endpoint}`);
  if (!response.ok) throw new Error("Could not export report");
  const data = await response.json();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function renderRopa(data) {
  el.ropaBody.innerHTML = data.records.length ? data.records.map((row) => `<tr><td>${escapeHtml(row.tool)}</td><td>${escapeHtml(row.dataCategory)}</td><td>${row.activityCount}</td><td>${formatTime(row.firstSeen)}<br>${formatTime(row.lastSeen)}</td><td>Not verified</td></tr>`).join("") : '<tr><td colspan="5" class="empty-state">No processing activity recorded yet.</td></tr>';
}

document.getElementById("exportRopa")?.addEventListener("click", async () => {
  try { await downloadJson("/v1/ropa", "sentryai-processing-register.json"); }
  catch (err) { window.alert(err.message); }
});

el.incidentForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = el.incidentForm.querySelector('button[type="submit"]');
  button.disabled = true;
  const form = new FormData(el.incidentForm);
  const payload = Object.fromEntries(form.entries());
  payload.dataCategories = payload.dataCategories.split(",").map((s) => s.trim()).filter(Boolean);
  payload.affectedPeopleBasis = payload.affectedPeople ? "user-entered estimate; verify before external reporting" : "unknown";
  try {
    const response = await fetch(`${API_BASE}/v1/incidents`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error("Could not save incident draft");
    el.incidentForm.reset();
    el.incidentStatus.textContent = "Internal draft saved. Review applicable reporting duties and deadlines before using externally.";
  } catch (err) { el.incidentStatus.textContent = err.message; }
  finally { button.disabled = false; }
});

document.getElementById("exportIncidents")?.addEventListener("click", async () => {
  try { await downloadJson("/v1/incidents", "sentryai-incident-drafts.json"); }
  catch (err) { window.alert(err.message); }
});

// ---------------------------------------------------------------------------
// Desktop notification + sound for new sensitive activity (alert / blocked /
// redacted). "clean" events never trigger this -- an admin doesn't need a
// popup for every harmless message, only for what needs their attention.
// ---------------------------------------------------------------------------
let knownEventIds = null; // null until the first successful load (avoids notifying for history on page load)
let knownApprovalIds = null;

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    [880, 660].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + i * 0.16);
      gain.gain.exponentialRampToValueAtTime(0.2, now + i * 0.16 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.16 + 0.15);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i * 0.16);
      osc.stop(now + i * 0.16 + 0.16);
    });
    setTimeout(() => ctx.close(), 500);
  } catch (err) {
    console.warn("[dashboard] could not play alert sound", err);
  }
}

function notifyDesktop(events) {
  if (!events.length) return;
  beep();
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const first = events[0];
  const title =
    events.length === 1
      ? `SentryAI - ${first.decision.toUpperCase()}: ${first.tool}`
      : `SentryAI - ${events.length} new alerts`;
  const body =
    events.length === 1
      ? (first.categories || []).join(", ") || "Could not be inspected"
      : events.map((e) => `${e.tool}: ${e.decision}`).join("\n").slice(0, 200);
  try {
    const n = new Notification(title, { body, tag: "sentryai-alert" });
    n.onclick = () => window.focus();
  } catch (err) {
    console.warn("[dashboard] Notification failed", err);
  }
}

function notifyApproval(approvals) {
  if (!approvals.length) return;
  beep();
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const first = approvals[0];
  const labels = first.items.flatMap((item) => item.categories || []);
  const title = approvals.length === 1 ? `SentryAI — approval needed: ${first.tool}` : `SentryAI — ${approvals.length} approvals needed`;
  const body = approvals.length === 1 ? (labels.join(", ") || "File could not be fully inspected") : "Open the SentryAI dashboard to review pending content.";
  try { new Notification(title, { body, tag: "sentryai-approval", requireInteraction: true }); }
  catch (err) { console.warn("[dashboard] approval notification failed", err); }
}

function updateNotifyBtn() {
  if (typeof Notification === "undefined") {
    el.notifyBtn.textContent = "Notifications unsupported";
    el.notifyBtn.disabled = true;
    return;
  }
  const state = Notification.permission;
  el.notifyBtn.textContent =
    state === "granted" ? "Desktop alerts on" : state === "denied" ? "Desktop alerts blocked" : "Enable desktop alerts";
  el.notifyBtn.disabled = state === "denied";
}

el.notifyBtn?.addEventListener("click", async () => {
  if (typeof Notification === "undefined") return;
  await Notification.requestPermission();
  updateNotifyBtn();
});
updateNotifyBtn();

function setStatus(ok) {
  el.status.textContent = ok ? "Live" : "Disconnected";
  el.status.className = "status " + (ok ? "ok" : "error");
}

function formatTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleString("en-IN", { hour12: true, dateStyle: "short", timeStyle: "medium" });
}

function renderSummary(summary) {
  el.statTotal.textContent = summary.totalEvents ?? 0;
  el.statAlerts.textContent = summary.byDecision?.alert ?? 0;
  el.statBlocked.textContent = summary.byDecision?.blocked ?? 0;
  el.statRedacted.textContent = summary.byDecision?.redacted ?? 0;
  el.statTools.textContent = Object.keys(summary.byTool || {}).length;

  const categories = Object.entries(summary.byCategory || {});
  if (categories.length === 0) {
    el.statTopCategory.textContent = "None";
  } else {
    categories.sort((a, b) => b[1] - a[1]);
    el.statTopCategory.textContent = categories[0][0];
  }
}

function getFilteredEvents(events) {
  const preset = el.activityDateFilter.value;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  let from = -Infinity;
  let until = Infinity;
  if (preset === "today") {
    from = todayStart;
  } else if (preset === "yesterday") {
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
    until = todayStart;
  } else if (preset === "7days" || preset === "10days") {
    const days = preset === "7days" ? 7 : 10;
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1).getTime();
  } else if (preset === "custom") {
    if (el.activityDateFrom.value) from = new Date(`${el.activityDateFrom.value}T00:00:00`).getTime();
    if (el.activityDateTo.value) {
      const to = new Date(`${el.activityDateTo.value}T00:00:00`);
      to.setDate(to.getDate() + 1);
      until = to.getTime();
    }
  }

  const decision = el.activityDecisionFilter.value;
  const type = el.activityTypeFilter.value;
  const search = el.activitySearch.value.trim().toLowerCase();
  return events.filter((event) => {
    const time = new Date(event.createdAt).getTime();
    if (!Number.isFinite(time) || time < from || time >= until) return false;
    if (decision !== "all" && event.eventType === "page_visit") return false;
    if (decision !== "all" && event.decision !== decision) return false;
    if (type === "requests" && !["content_submit", "file_upload"].includes(event.eventType)) return false;
    if (type !== "all" && type !== "requests" && event.eventType !== type) return false;
    if (search) {
      const haystack = [event.tool, event.userId, event.eventType, ...(event.categories || [])].join(" ").toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

function updateActivityFilters() {
  const preset = el.activityDateFilter.value;
  el.customDateRange.hidden = preset !== "custom";
  const filtered = getFilteredEvents(loadedEvents);
  const invalidRange = el.activityDateFrom.value && el.activityDateTo.value && el.activityDateFrom.value > el.activityDateTo.value;
  el.activityFilterStatus.textContent = invalidRange
    ? "The start date must be on or before the end date."
    : `Showing ${filtered.length} of ${loadedEvents.length} recent events loaded. Filters affect this table only; pending approvals stay visible and summary cards remain all-time.`;
  renderEvents(filtered, loadedEvents.length);
}

function renderEvents(events, loadedCount = events?.length || 0) {
  if (!events || events.length === 0) {
    const message = loadedCount === 0
      ? "No activity yet - waiting for events from the browser extension."
      : "No requests match these filters.";
    el.eventsBody.innerHTML = `<tr><td colspan="8" class="empty-state">${message}</td></tr>`;
    return;
  }

  el.eventsBody.innerHTML = events
    .map((e) => {
      const categoryBadges = (e.categories || [])
        .map((c) => `<span class="badge badge-category">${escapeHtml(c)}</span>`)
        .join(" ") || "<span style=\"color:#9aa5c0\">-</span>";
      const destination = e.destinationStatus === "verified" && e.destinationCountry
        ? `Destination: ${escapeHtml(e.destinationCountry)}`
        : "Destination: not verified";

      const decisionBadge = `<span class="badge badge-decision-${e.decision}">${e.decision.toUpperCase()}</span>`;

      const files = (e.files || [])
        .map((f) => {
          const cats = (f.categories || []).join(", ") || (f.scanStatus === "unscannable" ? "could not be inspected" : "clean");
          const status = f.scanStatus === "partial" ? " · partly inspected" : f.scanStatus === "unscannable" ? " · inspection failed" : "";
          const reason = f.reason ? ` · ${escapeHtml(f.reason)}` : "";
          return `File: ${escapeHtml(f.name)} <span style="color:#9aa5c0">(${escapeHtml(cats + status + reason)})</span>`;
        })
        .join("<br>");
      const detail =
        e.eventType === "page_visit"
          ? `<em style="color:#9aa5c0">${escapeHtml(e.eventType)}</em>`
          : [escapeHtml(e.redactedText || ""), files].filter(Boolean).join("<br>") || (e.eventType === "file_upload" ? "File metadata unavailable" : "(no content)");
      const choiceLabels = { clean: "-", allowed: "Allowed", declined: "Declined", redacted_sent: "Masked & sent" };
      const userChoice = e.userAction ? choiceLabels[e.userAction] || e.userAction : "-";

      return `
        <tr>
          <td>${formatTime(e.createdAt)}</td>
          <td>${escapeHtml(e.userId || "unknown")}</td>
          <td>${escapeHtml(e.tool)}</td>
          <td>${escapeHtml(e.eventType)}</td>
          <td>${categoryBadges}<div class="event-destination">${destination}</div></td>
          <td>${decisionBadge}</td>
          <td>${escapeHtml(userChoice)}</td>
          <td>${detail}</td>
        </tr>`;
    })
    .join("");
}

[
  el.activityDateFilter,
  el.activityDateFrom,
  el.activityDateTo,
  el.activityDecisionFilter,
  el.activityTypeFilter,
].forEach((control) => control.addEventListener("change", updateActivityFilters));
el.activitySearch.addEventListener("input", updateActivityFilters);
el.clearActivityFilters.addEventListener("click", () => {
  el.activityDateFilter.value = "10days";
  el.activityDateFrom.value = "";
  el.activityDateTo.value = "";
  el.activityDecisionFilter.value = "all";
  el.activityTypeFilter.value = "all";
  el.activitySearch.value = "";
  updateActivityFilters();
});

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

function renderApprovals(approvals) {
  if (!el.approvalsList) return;
  if (el.pendingCount) el.pendingCount.textContent = approvals.length;
  if (!approvals.length) {
    el.approvalsList.innerHTML = '<p class="empty-state">No pending approvals.</p>';
    return;
  }
  el.approvalsList.innerHTML = approvals.map((approval) => {
    const items = approval.items.map((item) => {
      const labels = (item.categories || []).join(", ") || (item.scanStatus === "partial" ? "Partly inspected" : item.scanStatus === "unscannable" ? "Could not be inspected" : "No sensitive data found");
      return `<li><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(labels)}${item.scanStatus === "partial" ? " · partly inspected" : ""}</span></li>`;
    }).join("");
    return `<article class="approval-card"><div><strong>${escapeHtml(approval.tool)}</strong><small>${formatTime(approval.createdAt)}</small></div><ul>${items}</ul><div class="approval-actions"><button data-approval="${escapeHtml(approval.scanId)}" data-decision="allow" class="approve-btn">Allow</button><button data-approval="${escapeHtml(approval.scanId)}" data-decision="decline" class="decline-btn">Decline</button></div></article>`;
  }).join("");
}

el.approvalsList?.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-approval]");
  if (!button) return;
  button.disabled = true;
  try {
    const response = await fetch(`${API_BASE}/v1/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scanId: button.dataset.approval, decision: button.dataset.decision }),
    });
    if (!response.ok) throw new Error("Approval was already handled or expired.");
    await refresh();
  } catch (err) {
    button.disabled = false;
    console.error("[dashboard] approval failed", err);
    window.alert(err.message || "Approval failed. Refresh and try again.");
  }
});

let refreshInProgress = false;

async function refresh() {
  if (refreshInProgress) return;
  refreshInProgress = true;
  try {
    const [eventsRes, summaryRes, approvalsRes, ropaRes] = await Promise.all([
      fetch(`${API_BASE}/v1/events?limit=500`),
      fetch(`${API_BASE}/v1/summary`),
      fetch(`${API_BASE}/v1/approvals`),
      fetch(`${API_BASE}/v1/ropa`),
    ]);
    if (!eventsRes.ok || !summaryRes.ok || !approvalsRes.ok || !ropaRes.ok) throw new Error("API returned an error status");

    const eventsData = await eventsRes.json();
    const summaryData = await summaryRes.json();
    const approvalsData = await approvalsRes.json();
    const ropaData = await ropaRes.json();

    loadedEvents = eventsData.events || [];
    updateActivityFilters();
    renderSummary(summaryData);
    renderApprovals(approvalsData.approvals || []);
    renderRopa(ropaData);
    const approvals = approvalsData.approvals || [];
    const pendingIds = new Set(approvals.map((approval) => approval.scanId));
    const freshApprovals = knownApprovalIds === null ? [] : approvals.filter((approval) => !knownApprovalIds.has(approval.scanId));
    if (freshApprovals.length) notifyApproval(freshApprovals);
    knownApprovalIds = pendingIds;
    setStatus(true);

    // Notify on any event that's new since the last poll AND needs attention.
    const currentIds = new Set(eventsData.events.map((e) => e._id));
    if (knownEventIds !== null) {
      const fresh = eventsData.events.filter((e) => !knownEventIds.has(e._id) && NOTIFY_DECISIONS.has(e.decision));
      if (fresh.length) notifyDesktop(fresh);
    }
    knownEventIds = currentIds;
  } catch (err) {
    console.error("[dashboard] refresh failed", err);
    setStatus(false);
  } finally {
    refreshInProgress = false;
  }
}

el.refreshBtn.addEventListener("click", refresh);
refresh();
setInterval(refresh, REFRESH_INTERVAL_MS);
