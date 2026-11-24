import re

from app.rules.constants import GST_STATE_CODES, OCR_CONFUSIONS
from app.schemas.invoice import CanonicalInvoice
from app.schemas.validation import ValidationIssue
from app.validators.common import issue

GSTIN_RE = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$")


def _mod36(value: str) -> int:
    return int(value) if value.isdigit() else ord(value) - ord("A") + 10


def _checksum(gstin14: str) -> str:
    total = 0
    for index, char in enumerate(gstin14):
        product = _mod36(char) * (2 if index % 2 == 0 else 1)
        total += product // 36 + product % 36
    value = (36 - total % 36) % 36
    return str(value) if value < 10 else chr(ord("A") + value - 10)


def _repair(value: str) -> str | None:
    for index, original in enumerate(value):
        replacement = OCR_CONFUSIONS.get(original)
        if not replacement:
            continue
        candidate = value[:index] + replacement + value[index + 1:]
        if len(candidate) == 15 and GSTIN_RE.fullmatch(candidate) and _checksum(candidate[:14]) == candidate[-1]:
            return candidate
    return None


def validate(invoice: CanonicalInvoice) -> list[ValidationIssue]:
    results: list[ValidationIssue] = []
    for path, gstin in (("supplier.gstin", invoice.supplier.gstin), ("buyer.gstin", invoice.buyer.gstin)):
        if not gstin:
            if path == "supplier.gstin":
                results.append(issue("R01", "error", path, "Supplier GSTIN is missing.", "आपूर्तिकर्ता का GSTIN नहीं है।"))
            continue
        normalized = gstin.strip().upper()
        valid = bool(GSTIN_RE.fullmatch(normalized)) and normalized[:2] in GST_STATE_CODES and _checksum(normalized[:14]) == normalized[-1]
        if not valid:
            repair = _repair(normalized)
            results.append(issue("R01", "error", path, "GSTIN format or checksum failed.", "GSTIN का प्रारूप या चेकसम सही नहीं है।", repair, "GSTIN Mod-36 checksum"))
    return results
