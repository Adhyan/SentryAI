"""
SentryAI Classification Service — Recognizers
------------------------------------------------
Lightweight, dependency-free (regex + heuristic) recognizers for the MVP.

Production note: this module intentionally avoids heavy ML dependencies
(spaCy / Microsoft Presidio) so the MVP can run anywhere without a
model-download step. The recognizer interface below (`detect(text) ->
list[Match]`) is designed so that swapping in Presidio's
`AnalyzerEngine` later is a drop-in replacement — see the "Production
upgrade path" note at the bottom of this file.
"""

import json
import os
import re
from dataclasses import dataclass, field
from typing import List


@dataclass
class Match:
    category: str
    start: int
    end: int
    matched_text: str
    confidence: float


# ---------------------------------------------------------------------------
# Aadhaar number: 12 digits, commonly formatted as "XXXX XXXX XXXX" or
# "XXXX-XXXX-XXXX" or as one continuous string. We require a 12-digit
# sequence (with optional space/hyphen separators every 4 digits) and
# apply the Verhoeff checksum used by UIDAI to cut down false positives
# from random 12-digit numbers (e.g. long invoice/order IDs).
# ---------------------------------------------------------------------------

_VERHOEFF_D = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
    [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
    [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
]
_VERHOEFF_P = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
]


def _verhoeff_checksum_valid(number: str) -> bool:
    """Validate a numeric string against the Verhoeff checksum (used by Aadhaar)."""
    c = 0
    for i, item in enumerate(reversed(number)):
        c = _VERHOEFF_D[c][_VERHOEFF_P[i % 8][int(item)]]
    return c == 0


_AADHAAR_RE = re.compile(r"\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b")


def detect_aadhaar(text: str) -> List[Match]:
    matches = []
    for m in _AADHAAR_RE.finditer(text):
        digits = re.sub(r"[\s-]", "", m.group())
        if len(digits) != 12:
            continue
        # Aadhaar numbers never start with 0 or 1.
        if digits[0] in ("0", "1"):
            continue
        confidence = 0.55  # format-only match
        if _verhoeff_checksum_valid(digits):
            confidence = 0.97
        matches.append(Match("PII_AADHAAR", m.start(), m.end(), m.group(), confidence))
    return matches


# ---------------------------------------------------------------------------
# PAN (Permanent Account Number): 5 letters, 4 digits, 1 letter.
# The 4th letter encodes holder type (P=individual, C=company, etc.) —
# we don't validate that here, format match is sufficient for MVP.
# ---------------------------------------------------------------------------
_PAN_RE = re.compile(r"\b[A-Z]{5}[0-9]{4}[A-Z]\b")


def detect_pan(text: str) -> List[Match]:
    return [
        Match("PII_PAN", m.start(), m.end(), m.group(), 0.9)
        for m in _PAN_RE.finditer(text)
    ]


# Operational risk signals requested for enterprise governance. These are
# classifier labels, not statutory DPDP "sensitive personal data" categories.
_HEALTH_CONTEXT_RE = re.compile(r"\b(?:diagnos(?:is|ed)|patient|medical|health|prescription|treatment|hospital|blood group|HIV|AIDS|disability)\b", re.I)
_HEALTH_VALUE_RE = re.compile(r"\b(?:diabetes|asthma|cancer|hypertension|pregnan(?:t|cy)|depression|anxiety|cholesterol|TB|tuberculosis)\b", re.I)
_BIOMETRIC_RE = re.compile(r"\b(?:fingerprint|face(?:print| scan| recognition)?|iris scan|retina scan|voiceprint|biometric(?:s| data)?)\b", re.I)
_CHILD_CONTEXT_RE = re.compile(r"\b(?:child|children|minor|under[- ]?18|school student|student record|my son|my daughter|minor student)\b", re.I)


def detect_operational_risk_categories(text: str) -> List[Match]:
    matches = []
    if _HEALTH_CONTEXT_RE.search(text) or _HEALTH_VALUE_RE.search(text):
        for pattern in (_HEALTH_CONTEXT_RE, _HEALTH_VALUE_RE):
            matches.extend(Match("HEALTH_DATA", m.start(), m.end(), m.group(), 0.72) for m in pattern.finditer(text))
    matches.extend(Match("BIOMETRIC_DATA", m.start(), m.end(), m.group(), 0.82) for m in _BIOMETRIC_RE.finditer(text))
    matches.extend(Match("CHILD_DATA", m.start(), m.end(), m.group(), 0.62) for m in _CHILD_CONTEXT_RE.finditer(text))
    return matches


# ---------------------------------------------------------------------------
# Indian mobile numbers: optional +91 / 0 prefix, then a 10-digit number
# starting with 6-9.
# ---------------------------------------------------------------------------
_PHONE_RE = re.compile(r"\b(?:\+91[-\s]?|0)?[6-9]\d{9}\b")


def detect_phone(text: str) -> List[Match]:
    return [
        Match("PII_PHONE", m.start(), m.end(), m.group(), 0.75)
        for m in _PHONE_RE.finditer(text)
    ]


# ---------------------------------------------------------------------------
# Email addresses — standard RFC-5322-ish pattern, good enough for MVP.
# ---------------------------------------------------------------------------
_EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")


def detect_email(text: str) -> List[Match]:
    return [
        Match("PII_EMAIL", m.start(), m.end(), m.group(), 0.9)
        for m in _EMAIL_RE.finditer(text)
    ]


# ---------------------------------------------------------------------------
# IFSC code (bank branch identifier): 4 letters + 0 + 6 alphanumeric.
# ---------------------------------------------------------------------------
_IFSC_RE = re.compile(r"\b[A-Z]{4}0[A-Z0-9]{6}\b")


def detect_ifsc(text: str) -> List[Match]:
    return [
        Match("FINANCIAL_IFSC", m.start(), m.end(), m.group(), 0.85)
        for m in _IFSC_RE.finditer(text)
    ]


# ---------------------------------------------------------------------------
# Card numbers (basic Luhn-checked 13-19 digit sequences).
# ---------------------------------------------------------------------------
_CARD_RE = re.compile(r"\b(?:\d[ -]?){13,19}\b")


def _luhn_valid(number: str) -> bool:
    digits = [int(d) for d in number]
    checksum = 0
    parity = len(digits) % 2
    for i, d in enumerate(digits):
        if i % 2 == parity:
            d *= 2
            if d > 9:
                d -= 9
        checksum += d
    return checksum % 10 == 0


def detect_card(text: str) -> List[Match]:
    matches = []
    for m in _CARD_RE.finditer(text):
        digits = re.sub(r"[ -]", "", m.group())
        if 13 <= len(digits) <= 19 and _luhn_valid(digits):
            matches.append(Match("FINANCIAL_CARD", m.start(), m.end(), m.group(), 0.9))
    return matches


# ---------------------------------------------------------------------------
# Source code heuristic — not a true classifier, just a density check on
# common programming tokens. Good enough to flag "someone pasted a code
# block" for MVP; a proper language-aware classifier is a v2 upgrade.
# ---------------------------------------------------------------------------
_CODE_TOKENS = re.compile(
    r"\b(function|def|class|import|require|const|let|var|return|if|else|for|while|"
    r"public|private|static|void|SELECT|INSERT|UPDATE|DELETE FROM)\b"
)
_CODE_SYMBOLS = re.compile(r"[{};()=<>]")


def detect_source_code(text: str) -> List[Match]:
    if not text or len(text) < 20:
        return []
    token_hits = len(_CODE_TOKENS.findall(text))
    symbol_hits = len(_CODE_SYMBOLS.findall(text))
    density = (token_hits * 3 + symbol_hits) / max(len(text.split()), 1)
    if token_hits >= 2 and density > 0.3:
        confidence = min(0.5 + density / 4, 0.95)
        return [Match("SOURCE_CODE", 0, len(text), "(code block)", round(confidence, 2))]
    return []


# ---------------------------------------------------------------------------
# Financial-data heuristic — currency symbol/number proximity + common
# finance/contract terminology. For MVP; upgrade path is a fine-tuned
# transformer classifier once real customer data is available.
# ---------------------------------------------------------------------------
_CURRENCY_RE = re.compile(r"(?:\u20b9|Rs\.?|INR)\s?[\d,]+(?:\.\d+)?")
_FIN_TERMS_RE = re.compile(
    r"\b(invoice|salary|payroll|bank account|balance sheet|revenue|contract value|"
    r"purchase order|GST|IFSC|account number)\b",
    re.IGNORECASE,
)


def detect_financial_data(text: str) -> List[Match]:
    currency_hits = _CURRENCY_RE.findall(text)
    term_hits = _FIN_TERMS_RE.findall(text)
    if currency_hits and term_hits:
        return [Match("FINANCIAL_DATA", 0, len(text), "(financial context)", 0.75)]
    if len(term_hits) >= 2:
        return [Match("FINANCIAL_DATA", 0, len(text), "(financial context)", 0.55)]
    return []


# ---------------------------------------------------------------------------
# Customer, employee and company-confidential data. These rules deliberately
# require business context instead of flagging ordinary words such as
# "customer" or "pricing" by themselves. They cover CRM exports, account
# lists, HR material and internal commercial documents even when no single
# PII number is present.
# ---------------------------------------------------------------------------
_CUSTOMER_CONTEXT_RE = re.compile(
    r"\b(?:customer|client|buyer|prospect|lead|account|subscriber|patient|member)\b",
    re.IGNORECASE,
)
_CUSTOMER_RECORD_RE = re.compile(
    r"\b(?:customer|client|account|order|ticket|case|subscription|contract)\s*(?:id|no\.?|number|name|email|phone|address|status|history)\b",
    re.IGNORECASE,
)
_CUSTOMER_FIELDS_RE = re.compile(
    r"\b(?:customer[_ -]?id|client[_ -]?id|account[_ -]?id|order[_ -]?id|crm[_ -]?(?:id|export)|billing[_ -]?address|shipping[_ -]?address)\b",
    re.IGNORECASE,
)
_EMPLOYEE_RE = re.compile(
    r"\b(?:employee|staff|personnel|hr|human resources)\b.{0,120}\b(?:salary|payroll|compensation|performance|appraisal|disciplinary|medical|bank account|joining|resume|cv)\b|"
    r"\b(?:salary|payroll|compensation|performance|appraisal|disciplinary)\b.{0,120}\b(?:employee|staff|personnel|hr)\b",
    re.IGNORECASE | re.DOTALL,
)
_CONFIDENTIAL_RE = re.compile(
    r"\b(?:confidential|internal use only|proprietary|nda|non[- ]disclosure|trade secret)\b|"
    r"\b(?:sales pipeline|business strategy|product roadmap|go[- ]to[- ]market|profit margin|pricing strategy|customer list|vendor agreement|board minutes|security architecture)\b",
    re.IGNORECASE,
)
_DATABASE_EXPORT_RE = re.compile(
    r"\b(?:customer[_ -]?id|client[_ -]?id|email|phone|account[_ -]?number|address)\b\s*[,|;\t]\s*"
    r"\b(?:customer[_ -]?id|client[_ -]?id|email|phone|account[_ -]?number|address)\b",
    re.IGNORECASE,
)


def detect_customer_data(text: str) -> List[Match]:
    if _CUSTOMER_RECORD_RE.search(text) or _CUSTOMER_FIELDS_RE.search(text):
        return [Match("CUSTOMER_DATA", 0, len(text), "(customer record)", 0.8)]
    # A customer/client reference plus an independently detected email,
    # phone or financial identifier is a customer-data disclosure.
    if _CUSTOMER_CONTEXT_RE.search(text) and (detect_email(text) or detect_phone(text) or detect_financial_data(text)):
        return [Match("CUSTOMER_DATA", 0, len(text), "(customer data)", 0.75)]
    return []


def detect_employee_data(text: str) -> List[Match]:
    if _EMPLOYEE_RE.search(text):
        return [Match("EMPLOYEE_DATA", 0, len(text), "(employee record)", 0.8)]
    return []


def detect_company_confidential(text: str) -> List[Match]:
    if _CONFIDENTIAL_RE.search(text):
        return [Match("COMPANY_CONFIDENTIAL", 0, len(text), "(confidential company material)", 0.8)]
    return []


def detect_database_export(text: str) -> List[Match]:
    if _DATABASE_EXPORT_RE.search(text):
        return [Match("DATABASE_EXPORT", 0, len(text), "(database export)", 0.85)]
    return []


def _custom_terms() -> dict:
    """Load organisation-specific keywords without storing any scanned data."""
    path = os.path.join(os.path.dirname(__file__), "sensitive_terms.json")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def detect_custom_company_terms(text: str) -> List[Match]:
    terms = _custom_terms()
    matches = []
    for category, key in (("COMPANY_CONFIDENTIAL", "companyKeywords"), ("CUSTOMER_DATA", "customerKeywords")):
        for term in terms.get(key, []):
            if not isinstance(term, str) or not term.strip():
                continue
            found = re.search(re.escape(term.strip()), text, re.IGNORECASE)
            if found:
                matches.append(Match(category, found.start(), found.end(), found.group(), 0.9))
    return matches



# ---------------------------------------------------------------------------
# ID-document keywords. Photos / scans of an Aadhaar card, PAN card,
# passport or licence often OCR badly (digits get misread and the
# Verhoeff / format checks fail), but the printed headings survive.
# Two or more distinct heading hits => treat as an ID document.
# ---------------------------------------------------------------------------
_ID_DOC_TERMS = [
    r"unique identification authority", r"government of india", r"\baadhaar\b",
    r"\bआधार\b", r"income tax department", r"permanent account number",
    r"\bpassport\b", r"republic of india", r"driving licen[cs]e",
    r"election commission of india", r"\bvoter id\b", r"\bVID\s*:",
]
_ID_DOC_RES = [re.compile(t, re.IGNORECASE) for t in _ID_DOC_TERMS]


def detect_id_document(text: str) -> List[Match]:
    hits = sum(1 for r in _ID_DOC_RES if r.search(text))
    if hits >= 2:
        return [Match("PII_ID_DOCUMENT", 0, len(text), "(id document)", 0.8)]
    return []


# ---------------------------------------------------------------------------
# Secrets / credentials: private key blocks, common API-key formats and
# "password = ..." style assignments.
# ---------------------------------------------------------------------------
_SECRET_RES = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),                       # AWS access key id
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),                   # OpenAI-style secret key
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b"),              # GitHub tokens
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),            # Slack tokens
    re.compile(r"(?i)\b(?:password|passwd|pwd|secret|api[_-]?key|token)\b\s*[:=]\s*[\"']?[^\s\"']{6,}"),
]


def detect_secrets(text: str) -> List[Match]:
    out = []
    for rx in _SECRET_RES:
        for m in rx.finditer(text):
            out.append(Match("SECRET_CREDENTIAL", m.start(), m.end(), m.group(), 0.9))
    return out

# ---------------------------------------------------------------------------
# Registry of all recognizers — the classification service iterates this
# list. Add new recognizers here (and nowhere else) to extend coverage.
# ---------------------------------------------------------------------------
ALL_RECOGNIZERS = [
    detect_aadhaar,
    detect_pan,
    detect_phone,
    detect_email,
    detect_ifsc,
    detect_card,
    detect_source_code,
    detect_financial_data,
    detect_customer_data,
    detect_employee_data,
    detect_company_confidential,
    detect_database_export,
    detect_custom_company_terms,
    detect_id_document,
    detect_secrets,
    detect_operational_risk_categories,
]


CHUNK_SIZE = 50_000   # keeps regex runtime bounded per pass
CHUNK_OVERLAP = 200   # so a value straddling a chunk edge is still found


def analyze(text: str) -> List[Match]:
    """Run every recognizer against the text and return all matches.

    Long inputs are scanned in overlapping chunks instead of being
    truncated -- truncating would let sensitive data hidden after the
    first 50k characters slip through unscanned.
    """
    results: List[Match] = []
    seen = set()
    pos = 0
    n = len(text)
    while True:
        chunk = text[pos:pos + CHUNK_SIZE]
        for recognizer in ALL_RECOGNIZERS:
            for m in recognizer(chunk):
                key = (m.category, m.start + pos, m.end + pos)
                if key in seen:
                    continue
                seen.add(key)
                m.start += pos
                m.end += pos
                results.append(m)
        if pos + CHUNK_SIZE >= n:
            break
        pos += CHUNK_SIZE - CHUNK_OVERLAP
    return results


def redact(text: str, matches: List[Match]) -> str:
    """Replace each matched span with a [REDACTED:<CATEGORY>] placeholder.

    Whole-text heuristic matches (source code / financial context, which
    span the entire input) are left as-is here — redacting an entire
    message isn't useful; the category flag itself drives policy
    decisions for those.
    """
    # Whole-text heuristic matches are marked with a parenthesized synthetic
    # label by their recognizer. Keep real matches even when the sensitive
    # value is the entire input (for example, a message containing only an
    # email address or PAN).
    span_matches = [m for m in matches if not m.matched_text.startswith("(")]
    if not span_matches:
        return text
    # Drop overlapping spans (keep the earliest / longest) so two
    # recognizers hitting the same characters can't garble the output.
    span_matches.sort(key=lambda m: (m.start, -(m.end - m.start)))
    kept, last_end = [], -1
    for m in span_matches:
        if m.start >= last_end:
            kept.append(m)
            last_end = m.end
    span_matches = kept
    # Redact from the end so earlier offsets stay valid.
    span_matches.sort(key=lambda m: m.start, reverse=True)
    redacted = text
    for m in span_matches:
        redacted = redacted[: m.start] + f"[REDACTED:{m.category}]" + redacted[m.end :]
    return redacted


# ---------------------------------------------------------------------------
# Production upgrade path:
#   from presidio_analyzer import AnalyzerEngine
#   engine = AnalyzerEngine()
#   results = engine.analyze(text=text, language="en")
# Wrap Presidio's RecognizerResult objects into this module's `Match`
# dataclass (same fields: category/start/end/confidence) and the rest of
# app.py (scoring, redaction, API contract) needs no changes.
# ---------------------------------------------------------------------------
