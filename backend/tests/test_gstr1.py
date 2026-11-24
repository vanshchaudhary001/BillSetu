from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from app.api.routes.documents import extraction
from app.main import app
from app.services.gstr1_service import GSTR1Service


def build(clean_invoice):
    return GSTR1Service().build_record(clean_invoice)


def test_b2b_when_buyer_gstin_is_present(clean_invoice):
    assert clean_invoice.buyer.gstin

    record = build(clean_invoice)

    assert record.invoice_type == "B2B"
    assert record.buyer_gstin == clean_invoice.buyer.gstin


def test_b2cl_follows_existing_r10_classification(clean_invoice):
    clean_invoice.buyer.gstin = None
    clean_invoice.supplier.state_code = "07"
    clean_invoice.place_of_supply_state_code = "09"
    clean_invoice.totals.grand_total = Decimal("100001")

    record = build(clean_invoice)

    assert record.invoice_type == "B2CL"
    assert record.buyer_gstin is None


def test_b2cs_follows_existing_r10_classification(clean_invoice):
    clean_invoice.buyer.gstin = None
    clean_invoice.supplier.state_code = "07"
    clean_invoice.place_of_supply_state_code = "09"
    clean_invoice.totals.grand_total = Decimal("100000")

    record = build(clean_invoice)

    assert record.invoice_type == "B2CS"
    assert record.buyer_gstin is None


def test_line_items_are_preserved_verbatim(clean_invoice):
    source = clean_invoice.line_items[0]
    source.cess_amount = Decimal("12.34")

    record = build(clean_invoice)

    assert len(record.line_items) == 1
    line = record.line_items[0]
    assert line.description == source.description
    assert line.hsn_sac == source.hsn_sac
    assert line.quantity == source.quantity
    assert line.taxable_value == source.taxable_value
    assert line.gst_rate_pct == source.gst_rate_pct
    assert line.cgst_amount == source.cgst_amount
    assert line.sgst_amount == source.sgst_amount
    assert line.igst_amount == source.igst_amount
    assert line.cess_amount == Decimal("12.34")


def test_totals_are_preserved_verbatim(clean_invoice):
    clean_invoice.totals.cess_total = Decimal("25.50")

    record = build(clean_invoice)

    assert record.taxable_value == Decimal("45000")
    assert record.cgst_total == Decimal("4050")
    assert record.sgst_total == Decimal("4050")
    assert record.igst_total == Decimal("0")
    assert record.cess_total == Decimal("25.50")
    assert record.grand_total == Decimal("53100")
    assert isinstance(record.taxable_value, Decimal)


def test_missing_invoice_date_fails_clearly(clean_invoice):
    clean_invoice.invoice_date = None

    with pytest.raises(ValueError) as error:
        build(clean_invoice)

    assert "invoice_date" in str(error.value)


def test_unknown_invoice_gstr1_returns_404():
    response = TestClient(app).get("/api/invoices/does-not-exist/gstr1")

    assert response.status_code == 404
    assert response.json() == {"detail": "Invoice not found"}


def test_gstr1_endpoint_returns_typed_record(monkeypatch, clean_invoice):
    monkeypatch.setitem(extraction.invoices, "test-invoice", clean_invoice)

    response = TestClient(app).get("/api/invoices/test-invoice/gstr1")

    assert response.status_code == 200
    payload = response.json()
    assert payload["invoice_type"] == "B2B"
    assert payload["invoice_number"] == "SH/26-27/0041"
    assert payload["invoice_date"] == "2026-10-14"
    assert payload["line_items"][0]["hsn_sac"] == "8539"
    assert Decimal(payload["grand_total"]) == Decimal("53100")
