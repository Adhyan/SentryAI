#!/usr/bin/env bash
# SentryAI MVP — automated end-to-end integration test.
# Starts both services, exercises every API path, checks the policy
# engine's decisions, then tears everything down. Exits non-zero on
# any failed assertion so this is CI-friendly.
#
# Usage: ./test/integration_test.sh

set -uo pipefail
cd "$(dirname "$0")/.."

FAILURES=0
assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" == "$actual" ]; then
    echo "  PASS: $desc"
  else
    echo "  FAIL: $desc (expected [$expected], got [$actual])"
    FAILURES=$((FAILURES + 1))
  fi
}

# Fresh data dir so the test is repeatable.
rm -f api/data/*.json

(cd classification-service && python3 app.py) > /tmp/sentryai_test_flask.log 2>&1 &
FLASK_PID=$!
(cd api && node src/server.js) > /tmp/sentryai_test_api.log 2>&1 &
API_PID=$!

cleanup() {
  kill "$FLASK_PID" "$API_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

sleep 1.5

echo "== Health checks =="
assert_eq "classification service healthy" "200" "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5001/health)"
assert_eq "API healthy" "200" "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/health)"

echo "== Reference data =="
TOOL_COUNT=$(curl -s http://127.0.0.1:3000/v1/tools | python3 -c "import sys,json; print(len(json.load(sys.stdin)['tools']))")
assert_eq "6 AI tools seeded" "6" "$TOOL_COUNT"

echo "== Device registration =="
REG_RESP=$(curl -s -X POST http://127.0.0.1:3000/v1/auth/device -H "Content-Type: application/json" -d '{"userId":"test@sentryai.test"}')
TOKEN=$(echo "$REG_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['deviceToken'])")
assert_eq "device token issued" "36" "${#TOKEN}"  # UUID length

echo "== Auth enforcement =="
assert_eq "no token -> 401" "401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3000/v1/events -H 'Content-Type: application/json' -d '{"tool":"x","eventType":"page_visit"}')"
assert_eq "bad token -> 401" "401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3000/v1/events -H 'Authorization: Bearer nope' -H 'Content-Type: application/json' -d '{"tool":"x","eventType":"page_visit"}')"

echo "== Event pipeline: discovery event =="
DISC_RESP=$(curl -s -X POST http://127.0.0.1:3000/v1/events -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"tool":"claude.ai","eventType":"page_visit"}')
assert_eq "discovery decision = allow" "allow" "$(echo "$DISC_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['decision'])")"

echo "== Event pipeline: clean content =="
CLEAN_RESP=$(curl -s -X POST http://127.0.0.1:3000/v1/events -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"tool":"claude.ai","eventType":"content_submit","text":"Write a haiku about rain"}')
assert_eq "clean text decision = allow" "allow" "$(echo "$CLEAN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['decision'])")"

echo "== Event pipeline: sensitive content (Aadhaar) =="
SENSITIVE_RESP=$(curl -s -X POST http://127.0.0.1:3000/v1/events -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"tool":"chatgpt.com","eventType":"content_submit","text":"My Aadhaar is 2345 6789 8018"}')
assert_eq "Aadhaar text decision = alert" "alert" "$(echo "$SENSITIVE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['decision'])")"
assert_eq "Aadhaar category detected" "PII_AADHAAR" "$(echo "$SENSITIVE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['categories'][0])")"


echo "== Ask-before-send: /v1/scan (text) =="
scan_json() { python3 -c "import sys,json; d=json.load(sys.stdin); $1"; }
S1=$(curl -s -X POST http://127.0.0.1:3000/v1/scan -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"tool":"chatgpt.com","text":"My Aadhaar is 2345 6789 8018 please help"}')
assert_eq "sensitive text requires permission" "True" "$(echo "$S1" | scan_json "print(d['requiresPermission'])")"
assert_eq "masked version offered (re-scans clean)" "True" "$(echo "$S1" | scan_json "print(d['items'][0]['maskable'])")"
assert_eq "masked text has no raw Aadhaar" "0" "$(echo "$S1" | grep -c '2345 6789 8018')"
SID1=$(echo "$S1" | scan_json "print(d['scanId'])")
E1=$(curl -s -X POST http://127.0.0.1:3000/v1/events -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "{\"tool\":\"chatgpt.com\",\"eventType\":\"content_submit\",\"scanId\":\"$SID1\",\"userAction\":\"declined\"}")
assert_eq "declined -> decision blocked" "blocked" "$(echo "$E1" | scan_json "print(d['decision'])")"

S2=$(curl -s -X POST http://127.0.0.1:3000/v1/scan -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"tool":"claude.ai","text":"PAN ABCDE1234F"}')
SID2=$(echo "$S2" | scan_json "print(d['scanId'])")
E2=$(curl -s -X POST http://127.0.0.1:3000/v1/events -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "{\"tool\":\"claude.ai\",\"eventType\":\"content_submit\",\"scanId\":\"$SID2\",\"userAction\":\"redacted_sent\"}")
assert_eq "masked -> decision redacted" "redacted" "$(echo "$E2" | scan_json "print(d['decision'])")"

S3=$(curl -s -X POST http://127.0.0.1:3000/v1/scan -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"tool":"claude.ai","text":"Write a haiku about rain"}')
assert_eq "clean text needs no permission" "False" "$(echo "$S3" | scan_json "print(d['requiresPermission'])")"
SID3=$(echo "$S3" | scan_json "print(d['scanId'])")
S4=$(curl -s -X POST http://127.0.0.1:3000/v1/scan -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"tool":"claude.ai","text":"PAN ABCDE1234F"}')
SID4=$(echo "$S4" | scan_json "print(d['scanId'])")
assert_eq "sensitive content cannot be logged as clean" "400" "$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3000/v1/events -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"tool\":\"claude.ai\",\"eventType\":\"content_submit\",\"scanId\":\"$SID4\",\"userAction\":\"clean\"}")"
assert_eq "scanId is single-use" "410" "$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3000/v1/events -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"tool\":\"claude.ai\",\"eventType\":\"content_submit\",\"scanId\":\"$SID2\",\"userAction\":\"clean\"}")"

echo "== Ask-before-send: files, photos, screenshots =="
mkdir -p /tmp/sentry_files && python3 - <<'PY'
import base64, json, io, zipfile, subprocess
from PIL import Image, ImageDraw, ImageFont
d = "/tmp/sentry_files/"
open(d+"notes.txt","w").write("Customer PAN is ABCDE1234F and phone 9876543210")
open(d+"clean.txt","w").write("Meeting moved to Thursday, bring the slides.")
# screenshot-like PNG with an Aadhaar number drawn as text
img = Image.new("RGB", (900, 220), "white"); dr = ImageDraw.Draw(img)
try: f = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 46)
except Exception: f = ImageFont.load_default()
dr.text((30, 70), "Aadhaar: 2345 6789 8018", fill="black", font=f); img.save(d+"screenshot.png")
img2 = Image.new("RGB", (900, 220), "white"); dr = ImageDraw.Draw(img2)
dr.text((30, 70), "Team lunch on Friday", fill="black", font=f); img2.save(d+"clean.png")
# docx with a card-less but PAN-bearing line
import docx
doc = docx.Document(); doc.add_paragraph("Employee PAN: ABCDE1234F"); doc.save(d+"hr.docx")
open(d+"blob.bin","wb").write(bytes(range(256))*4)
def payload(name, mime="application/octet-stream"):
    b = open(d+name,"rb").read()
    return {"name":name,"mime":mime,"size":len(b),"dataBase64":base64.b64encode(b).decode()}
for n in ["notes.txt","clean.txt","screenshot.png","clean.png","hr.docx","blob.bin"]:
    json.dump({"tool":"chatgpt.com","files":[payload(n)]}, open(d+n+".json","w"))
PY
scan_file() { curl -s -X POST http://127.0.0.1:3000/v1/scan -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data-binary @/tmp/sentry_files/$1.json; }
assert_eq "txt with PAN+phone flagged" "True" "$(scan_file notes.txt | scan_json "print(d['requiresPermission'])")"
assert_eq "clean txt allowed through" "False" "$(scan_file clean.txt | scan_json "print(d['requiresPermission'])")"
assert_eq "screenshot (OCR) with Aadhaar flagged" "PII_AADHAAR" "$(scan_file screenshot.png | scan_json "print(d['items'][0]['categories'][0])")"
assert_eq "clean screenshot allowed through" "False" "$(scan_file clean.png | scan_json "print(d['requiresPermission'])")"
assert_eq "docx with PAN flagged" "PII_PAN" "$(scan_file hr.docx | scan_json "print(d['items'][0]['categories'][0])")"
assert_eq "unknown binary -> must ask (unscannable)" "unscannable" "$(scan_file blob.bin | scan_json "print(d['items'][0]['scanStatus'])")"
assert_eq "files are never maskable" "False" "$(scan_file screenshot.png | scan_json "print(d['items'][0]['maskable'])")"

SF=$(scan_file screenshot.png); SIDF=$(echo "$SF" | scan_json "print(d['scanId'])")
EF=$(curl -s -X POST http://127.0.0.1:3000/v1/events -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "{\"tool\":\"chatgpt.com\",\"eventType\":\"content_submit\",\"scanId\":\"$SIDF\",\"userAction\":\"declined\"}")
assert_eq "declined screenshot -> blocked" "blocked" "$(echo "$EF" | scan_json "print(d['decision'])")"
assert_eq "file event recorded as file_upload" "file_upload" "$(curl -s 'http://127.0.0.1:3000/v1/events?limit=1' | scan_json "print(d['events'][0]['eventType'])")"

echo "== Dashboard reflects events =="
EVENT_COUNT=$(curl -s "http://127.0.0.1:3000/v1/events?limit=100" | python3 -c "import sys,json; print(json.load(sys.stdin)['count'])")
assert_eq "events recorded (3 legacy + 2 text outcomes + 1 file outcome)" "6" "$EVENT_COUNT"

SUMMARY_ALERTS=$(curl -s http://127.0.0.1:3000/v1/summary | python3 -c "import sys,json; print(json.load(sys.stdin)['byDecision'].get('alert', 0))")
assert_eq "1 alert in summary (legacy flow)" "1" "$SUMMARY_ALERTS"
assert_eq "2 blocked in summary" "2" "$(curl -s http://127.0.0.1:3000/v1/summary | python3 -c "import sys,json; print(json.load(sys.stdin)['byDecision'].get('blocked', 0))")"

echo "== Static dashboard files =="
assert_eq "index.html served" "200" "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/)"
assert_eq "app.js served" "200" "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/app.js)"

echo "== Raw text is NOT stored (privacy check) =="
STORED_RAW=$(grep -c "2345 6789 8018" api/data/events.json || true)
assert_eq "raw Aadhaar number absent from events.json" "0" "$STORED_RAW"
assert_eq "raw PAN absent from events.json" "0" "$(grep -c ABCDE1234F api/data/events.json || true)"
assert_eq "no file content stored anywhere in api/data" "0" "$(grep -rl "Customer PAN is" api/data | wc -l)"

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "ALL TESTS PASSED"
  exit 0
else
  echo "$FAILURES TEST(S) FAILED"
  exit 1
fi
