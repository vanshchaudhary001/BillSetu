from decimal import Decimal, ROUND_HALF_UP
from hashlib import sha256
from typing import Iterable

from app.schemas.invoice import CanonicalInvoice
from app.schemas.validation import ValidationIssue

MONEY_TOLERANCE = Decimal("1.00")


def issue(rule_id: str, severity: str, field_path: str, en: str, hi: str, suggested: str | None = None, legal_ref: str | None = None) -> ValidationIssue:
    return ValidationIssue(rule_id=rule_id, severity=severity, field_path=field_path, message_en=en, message_hi=hi, suggested_value=suggested, legal_ref=legal_ref)


def money(value: Decimal | str | int | float) -> Decimal:
    return Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def fingerprint(invoice: CanonicalInvoice, tenant_id: str = "local") -> str:
    supplier = (invoice.supplier.gstin or invoice.supplier.name or "").strip().upper()
    basis = "|".join([tenant_id, supplier, invoice.invoice_number.strip().upper(), str(invoice.invoice_date or "")])
    return sha256(basis.encode("utf-8")).hexdigest()


def all_issues(results: Iterable[list[ValidationIssue]]) -> list[ValidationIssue]:
    return [item for result in results for item in result]
