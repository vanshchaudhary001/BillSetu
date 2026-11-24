from datetime import date
from decimal import Decimal

from app.rules.constants import GST20_PRIMARY_RATES
from app.schemas.invoice import CanonicalInvoice
from app.schemas.validation import ValidationIssue
from app.validators.common import issue


def validate(invoice: CanonicalInvoice) -> list[ValidationIssue]:
    if not invoice.invoice_date or invoice.invoice_date < date(2025, 9, 22):
        return []
    results = []
    for index, line in enumerate(invoice.line_items):
        if line.gst_rate_pct in {Decimal("12"), Decimal("28")}:
            results.append(issue("R05", "advisory", f"line_items[{index}].gst_rate_pct", "Legacy GST rate found after 22 September 2025; confirm the HSN schedule.", "22 सितंबर 2025 के बाद पुरानी GST दर मिली; HSN अनुसूची की पुष्टि करें।", legal_ref="GST 2.0 rate transition"))
        elif line.gst_rate_pct not in GST20_PRIMARY_RATES:
            results.append(issue("R05", "warning", f"line_items[{index}].gst_rate_pct", "GST rate is outside the configured GST 2.0 primary slabs; confirm with a CA.", "GST दर कॉन्फ़िगर की गई GST 2.0 प्राथमिक दरों से बाहर है; CA से पुष्टि करें।"))
    return results
