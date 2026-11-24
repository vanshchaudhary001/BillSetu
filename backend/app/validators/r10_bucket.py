from decimal import Decimal

from app.schemas.invoice import CanonicalInvoice


def classify(invoice: CanonicalInvoice) -> str:
    if invoice.buyer.gstin:
        return "b2b"
    if invoice.supplier.state_code and invoice.place_of_supply_state_code and invoice.supplier.state_code != invoice.place_of_supply_state_code and invoice.totals.grand_total > Decimal("100000"):
        return "b2cl"
    return "b2cs"
