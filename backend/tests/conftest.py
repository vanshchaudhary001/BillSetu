from datetime import date
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from app.api.dependencies import _auth_service
from app.core.config import settings
from app.schemas.invoice import CanonicalInvoice, InvoiceTotals, LineItem, Party
from app.validators.r01_gstin import _checksum

SIGN_IN_PASSWORD = "correct horse battery"


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


@pytest.fixture
def sign_in(monkeypatch, tmp_path):
    """Give a client a real authenticated session and an active business.

    Phase 8B-6 made every record endpoint business-scoped, so API-level tests
    need a session instead of relying on an anonymous business context. The auth
    database is isolated per test, so no account is written to the working tree.

    Returns a callable: `sign_in(client, email=...) -> business_id`.
    """
    monkeypatch.setattr(settings, "auth_database_path", str(tmp_path / "auth.sqlite3"))
    monkeypatch.setattr(settings, "auth_session_ttl_seconds", 3600)
    monkeypatch.setattr(settings, "auth_cookie_secure", False)
    _auth_service.cache_clear()

    def _sign_in(client: TestClient, email: str = "owner@example.com") -> str:
        registration = client.post(
            "/api/auth/register",
            json={"email": email, "password": SIGN_IN_PASSWORD},
        )
        assert registration.status_code == 201, registration.text
        business = client.get("/api/businesses/current")
        assert business.status_code == 200, business.text
        return business.json()["id"]

    yield _sign_in
    _auth_service.cache_clear()


def own_invoice(monkeypatch, extraction, invoice_id: str, invoice, business_id: str):
    """Inject an invoice and state its owner.

    Tests that put an invoice into the service directly bypass extraction, and
    extraction is what records ownership. The owning business has to be declared
    as well, or the business-scoped lookup treats the record as unowned.
    """
    monkeypatch.setitem(extraction.invoices, invoice_id, invoice)
    monkeypatch.setitem(extraction._invoice_business, invoice_id, business_id)
