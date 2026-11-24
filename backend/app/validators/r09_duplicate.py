from app.schemas.invoice import CanonicalInvoice
from app.schemas.validation import ValidationIssue
from app.validators.common import fingerprint, issue


def validate(invoice: CanonicalInvoice, existing_fingerprints: list[str]) -> list[ValidationIssue]:
    current = fingerprint(invoice)
    if current in existing_fingerprints:
        return [issue("R09", "error", "invoice_number", "This invoice matches an existing upload for the tenant.", "यह इनवॉइस टेनेंट के मौजूदा अपलोड से मेल खाता है।")]
    return []
