import re

from app.schemas.invoice import CanonicalInvoice
from app.schemas.validation import ValidationIssue
from app.validators.common import issue


def validate(invoice: CanonicalInvoice) -> list[ValidationIssue]:
    if not invoice.invoice_number or len(invoice.invoice_number) > 16 or not re.fullmatch(r"[A-Za-z0-9/-]+", invoice.invoice_number):
        return [issue("R06", "error", "invoice_number", "Invoice serial must be non-empty, alphanumeric, and no longer than 16 characters.", "इनवॉइस सीरियल खाली नहीं होना चाहिए, केवल अक्षर/अंक हो और 16 वर्ण से अधिक न हो।", legal_ref="CGST Rule 46(b)")]
    return []
