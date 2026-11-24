from app.schemas.invoice import CanonicalInvoice
from app.schemas.validation import ValidationIssue
from app.validators.common import issue


def validate(invoice: CanonicalInvoice, annual_turnover: str) -> list[ValidationIssue]:
    required = 6 if float(annual_turnover) > 50000000 else 4
    b2b = bool(invoice.buyer.gstin)
    results = []
    for index, line in enumerate(invoice.line_items):
        digits = line.hsn_sac or ""
        if b2b and len(digits) < required:
            results.append(issue("R08", "error", f"line_items[{index}].hsn_sac", f"B2B HSN/SAC must contain at least {required} digits.", f"B2B HSN/SAC में कम से कम {required} अंक होने चाहिए।"))
        elif not b2b and not digits:
            results.append(issue("R08", "advisory", f"line_items[{index}].hsn_sac", "HSN/SAC is missing; include it in the Table 12 summary where applicable.", "HSN/SAC नहीं है; जहां लागू हो Table 12 सारांश में जोड़ें।"))
    return results
