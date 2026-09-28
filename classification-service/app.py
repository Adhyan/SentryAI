"""
SentryAI Classification Service
--------------------------------
A standalone Python microservice that classifies text submitted to AI
tools for PII / financial data / source code, and returns a redacted
version plus per-category confidence scores.

Run:
    pip install flask
    python3 app.py
    # Listens on http://127.0.0.1:5001

Endpoint:
    POST /classify
    Request  body: {"text": "...", "context": "chatgpt.com"}
    Response body: {
        "categories": ["PII_AADHAAR", "FINANCIAL_DATA"],
        "confidence": {"PII_AADHAAR": 0.97, "FINANCIAL_DATA": 0.75},
        "redacted_text": "My Aadhaar is [REDACTED:PII_AADHAAR]...",
        "highest_risk_category": "PII_AADHAAR"
    }
"""

import logging
from flask import Flask, request, jsonify

import base64

from recognizers import analyze, redact
from file_extractor import extract_text, MAX_FILE_BYTES

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 30 * 1024 * 1024
logging.basicConfig(level=logging.INFO, format="%(asctime)s classify %(message)s")
log = logging.getLogger("sentryai.classify")

# Risk ranking used to pick a single "highest_risk_category" for simple
# policy rules that only need one signal (e.g. "block if PII_AADHAAR").
RISK_ORDER = [
    "SECRET_CREDENTIAL",
    "CHILD_DATA",
    "BIOMETRIC_DATA",
    "HEALTH_DATA",
    "PII_AADHAAR",
    "PII_ID_DOCUMENT",
    "FINANCIAL_CARD",
    "PII_PAN",
    "FINANCIAL_IFSC",
    "PII_PHONE",
    "PII_EMAIL",
    "DATABASE_EXPORT",
    "CUSTOMER_DATA",
    "EMPLOYEE_DATA",
    "COMPANY_CONFIDENTIAL",
    "FINANCIAL_DATA",
    "SOURCE_CODE",
]


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "service": "sentryai-classification"}), 200


@app.route("/classify", methods=["POST"])
def classify():
    payload = request.get_json(silent=True) or {}
    text = payload.get("text", "")
    context = payload.get("context", "unknown")

    if not isinstance(text, str):
        return jsonify({"error": "`text` must be a string"}), 400
    matches = analyze(text)

    categories = sorted({m.category for m in matches})
    confidence = {}
    for m in matches:
        # Keep the highest confidence seen per category if it appears
        # more than once (e.g. two Aadhaar-looking numbers in one blob).
        confidence[m.category] = max(confidence.get(m.category, 0), m.confidence)

    highest_risk = next((c for c in RISK_ORDER if c in categories), None)

    redacted_text = redact(text, matches)

    log.info(
        "context=%s text_len=%d categories=%s",
        context,
        len(text),
        categories,
    )

    return jsonify(
        {
            "categories": categories,
            "confidence": confidence,
            "redacted_text": redacted_text,
            "highest_risk_category": highest_risk,
        }
    )


@app.route("/classify-file", methods=["POST"])
def classify_file():
    """Classify an uploaded file (photo, screenshot, pdf, docx, ...).

    Request : {"name": "id.png", "dataBase64": "...", "context": "chatgpt.com"}
    Response: {categories, confidence, highest_risk_category, scan_status}
    The file's content and extracted text are NOT returned or stored.
    """
    payload = request.get_json(silent=True) or {}
    name = payload.get("name") or "unnamed"
    b64 = payload.get("dataBase64")
    context = payload.get("context", "unknown")
    if not isinstance(b64, str):
        return jsonify({"error": "`dataBase64` must be a string"}), 400
    try:
        data = base64.b64decode(b64, validate=False)
    except Exception:
        return jsonify({"error": "invalid base64"}), 400
    if len(data) > MAX_FILE_BYTES:
        return jsonify({"categories": [], "confidence": {}, "highest_risk_category": None,
                        "scan_status": "unscannable", "reason": "file_too_large"})

    text, status = extract_text(name, data)
    matches = analyze(text) if text else []
    categories = sorted({m.category for m in matches})
    confidence = {}
    for m in matches:
        confidence[m.category] = max(confidence.get(m.category, 0), m.confidence)
    highest_risk = next((c for c in RISK_ORDER if c in categories), None)
    log.info("context=%s file=%s bytes=%d status=%s categories=%s",
             context, name, len(data), status, categories)
    return jsonify({"categories": categories, "confidence": confidence,
                    "highest_risk_category": highest_risk, "scan_status": status})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5001, debug=False, threaded=True)
