from decimal import Decimal

from app.schemas.invoice import CanonicalInvoice
from app.schemas.validation import FieldConfidence, ValidationIssue


def _band(score: Decimal) -> str:
    return "high" if score >= Decimal("0.85") else "medium" if score >= Decimal("0.60") else "low"


def calculate(invoice: CanonicalInvoice, issues: list[ValidationIssue]) -> list[FieldConfidence]:
    readability = invoice.image_sharpness if invoice.image_sharpness is not None else Decimal("1.00")
    checks = {item.field_path for item in issues if item.severity in {"error", "critical"}}
    fields = [("invoice_number", invoice.invoice_number, "high"), ("supplier.gstin", invoice.supplier.gstin, "high"), ("totals.grand_total", str(invoice.totals.grand_total), "high")]
    result = []
    for path, value, clarity in fields:
        evidence = Decimal("1.00") if value else Decimal("0.00")
        model = {"high": Decimal("0.95"), "medium": Decimal("0.75"), "low": Decimal("0.45")}[clarity]
        rule_cap = Decimal("0.45") if path in checks else Decimal("1.00")
        score = min(readability, evidence, model, rule_cap)
        result.append(FieldConfidence(field_path=path, score=float(score), band=_band(score), signals={"readability": float(readability), "evidence": float(evidence), "model_clarity": float(model), "rule_cap": float(rule_cap)},))
    return result
