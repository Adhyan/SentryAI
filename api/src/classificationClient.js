"use strict";

const http = require("http");

const CLASSIFY_HOST = process.env.CLASSIFY_HOST || "127.0.0.1";
const CLASSIFY_PORT = process.env.CLASSIFY_PORT || 5001;
const CLASSIFY_TIMEOUT_MS = 3000;
const FILE_TIMEOUT_MS = 45000; // OCR / PDF extraction can take a few seconds

/**
 * Calls the Python classification microservice. On any failure (service
 * down, timeout, bad response) this fails *open* to an empty
 * classification rather than throwing — an ingestion pipeline should
 * never drop an employee's event just because the classifier hiccuped;
 * it should log the event as "unclassified" and keep going. Production
 * hardening note: add a retry-with-backoff and a dead-letter queue
 * before this is customer-facing.
 */
function classify(text, context) {
  return post("/classify", { text, context }, CLASSIFY_TIMEOUT_MS);
}

/** Classify an uploaded file (base64) -- images are OCR'd, docs/PDFs extracted. */
function classifyFile(file, context) {
  return post(
    "/classify-file",
    { name: file.name, dataBase64: file.dataBase64, context },
    FILE_TIMEOUT_MS,
    { scan_status: "unscannable" }
  );
}

function post(path, payload, timeoutMs, emptyExtra) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        host: CLASSIFY_HOST,
        port: CLASSIFY_PORT,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            console.error(`[classify] non-200 response: ${res.statusCode} ${raw}`);
            return resolve(emptyResult("classification_service_error", emptyExtra));
          }
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            console.error("[classify] failed to parse response", err.message);
            resolve(emptyResult("classification_service_bad_response", emptyExtra));
          }
        });
      }
    );

    req.on("timeout", () => {
      req.destroy();
      console.error("[classify] request timed out");
      resolve(emptyResult("classification_service_timeout", emptyExtra));
    });

    req.on("error", (err) => {
      console.error("[classify] request error", err.message);
      resolve(emptyResult("classification_service_unreachable", emptyExtra));
    });

    req.write(body);
    req.end();
  });
}

function emptyResult(errorTag, extra) {
  return {
    ...(extra || {}),
    categories: [],
    confidence: {},
    redacted_text: null,
    highest_risk_category: null,
    _error: errorTag,
  };
}

module.exports = { classify, classifyFile };
