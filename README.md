# SentryAI â€” MVP Prototype

A working, locally-runnable prototype of the SentryAI shadow-AI governance
platform, built against the scope defined in `SentryAI_Technical_Architecture_MVP.docx`
(Section 10.1, "In Scope for MVP").

**What it does:** detects when an employee visits one of the supported AI tools
(ChatGPT, Claude, Gemini, DeepSeek, Perplexity, Grok, Grammarly, or QuillBot) in
Chrome and scans typed text, attached files, photos, pasted screenshots, and
drag-and-drop content before the site receives it. If sensitive data or content
that could not be inspected is found, the submission waits for an administrator
to choose in the SentryAI dashboard:

| Choice | What happens |
|---|---|
| **Decline** | Nothing reaches the AI tool. Declined files are removed. |
| **Allow** | Content is sent as-is and logged as an administrator-approved override. |

Clean content is released automatically. If the scanner/API is unavailable, the
submission is held and fails closed. Activity appears on the dashboard. New
sensitive events can trigger a desktop notification and sound while the dashboard
is open and browser notifications are enabled. Stored data includes redacted text, file metadata, and device-keyed fingerprints
for declined content; raw text and file bytes are never persisted. Decline
fingerprints remain until server data is reset.

**What it deliberately does not do yet:** enforce a no-code policy builder, integrate SSO, mask inside files, or run against a real database; see [Known Limitations](#known-limitations--whats-next) below.
These are unbuilt by design, matching the MVP scope in the architecture
doc, not oversights.

---

## Project Structure

```
sentryai-mvp/
â”œâ”€â”€ extension/                 # Chrome Extension (Manifest V3, plain JS)
â”‚   â”œâ”€â”€ manifest.json
â”‚   â”œâ”€â”€ background.js          # device auth + API bridge
â”‚   â”œâ”€â”€ content.js             # holds text/file sends, scans, waits for dashboard approval
â”‚   â”œâ”€â”€ popup.html / popup.js  # toolbar status popup
â”‚   â””â”€â”€ icons/
â”œâ”€â”€ api/                        # Node.js ingestion + dashboard API
â”‚   â”œâ”€â”€ src/server.js          # HTTP router (built-in `http`, zero deps)
â”‚   â”œâ”€â”€ src/db.js              # JSON-file data store (MongoDB-shaped interface)
â”‚   â”œâ”€â”€ src/policyEngine.js    # allow/alert decision logic
â”‚   â”œâ”€â”€ src/classificationClient.js
â”‚   â””â”€â”€ data/                  # created at runtime â€” events.json, devices.json, declinedFingerprints.json, etc.
â”œâ”€â”€ classification-service/    # Python/Flask PII & data classifier
â”‚   â”œâ”€â”€ app.py
â”‚   â”œâ”€â”€ recognizers.py         # Aadhaar/PAN/phone/email/financial/code/ID-doc/secret detectors
â”‚   â””â”€â”€ file_extractor.py      # text from txt/csv/pdf/docx/xlsx/pptx/zip + OCR for images
â”œâ”€â”€ dashboard/                  # Static HTML/CSS/JS dashboard (served by the API)
â”œâ”€â”€ test/integration_test.sh   # automated end-to-end test suite
â”œâ”€â”€ start.sh                    # runs classification service + API together
â””â”€â”€ docker-compose.yml         # Phase-2 reference (not needed for the MVP)
```

## Why no MongoDB / Express / Presidio in the MVP

This prototype was built in a network-isolated environment (no `npm
install`, no `pip install` beyond what's already present). Rather than
produce non-runnable code that *references* packages you'd have to trust
blindly, every component here **actually runs**, using only what's
built into Node.js, Python's standard library, and Flask (already
available). See the "Production upgrade path" comments in `api/src/db.js`
and `classification-service/recognizers.py` for exactly what to swap in
and where, once you have internet access / real infrastructure. The
interfaces are already shaped to make those swaps mechanical, not
rewrites.

---

## Setup & Run

### Prerequisites
- Node.js 18+ (no `npm install` needed â€” zero external dependencies)
- Python 3.9+ â€” `pip install -r classification-service/requirements.txt`
- **Tesseract OCR** (needed to read photos / screenshots):
  Windows: install from https://github.com/UB-Mannheim/tesseract/wiki and add to PATH Â·
  macOS: `brew install tesseract` Â· Ubuntu: `sudo apt install tesseract-ocr`.
  Optional: `poppler-utils` (`pdftotext`, `pdftoppm`) for best PDF support.
  Without Tesseract, images are treated as "could not be inspected" and the
  employee is asked to Allow / Decline them.
- Google Chrome (for the extension)

### 1. Start the backend

```bash
cd sentryai-mvp
./start.sh
```

This starts:
- Classification service on `http://127.0.0.1:5001`
- Ingestion API + dashboard on `http://127.0.0.1:3000`

Open **http://127.0.0.1:3000/** â€” you'll see the live dashboard (empty
until the extension sends events, or run the test script to seed sample data).

Sensitive submissions appear in the dashboard's Pending approvals panel.

The dashboard also includes operational risk labels for health, biometrics and
child-related signals (heuristics, not age/consent verification), an internal
incident-draft workflow, a log-derived AI processing register export, and
framework reference links for DPDP, CERT-In, RBI, IRDAI and SEBI. Vendor
destination geography remains **not verified** unless the organization checks
the vendor and its account-specific terms. These tools support governance work;
they do not certify legal compliance or submit incident notices.
Click **Allow** to release the checked content or **Decline** to block it.
If no decision is made within five minutes, the extension blocks the content.

### 2. Load the Chrome Extension

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder
5. Visit `https://chatgpt.com`, `https://claude.ai`, `https://gemini.google.com`,
   or `https://www.perplexity.ai` â€” a discovery event appears on the dashboard within ~5s.
6. Type a message containing an Aadhaar-shaped number (e.g. `2345 6789 8018`)
   and press Enter â€” the submission is held. Use the dashboard Pending approvals panel to Allow or Decline it.
7. Attach or paste (Ctrl+V) a screenshot showing that number â€” the file waits for dashboard review.
   After editing the extension, click the reload icon on `chrome://extensions`
   **and refresh the AI tool tab**.

> The extension talks to `http://127.0.0.1:3000` â€” it only works while
> your local backend (`./start.sh`) is running.

### 3. Run the automated test suite

```bash
./test/integration_test.sh
```

Starts both services, exercises every API path (auth, discovery events,
clean content, sensitive content, dashboard queries, a privacy check
that raw sensitive text is never persisted to disk), and tears down
cleanly. Exits non-zero on any failed assertion â€” safe to wire into CI.

---

## API Contract

| Method & Path | Auth | Purpose |
|---|---|---|
| `GET /health` | none | liveness check |
| `POST /v1/auth/device` | none | register a browser install, returns `{deviceId, deviceToken}` |
| `POST /v1/scan` | `Bearer <deviceToken>` | scan text and/or files (base64) **before** they are sent; returns `scanId`, `requiresPermission`, per-item categories. Nothing is logged. |
| `POST /v1/events` | `Bearer <deviceToken>` | log an event: discovery, the outcome of a scan (`scanId` + `userAction`), or the legacy alert-only submit |
| `GET /v1/events?limit=50` | none (MVP; add auth before any real deployment) | list recent events for the dashboard |
| `GET /v1/summary` | none | aggregate counts (by decision / category / tool) |
| `GET /v1/tools` | none | reference list of known AI tool domains |

`POST /v1/events` request body:
```json
{
  "tool": "chatgpt.com",
  "url": "https://chatgpt.com/",
  "eventType": "content_submit",
  "text": "...",
  "timestamp": "2026-09-15T06:00:00Z"
}
```
After the employee chooses, the extension logs the outcome:
```json
{ "tool": "chatgpt.com", "eventType": "content_submit",
  "scanId": "<from /v1/scan>", "userAction": "declined" }
```
`userAction` is `clean | allowed | declined | redacted_sent` â†’ decision
`allow | alert | blocked | redacted`. Categories come from the server-side scan
(single-use `scanId`, 15-min TTL), so the client can't downgrade them, and
flagged content can't be logged as `clean`.

`eventType` is either `"page_visit"` (Discovery only, no classification
run) or `"content_submit"` (Data-Flow Inspection â€” `text` is classified
and checked against policy).

Response:
```json
{ "eventId": "...", "decision": "allow" | "alert", "reason": "...", "categories": [...] }
```

---

## Security Notes (already implemented, matching the architecture doc's Section 9)

- **Raw sensitive text is never written to disk.** Only a SHA-256 hash
  (for dedup/audit) and the *redacted* text are stored. Verified by the
  integration test's privacy check.
- Device tokens are opaque UUIDs, required on every event-ingestion call.
- Path traversal is blocked on the dashboard's static file server.
- Every mutating database operation is queued per-collection to prevent
  the read-modify-write race that a naive JSON-file store would otherwise
  have under concurrent writes (see `db.js` â€” this was caught and fixed
  during build/review; see `## Build Review Notes

The earlier JSON-store write race remains fixed by serializing complete read/modify/write operations. This review also fixed API startup ordering, full-input redaction, attachment scan/send races, and composer action detection for Grammarly and QuillBot. Repeated declined content now uses device-keyed HMAC fingerprints; raw text and file bytes are not added to the remembered-decline store.

Validation completed: JavaScript and Python syntax checks; API and classifier health; eight-brand catalog count; PAN-only redaction; isolated API flows for repeated exact text and file content, renamed files, changed content, and large-file digest repeats. The full integration suite was not rerun.

