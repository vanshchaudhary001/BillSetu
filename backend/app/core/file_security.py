import csv
import io
import re
from hashlib import sha256
from pathlib import PurePath
from uuid import uuid4

from fastapi import HTTPException, UploadFile

from app.core.config import settings

ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".pdf", ".csv", ".xlsx"}
ALLOWED_MIME_TYPES = {"image/jpeg", "image/png", "image/webp", "application/pdf", "text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}
PROMPT_INJECTION_PATTERNS = (r"ignore\s+(all\s+)?previous\s+instructions", r"system\s+message", r"reveal\s+secrets", r"call\s+the\s+tool", r"change\s+the\s+grand\s+total")


def extension_for(filename: str) -> str:
    extension = PurePath(filename or "").suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=415, detail="Unsupported document extension")
    return extension


def detect_type(data: bytes, extension: str) -> str:
    if data.startswith(b"%PDF-") and extension == ".pdf":
        return "application/pdf"
    if data.startswith(b"\xFF\xD8\xFF") and extension in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n") and extension == ".png":
        return "image/png"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP" and extension == ".webp":
        return "image/webp"
    if extension == ".xlsx" and data.startswith(b"PK\x03\x04") and b"[Content_Types].xml" in data[:20000]:
        return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    if extension == ".csv":
        try:
            text = data.decode("utf-8-sig")
            sample = text[:4096]
            if any(delimiter in sample for delimiter in (",", ";", "\t")):
                csv.Sniffer().sniff(sample)
                return "text/csv"
        except (UnicodeDecodeError, csv.Error):
            pass
    raise HTTPException(status_code=415, detail="File magic bytes do not match the declared document type")


def suspicious_text(text: str) -> bool:
    lowered = text.lower()
    return any(re.search(pattern, lowered) for pattern in PROMPT_INJECTION_PATTERNS)


async def read_and_validate(upload: UploadFile) -> tuple[bytes, str, str, str, list[str]]:
    extension = extension_for(upload.filename or "")
    data = await upload.read(settings.max_upload_bytes + 1)
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail="Document exceeds the 10 MB upload limit")
    detected_mime = detect_type(data, extension)
    if upload.content_type and upload.content_type not in {detected_mime, "application/octet-stream"}:
        raise HTTPException(status_code=415, detail="Declared MIME type does not match file contents")
    notes: list[str] = []
    if extension == ".csv":
        text = data.decode("utf-8-sig")
        if suspicious_text(text):
            notes.append("suspicious_instruction_text_detected")
    return data, detected_mime, extension, sha256(data).hexdigest(), notes


def server_filename(extension: str) -> str:
    return f"{uuid4().hex}{extension}"
