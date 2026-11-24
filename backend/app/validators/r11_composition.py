from app.schemas.invoice import CanonicalInvoice
from app.schemas.validation import ValidationIssue
from app.validators.common import issue


def validate(invoice: CanonicalInvoice, business_scheme: str) -> list[ValidationIssue]:
    if business_scheme != "composition":
        return []
    total_tax = invoice.totals.cgst_total + invoice.totals.sgst_total + invoice.totals.igst_total
    inter_state = invoice.supplier.state_code and invoice.place_of_supply_state_code and invoice.supplier.state_code != invoice.place_of_supply_state_code
    if total_tax > 0 or inter_state:
        return [issue("R11", "critical", "invoice", "Composition taxpayers cannot charge GST or make this inter-state outward supply.", "Composition करदाता GST चार्ज नहीं कर सकते या यह इंटर-स्टेट आउटवर्ड सप्लाई नहीं कर सकते।")]
    return []
