"use strict";

async function updateStatus() {
  const statusEl = document.getElementById("status");
  const stored = await chrome.storage.local.get(["sentryai_device_token"]);
  if (stored.sentryai_device_token) {
    statusEl.innerHTML = '<span class="dot ok"></span>Registered';
  } else {
    statusEl.innerHTML = '<span class="dot err"></span>Not registered (is the API running?)';
  }
}

updateStatus();
