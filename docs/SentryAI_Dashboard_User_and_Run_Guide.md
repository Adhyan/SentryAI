# SentryAI
## Dashboard User Guide & Full-Stack Runbook

**Operator and reviewer handbook**  
**Version:** 1.0 · **Prepared:** 28 September 2026  
**Project location:** `C:\Users\NC\Desktop\Startup Project`  
**Audience:** Demo operator, security reviewer, privacy/compliance team, founders

---

## Executive overview

This guide explains what each section and button in the SentryAI dashboard does, where its data comes from, how a reviewer should handle it, and how to start and stop the complete local MVP on Windows. It is written for the current code, not a future product design.

SentryAI currently has three runtime pieces: the Chrome extension, a Node.js API that also serves the dashboard, and a Python/Flask classifier. The dashboard is not a standalone desktop application. It needs the API and classifier running, and browser activity only appears after the extension is loaded and can reach the local API.

**Important:** this is a local, single-organization MVP. Keep demo data synthetic. The dashboard does not have user sign-in. The default API address is loopback on the same computer, so another laptop cannot connect to it as a shared service in this configuration.

---

## 1. Screen layout at a glance

The dashboard is served from `http://127.0.0.1:3000/` and is laid out top-to-bottom:

1. **Top bar** — SentryAI identity and API/dashboard connection state.
2. **Activity overview** — six summary cards.
3. **Pending approvals** — decisions that are holding a browser submission.
4. **Recent activity** — event-by-event audit table and refresh/notification controls.
5. **Framework coverage** — official reference links and product-scope notes.
6. **Internal incident report** — manual incident draft form and JSON export.
7. **AI processing register** — event-derived summary table and JSON export.
8. **Footer note** — local JSON storage/single-tenant reminder.

The layout adapts to smaller screens. On a narrow screen, wide tables may scroll horizontally.

---

## 2. Header and connection status

### SentryAI label

The header identifies the product and says “AI activity monitoring”. It is static branding.

### Status: Connecting / Live / Disconnected

`dashboard/app.js` calls the API for events, summary, pending approvals and register data immediately, then every five seconds. If those calls succeed, the header changes to **Live**; if any fails, it changes to **Disconnected**. This tests API/dashboard endpoints, not whether the Python classifier is healthy or whether the Chrome extension is installed.

To check the two services separately, open:

- API: `http://127.0.0.1:3000/health`
- Classifier: `http://127.0.0.1:5001/health`

Both should return JSON with `"status":"ok"`.

---

## 3. Activity overview cards

The six cards are calculated from stored events returned by `GET /v1/summary`.

| Card | What the number means | How to read it |
|---|---|---|
| Total events | All stored events for the demo organization | Includes page visits and submissions, not a count of distinct employees or AI conversations |
| Allowed by user (sensitive data sent) | Events with decision `alert` | A reviewer/employee override allowed content that policy had flagged; review the activity details |
| Declined / blocked | Events with decision `blocked` | Content was declined and the extension should not have sent it through the guarded flow |
| Sent masked | Events with decision `redacted` | A masked text version was sent; files cannot be masked in this MVP |
| AI tools seen | Distinct tool/domain strings in the summary | Usually domains such as `chatgpt.com`; one brand can have more than one domain |
| Top risk category | Category with the highest event count | A classifier signal, not a legal conclusion or verified personal-data identity |

The cards update on each successful five-second dashboard refresh. They do not refresh the classifier or re-scan old events.

---

## 4. Pending approvals

### Why an item appears

The Chrome extension pauses a supported text or file submission when the scan finds a configured risk category, cannot fully inspect a file, or cannot complete the scan. It sends a scan request to the API, which keeps the decision data temporarily in process memory. The dashboard requests the pending list from `GET /v1/approvals`.

An approval card can show:

- AI website/domain and time of the request.
- Text or file item name.
- Detected category labels, or a message that the file was partly/unable to be inspected.
- **Allow** and **Decline** buttons.

### Allow

Selecting Allow records the decision. The extension checks that decision, then replays the held submission through the supported page interaction and records the outcome. An Allow decision is an intentional policy override; it should be made by an authorized reviewer under the organization's policy.

### Decline

Selecting Decline records the decision. The guarded submission is not replayed; a declined attachment is removed from the page control where the site flow supports this. A device-keyed HMAC fingerprint is stored for the declined content so an exact repeat from that browser installation can be automatically declined, including across supported tools. A changed prompt or file gets a fresh review.

### Queue lifetime and timeout

Approval scans are held in API process memory for up to 15 minutes. The extension polls for up to five minutes; after that it declines the held item. Restarting the API clears pending approvals. This is a prototype queue, not a durable case-management system.

---

## 5. Recent activity table

The browser extension reports page visits and guarded submission outcomes to `POST /v1/events`. The table loads the newest 100 events from `GET /v1/events?limit=100`.

| Column | Meaning |
|---|---|
| Time | Server event timestamp shown in the browser's local time format |
| User | Current MVP identity; extension uses a demo placeholder, not company SSO |
| AI tool | Website domain observed by the extension |
| Event | Common values include `page_visit`, `content_submit`, `file_upload` |
| Categories | Classifier labels, such as `PII_PAN`, `CUSTOMER_DATA`, `HEALTH_DATA`, or `UNCLASSIFIED` |
| Decision | `allow`, `alert`, `blocked`, or `redacted` policy result |
| User choice | Employee/reviewer action when recorded: Allowed, Declined, Masked & sent, or `-` |
| Detail (redacted) | Text preview or file name/metadata and scan status; not a full conversation transcript by design |
| Destination note | “Not verified” unless country evidence is explicitly supplied; current catalog does not independently verify vendor location |

`Refresh` requests current activity, summaries, approvals and register immediately. Normal polling continues every five seconds. A visit to a supported AI page is a discovery event; it is not proof that a prompt was submitted to that provider.

### Important prompt privacy note

The activity column is labelled “Detail (redacted)”, but that label should not be taken as proof that every saved preview is masked. The current classifier returns unchanged input when it finds no categories, and an event path can persist that value in `redactedText`. Use synthetic prompts until that behavior has been corrected and independently verified. This is a code-level privacy risk documented in the companion architecture report.

---

## 6. Desktop alert controls

### Enable desktop alerts

Clicking the button asks Chrome for notification permission. Once granted, a newly observed `alert`, `blocked` or `redacted` event can trigger a short two-tone browser audio signal and an OS/browser notification. Clean `allow` events do not produce an alert.

The dashboard establishes a baseline on its first successful load, so old historical alerts do not all pop up on page open. If notifications are denied in browser settings, the button reports that notifications are blocked. Audio may also depend on browser interaction/autoplay behavior.

---

## 7. Framework coverage panel

This panel is a set of source links and applicability notes, not an interactive compliance engine. It currently references:

- **DPDP Act, 2023** as the primary privacy framework; commencement is staged, so operative provisions must be checked by incident date.
- **CERT-In Directions, 2022**; a six-hour reporting clock applies to specified incidents for covered entities. A SentryAI alert alone does not establish a reportable incident.
- **RBI payment-data localization / IT outsourcing** references; obligations depend on the regulated entity and kind of service/data. The product cannot infer server region.
- **IRDAI Information and Cyber Security Guidelines** for relevant insurance entities.
- **SEBI Cybersecurity and Cyber Resilience Framework (CSCRF)** for relevant securities-market entities.
- **India AI Governance Guidelines (MeitY, 5 November 2025)** as principle-based alignment guidance; this panel does not evaluate an AI model or certify a company.

Clicking a framework title opens its external reference in a new tab. Applicability, amendments and deadlines must be confirmed by the customer's legal/compliance owner. These notes must not be pitched as “compliance achieved”.

---

## 8. Internal incident report form

This is a manual internal record creator. It does not run as an automatic breach detector and does not send anything to a regulator.

| Field / button | What it does |
|---|---|
| Incident title | Required short incident label |
| AI tool | Free text for service/tool name; defaults to `Unknown` when not supplied |
| Severity | User's low/medium/high/critical assessment; not calculated by the app |
| Occurred at | Optional datetime entered by reviewer |
| People affected | Optional numeric estimate; blank means unknown; basis is labeled user-entered estimate when present |
| Data categories | Comma-separated internal labels such as `CUSTOMER_DATA, HEALTH_DATA` |
| Containment / actions | Free-text notes about steps taken |
| Notes | Additional internal information |
| Save internal draft | Sends fields to `POST /v1/incidents`, stores them in `api/data/incidents.json`, and clears the form on success |
| Export incident drafts | Downloads all stored incident drafts as JSON |

The API includes a reporting-guidance note for CERT-In, DPDP and sector review. The app does not determine whether the event is legally a breach, calculate a binding reporting deadline, maintain a visible status board, or submit an authority notice. Treat affected-person counts and notes as unverified until checked.

---

## 9. AI processing register

The register is generated from existing event logs through `GET /v1/ropa`.

### Columns

- **Tool:** observed website domain.
- **Data category:** classifier category; events without a category use `UNCLASSIFIED`.
- **Activities:** number of event/category observations in that row.
- **First / last observed:** earliest and latest event timestamps for that tool/category pair.
- **Destination:** currently “Not verified”.

The register groups each event under every category it carries. A multi-category event can therefore appear in more than one row. Page visits can create `UNCLASSIFIED` activity even when no prompt was submitted. Summing all row counts is not necessarily the number of distinct events. Department and business purpose are not collected. The export is a useful internal activity snapshot, not a complete statutory record of processing.

`Export register JSON` downloads the current API response as `sentryai-processing-register.json` in the browser's normal downloads location.

---

## 10. Full-stack run instructions — Windows

### Before starting

- Confirm Node.js 18+ is installed: `node --version`.
- Confirm Python is installed: `python --version`.
- Confirm the Python environment has Flask and required extraction packages. For a fresh setup, from the project folder run `python -m pip install -r classification-service\requirements.txt` (network access may be required).
- Tesseract OCR is optional for images, but without its executable readable text files may still work while image scans become unscannable. PDF helpers are optional.
- Use the project folder `C:\Users\NC\Desktop\Startup Project` if that is the copy you want to run.

### Start Terminal 1 — classifier

Open PowerShell and run:

```powershell
Set-Location 'C:\Users\NC\Desktop\Startup Project\classification-service'
..\.venv\Scripts\python.exe .\app.py
```

If the project has no `.venv` folder, use the Python executable that has the requirements installed:

```powershell
Set-Location 'C:\Users\NC\Desktop\Startup Project\classification-service'
python .\app.py
```

Leave this terminal open. The classifier should listen at `http://127.0.0.1:5001`.

### Start Terminal 2 — API and dashboard

Open a second PowerShell window:

```powershell
Set-Location 'C:\Users\NC\Desktop\Startup Project'
node .\api\src\server.js
```

Leave this terminal open. The API should listen at `http://127.0.0.1:3000` and serve the dashboard.

### Check service health

Open these URLs in a browser:

1. `http://127.0.0.1:5001/health` — classifier should return `sentryai-classification` and status `ok`.
2. `http://127.0.0.1:3000/health` — API should return `sentryai-api` and status `ok`.
3. `http://127.0.0.1:3000/` — dashboard should open and show **Live**.

Start classifier before the API so scans have a service to call. The API may still start if the classifier is down, but submissions can be held as unscannable in the guarded flow.

### Load Chrome extension (one-time setup)

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select `C:\Users\NC\Desktop\Startup Project\extension`.
5. Visit one of the supported sites, for example `https://chatgpt.com` or `https://claude.ai`.
6. Refresh that AI website tab after loading or reloading the extension.
7. Return to the dashboard. A page-visit event should appear after the extension reports it.

The extension uses `http://127.0.0.1:3000` as its API address. `127.0.0.1` always means “this same computer”. Installing the extension on a second laptop will make it look for an API on that second laptop, not the first. This version is therefore a one-computer local demo; shared multi-laptop mode requires a secured network deployment and extension configuration.

### Stop the application

In each PowerShell window, press **Ctrl+C**. Stop the API terminal and classifier terminal. Avoid force-killing random Node/Python processes; first identify that they belong to this project.

### Unix-like alternative

On macOS/Linux or a compatible Bash environment, from the project root:

```bash
./start.sh
```

This starts both services. Press **Ctrl+C** in that terminal to stop both child processes.

---

## 11. Troubleshooting

| Symptom | What to check |
|---|---|
| Dashboard says Disconnected | Confirm the Node API is running on port 3000 and open `http://127.0.0.1:3000/health` |
| Dashboard opens but scans wait/fail | Check classifier health at port 5001 and read `classifier-error.log` / `api-error.log` in the project folder |
| Extension popup says Not registered | Ensure API is running, then open/reload a supported AI site; the popup reflects cached token presence, not a full live health probe |
| No event appears | Confirm the exact site is in `extension/manifest.json`, reload the extension, refresh the AI site tab, and wait for the next dashboard poll |
| Approval is no longer available | The scan may have expired, been decided already, or API restarted; the employee flow times out by declining |
| Image/file stays on hold | It may be too large, encrypted, unsupported, OCR unavailable or only partly extracted; that is intentionally treated as unscannable/partial |
| Desktop notification absent | Click Enable desktop alerts, allow notifications for the dashboard origin, and check OS/browser notification settings |
| Port already in use | Another API/classifier process may be running. Check the project terminals before launching a duplicate; do not kill unrelated processes |
| Dashboard not reachable from second laptop | Expected in the local configuration: the server and extension use loopback and the API defaults to `127.0.0.1` |

---

## 12. Data files and safe operation

Persistent data is stored as JSON under `api/data/`:

- `events.json` — dashboard activity and decisions.
- `devices.json` — registered browser installations and token records.
- `aiTools.json` — seeded AI site domains.
- `incidents.json` — internal incident drafts.
- `declinedFingerprints.json` — exact-repeat fingerprints created as needed.

Do not delete, overwrite or share these files casually. Back them up before any maintenance. Avoid using real customer prompts in the demo: current prompt preview persistence needs a code-level fix and verification. The dashboard/report API has no user sign-in, so keep the services on the local machine and use synthetic demonstration data.

**Do not run `test/integration_test.sh` against the live project data.** The legacy test script begins by deleting JSON files in `api/data/`; it also contains old expected counts. It must be rewritten to use an isolated temporary data directory before use.

---

## 13. What a live dashboard does and does not prove

| If you see… | It tells you… | It does not tell you… |
|---|---|---|
| Page-visit event | Extension observed a supported AI page | Employee submitted a prompt or provider processed personal data |
| Category badge | A heuristic recognizer matched a pattern/context | The data category is certainly correct or a legal threshold is met |
| Allow / Decline outcome | Browser guard recorded that choice for this scan flow | Provider retention/deletion or downstream use |
| Destination: Not verified | SentryAI has no verified account-specific region evidence | Destination is a specific country |
| Internal incident draft | Someone captured a review record | A breach was confirmed or an authority was notified |
| Processing-register count | Matching stored event/category observations exist | Unique people, unique conversations, business purpose or complete processing inventory |
| Live status | API/dashboard requests succeeded | Classifier, extension, every site selector or all controls are healthy |

---

## 14. Source files that drive the dashboard

| File | Dashboard role |
|---|---|
| `dashboard/index.html` | All visible sections, fields, tables and buttons |
| `dashboard/app.js` | Five-second polling, cards/tables rendering, allow/decline calls, notifications, incident save and JSON exports |
| `dashboard/style.css` | Professional visual style, responsive grid and table/form layout |
| `api/src/server.js` | Dashboard API endpoints, event/approval/incident/register data and static asset server |
| `api/src/db.js` | JSON file persistence used by dashboard reports |
| `api/src/policyEngine.js` | Risk categories and decision logic that feed dashboard labels |
| `classification-service/app.py` and `recognizers.py` | Classification results shown as event categories |
| `extension/content.js` and `background.js` | Browser-side event detection, scan requests and approval replay/reporting |

---

## 15. Framework source links

- [DPDP Act, 2023 — India Code](https://www.indiacode.nic.in/bitstream/123456789/22037/2/a2023-22.pdf)
- [CERT-In Directions under Section 70B](https://www.cert-in.org.in/Directions70B.jsp)
- [RBI Storage of Payment System Data](https://rbi.org.in/Scripts/NotificationUser.aspx?Id=11244)
- [RBI Master Direction on Outsourcing of IT Services](https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=12486)
- [IRDAI Information and Cyber Security Guidelines, 2023](https://irdai.gov.in/document-detail?documentId=3314780)
- [SEBI CSCRF, 2024](https://www.sebi.gov.in/sebi_data/attachdocs/aug-2024/1724326790365.pdf)
- [MeitY / PIB India AI Governance Guidelines announcement](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2186639&lang=2&reg=48)

These links are references for discussion and should be rechecked for current amendments and customer applicability.

---

**Operator reminder:** Start classifier → start API → open dashboard → load/refresh the Chrome extension → use synthetic demo prompts → review dashboard. Stop both terminal processes with Ctrl+C when finished.
