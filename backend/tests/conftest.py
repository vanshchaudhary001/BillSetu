from datetime import date
from decimal import Decimal

import pytest

from app.schemas.invoice import CanonicalInvoice, InvoiceTotals, LineItem, Party
from app.validators.r01_gstin import _checksum


def valid_gstin(prefix: str = "09ABCDE1234F1Z") -> str:
    return prefix + _checksum(prefix)


@pytest.fixture
def clean_invoice() -> CanonicalInvoice:
    return CanonicalInvoice(
        invoice_number="SH/26-27/0041", invoice_date=date(2026, 10, 14),
        supplier=Party(name="Sharma Electricals", gstin=valid_gstin(), state_code="09"),
        buyer=Party(name="Verma Builders", gstin=valid_gstin("09XYZAB5678K1Z"), state_code="09", address_present=True),
        place_of_supply_state_code="09",
        line_items=[LineItem(description="LED Flood Light", hsn_sac="8539", quantity=Decimal("100"), unit_rate=Decimal("450"), taxable_value=Decimal("45000"), gst_rate_pct=Decimal("18"), cgst_amount=Decimal("4050"), sgst_amount=Decimal("4050"))],
        totals=InvoiceTotals(taxable_value=Decimal("45000"), cgst_total=Decimal("4050"), sgst_total=Decimal("4050"), grand_total=Decimal("53100")),
    )
