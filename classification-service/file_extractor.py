"""
SentryAI Classification Service -- File text extraction
--------------------------------------------------------
Turns an uploaded file (text, docx/xlsx/pptx, pdf, image/screenshot,
small zip) into plain text so the same recognizers used for typed text
can inspect it.

Returns (text, status) where status is one of:
  "scanned"      -- everything we could see was inspected
  "partial"      -- some content could not be read (size cap, page cap,
                    nested archive, OCR unavailable for part of it)
  "unscannable"  -- we could not read the file at all (unknown binary,
                    OCR engine missing, encrypted, corrupt ...)

The file's bytes/text are never persisted or returned to the caller --
only the classification result leaves this module.
"""

import io
import os
import re
import shutil
import subprocess
import tempfile
import zipfile
from typing import Tuple

MAX_FILE_BYTES = 15 * 1024 * 1024
MAX_PDF_OCR_PAGES = 5
MAX_ZIP_MEMBERS = 25
MAX_ZIP_UNCOMPRESSED = 20 * 1024 * 1024   # zip-bomb guard

TEXT_EXTS = {
    "txt", "md", "csv", "tsv", "json", "jsonl", "xml", "html", "htm", "yaml", "yml",
    "log", "ini", "cfg", "conf", "env", "sql", "py", "js", "ts", "tsx", "jsx", "java",
    "c", "h", "cpp", "cs", "go", "rb", "php", "rs", "sh", "bat", "ps1", "kt", "swift",
    "rtf", "tex", "toml", "properties",
}
IMAGE_EXTS = {"png", "jpg", "jpeg", "gif", "bmp", "webp", "tif", "tiff"}


def _ext(name: str) -> str:
    return os.path.splitext(name or "")[1].lower().lstrip(".")


def _decode(data: bytes) -> str:
    for enc in ("utf-8", "utf-16"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1", errors="ignore")


def _strip_xml(xml: bytes) -> str:
    text = re.sub(rb"<[^>]+>", b" ", xml)
    return _decode(text)


def _ocr_image_bytes(data: bytes) -> Tuple[str, str]:
    try:
        from PIL import Image, ImageOps
        import pytesseract
    except ImportError:
        return "", "unscannable"
    if not shutil.which("tesseract"):
        return "", "unscannable"
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
        img = ImageOps.exif_transpose(img).convert("L")
        # Upscale small screenshots -- OCR accuracy on digits drops sharply
        # below roughly 30px glyph height.
        if max(img.size) < 1600:
            f = 1600 / max(img.size)
            img = img.resize((int(img.width * f), int(img.height * f)))
        img = ImageOps.autocontrast(img)
        return pytesseract.image_to_string(img), "scanned"
    except Exception:
        return "", "unscannable"


def _extract_pdf(data: bytes) -> Tuple[str, str]:
    with tempfile.TemporaryDirectory() as td:
        pdf_path = os.path.join(td, "in.pdf")
        with open(pdf_path, "wb") as fh:
            fh.write(data)
        text = ""
        if shutil.which("pdftotext"):
            r = subprocess.run(["pdftotext", "-q", pdf_path, "-"], capture_output=True, timeout=30)
            if r.returncode == 0:
                text = _decode(r.stdout)
        else:
            try:
                from pypdf import PdfReader
                reader = PdfReader(pdf_path)
                if reader.is_encrypted:
                    return "", "unscannable"
                text = "\n".join((p.extract_text() or "") for p in reader.pages)
            except Exception:
                return "", "unscannable"
        if len(text.strip()) >= 20:
            return text, "scanned"
        # Looks like a scanned PDF -> rasterise the first pages and OCR them.
        if shutil.which("pdftoppm"):
            subprocess.run(
                ["pdftoppm", "-r", "200", "-l", str(MAX_PDF_OCR_PAGES), "-png", pdf_path, os.path.join(td, "pg")],
                capture_output=True, timeout=60,
            )
            parts, ok = [], False
            for fn in sorted(os.listdir(td)):
                if fn.startswith("pg") and fn.endswith(".png"):
                    with open(os.path.join(td, fn), "rb") as fh:
                        t, st = _ocr_image_bytes(fh.read())
                    if st == "scanned":
                        ok = True
                        parts.append(t)
            if ok:
                return "\n".join(parts), "partial"   # page cap => partial
        return text, "unscannable" if not text.strip() else "partial"


def _extract_zip_like(data: bytes, kind: str) -> Tuple[str, str]:
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        return "", "unscannable"
    infos = zf.infolist()
    if sum(i.file_size for i in infos) > MAX_ZIP_UNCOMPRESSED:
        return "", "unscannable"
    parts, status = [], "scanned"
    if kind == "docx":
        wanted = [i for i in infos if i.filename.startswith("word/") and i.filename.endswith(".xml")]
    elif kind == "xlsx":
        wanted = [i for i in infos if i.filename.startswith("xl/") and i.filename.endswith(".xml")]
    elif kind == "pptx":
        wanted = [i for i in infos if i.filename.startswith("ppt/") and i.filename.endswith(".xml")]
    else:  # generic zip
        wanted = [i for i in infos if not i.is_dir()][:MAX_ZIP_MEMBERS]
        if len([i for i in infos if not i.is_dir()]) > MAX_ZIP_MEMBERS:
            status = "partial"
    for info in wanted:
        raw = zf.read(info)
        if kind == "zip":
            t, st = extract_text(info.filename, raw, _nested=True)
            parts.append(t)
            if st != "scanned":
                status = "partial"
        else:
            parts.append(_strip_xml(raw))
    if kind != "zip":
        # Images embedded in Office files (pasted screenshots etc.)
        for info in infos:
            if _ext(info.filename) in IMAGE_EXTS and "media/" in info.filename:
                t, st = _ocr_image_bytes(zf.read(info))
                parts.append(t)
                if st != "scanned":
                    status = "partial"
    return "\n".join(parts), status


def extract_text(name: str, data: bytes, _nested: bool = False) -> Tuple[str, str]:
    if len(data) > MAX_FILE_BYTES:
        return "", "unscannable"
    ext = _ext(name)
    try:
        if ext in TEXT_EXTS:
            return _decode(data), "scanned"
        if ext in IMAGE_EXTS:
            return _ocr_image_bytes(data)
        if ext == "pdf":
            return _extract_pdf(data)
        if ext in ("docx", "xlsx", "pptx"):
            return _extract_zip_like(data, ext)
        if ext == "zip":
            if _nested:
                return "", "partial"   # no zip-in-zip recursion
            return _extract_zip_like(data, "zip")
        # Unknown extension: if it decodes as mostly printable text, scan it.
        sample = data[:4096]
        if sample and b"\x00" not in sample:
            return _decode(data), "scanned"
    except Exception:
        return "", "unscannable"
    return "", "unscannable"
