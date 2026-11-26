import asyncio
import csv
import io
from datetime import date
from decimal import Decimal
from io import BytesIO

import pytest
from fastapi import UploadFile
from fastapi.testclient import TestClient
from PIL import Image

from app.api.routes import invoices as invoices_routes
from app.api.routes.documents import extraction
from app.core.config import settings
from app.main import app
from app.schemas.gstr1 import GSTR1Record
from app.schemas.invoice import CanonicalInvoice, InvoiceTotals, LineItem, Party
from app.services.audit_service import AuditService
from app.services.document_service import DocumentService
from app.services.export_service import CSV_COLUMNS, export_filename
from app.services.extraction_service import ExtractionService
from app.services.validation_engine import ValidationEngine
from app.validators.r01_gstin import _checksum
from tests.conftest import own_invoice


def gstin(prefix: str = "09ABCDE1234F1Z") -> str:
    return prefix + _checksum(prefix)


def png_upload() -> UploadFile:
    image = Image.new("RGB", (32, 32), "white")
    stream = BytesIO()
    image.save(stream, format="PNG")
    stream.seek(0)
    return UploadFile(file=stream, filename="invoice.png", headers={"content-type": "image/png"})


def invoice() -> CanonicalInvoice:
    return CanonicalInvoice(
        invoice_number="SH/26-27/0041",
        invoice_date=date(2026, 10, 14),
        supplier=Party(name="Sharma Electricals", gstin=gstin(), state_code="09"),
        buyer=Party(
            name="Verma Builders",
            gstin=gstin("09XYZAB5678K1Z"),
            state_code="09",
            address_present=True,
        ),
        place_of_supply_state_code="09",
        line_items=[
            LineItem(
                description="LED Flood Light",
                hsn_sac="8539",
                quantity=Decimal("100"),
                unit_rate=Decimal("450"),
                taxable_value=Decimal("45000"),
                gst_rate_pct=Decimal("18"),
                cgst_amount=Decimal("4050"),
                sgst_amount=Decimal("4050"),
            )
        ],
        totals=InvoiceTotals(
            taxable_value=Decimal("45000"),
            cgst_total=Decimal("4050"),
            sgst_total=Decimal("4050"),
            grand_total=Decimal("53100"),
        ),
    )


class FakeGemini:
    def __init__(self, value: CanonicalInvoice | None = None) -> None:
        self.value = value or invoice()

    def extract(self, data: bytes, mime_type: str) -> CanonicalInvoice:
        return self.value


def pipeline_with(audit, extracted=None, business_id=None):
    documents = DocumentService(audit=audit)
    uploaded = asyncio.run(documents.upload(png_upload(), business_id=business_id))
    pipeline = ExtractionService(
        documents, FakeGemini(extracted), ValidationEngine(), audit=audit
    )
    _, invoice_id, _ = pipeline.extract(uploaded.document_id, business_id=business_id)
    return pipeline, invoice_id


def test_json_export_returns_downloadable_record(monkeypatch, clean_invoice, sign_in):
    client = TestClient(app)
    business_id = sign_in(client)
    own_invoice(monkeypatch, extraction, "inv-json", clean_invoice, business_id)

    response = client.get("/api/invoices/inv-json/export/json")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    disposition = response.headers["content-disposition"]
    assert disposition.startswith("attachment;")
    assert 'filename="billsetu_SH_26-27_0041_gstr1.json"' in disposition

    payload = response.json()
    assert set(payload) == set(GSTR1Record.model_fields)
    assert payload["invoice_type"] == "B2B"
    assert payload["invoice_number"] == "SH/26-27/0041"
    assert Decimal(payload["grand_total"]) == Decimal("53100")


@pytest.mark.parametrize(
    "raw",
    ["../../etc/passwd", "..\\..\\windows\\system32", "INV\x00\x1f/../2026", "   "],
)
def test_export_filename_is_sanitized(raw):
    filename = export_filename(raw, "json")

    assert filename.startswith("billsetu_")
    assert filename.endswith("_gstr1.json")
    assert "/" not in filename
    assert "\\" not in filename
    assert ".." not in filename
    assert "\x00" not in filename


def test_csv_export_has_stable_headers_and_values(monkeypatch, clean_invoice, sign_in):
    clean_invoice.line_items[0].description = "LED लाइट"
    client = TestClient(app)
    business_id = sign_in(client)
    own_invoice(monkeypatch, extraction, "inv-csv", clean_invoice, business_id)

    response = client.get("/api/invoices/inv-csv/export/csv")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert 'filename="billsetu_SH_26-27_0041_gstr1.csv"' in response.headers[
        "content-disposition"
    ]

    rows = list(csv.reader(io.StringIO(response.content.decode("utf-8"))))
    assert tuple(rows[0]) == CSV_COLUMNS
    assert len(rows) == 2

    values = dict(zip(CSV_COLUMNS, rows[1]))
    assert values["line_description"] == "LED लाइट"
    assert values["hsn_sac"] == "8539"
    assert values["quantity"] == "100"
    assert values["taxable_value"] == "45000"
    assert values["gst_rate_pct"] == "18"
    assert values["cgst_amount"] == "4050"
    assert values["sgst_amount"] == "4050"
    assert values["igst_amount"] == "0"
    assert values["cess_amount"] == "0"
    assert values["invoice_taxable_value"] == "45000"
    assert values["grand_total"] == "53100"
    assert values["reverse_charge"] == "false"
    assert values["invoice_date"] == "2026-10-14"


def test_csv_export_uses_one_row_per_line_item(monkeypatch, clean_invoice, sign_in):
    clean_invoice.line_items.append(
        LineItem(
            description="Copper Wire",
            hsn_sac="8544",
            quantity=Decimal("10"),
            unit_rate=Decimal("2000"),
            taxable_value=Decimal("20000"),
            gst_rate_pct=Decimal("18"),
            cgst_amount=Decimal("1800"),
            sgst_amount=Decimal("1800"),
        )
    )
    clean_invoice.totals.taxable_value = Decimal("65000")
    clean_invoice.totals.cgst_total = Decimal("5850")
    clean_invoice.totals.sgst_total = Decimal("5850")
    clean_invoice.totals.grand_total = Decimal("76700")
    client = TestClient(app)
    business_id = sign_in(client)
    own_invoice(monkeypatch, extraction, "inv-multi", clean_invoice, business_id)

    response = client.get("/api/invoices/inv-multi/export/csv")

    assert response.status_code == 200
    rows = list(csv.reader(io.StringIO(response.content.decode("utf-8"))))
    assert len(rows) == 3
    assert rows[1][CSV_COLUMNS.index("line_description")] == "LED Flood Light"
    assert rows[2][CSV_COLUMNS.index("line_description")] == "Copper Wire"
    assert rows[1][CSV_COLUMNS.index("invoice_number")] == rows[2][CSV_COLUMNS.index("invoice_number")]


def test_blocked_invoice_returns_conflict(monkeypatch, clean_invoice, sign_in):
    clean_invoice.supplier.name = None
    client = TestClient(app)
    business_id = sign_in(client)
    own_invoice(monkeypatch, extraction, "inv-blocked", clean_invoice, business_id)

    json_response = client.get("/api/invoices/inv-blocked/export/json")
    csv_response = client.get("/api/invoices/inv-blocked/export/csv")

    assert json_response.status_code == 409
    assert csv_response.status_code == 409
    assert "not export ready" in json_response.json()["detail"]


def test_missing_invoice_exports_return_404(sign_in):
    client = TestClient(app)
    sign_in(client)

    assert client.get("/api/invoices/does-not-exist/export/json").status_code == 404
    assert client.get("/api/invoices/does-not-exist/export/csv").status_code == 404


def test_successful_exports_record_audit_events(monkeypatch, tmp_path, sign_in):
    monkeypatch.setattr(settings, "storage_root", str(tmp_path))
    client = TestClient(app)
    business_id = sign_in(client)
    audit = AuditService()
    pipeline, invoice_id = pipeline_with(audit, business_id=business_id)
    monkeypatch.setattr(invoices_routes, "extraction", pipeline)
    monkeypatch.setattr(invoices_routes, "audit", audit)

    assert client.get(f"/api/invoices/{invoice_id}/export/json").status_code == 200
    assert client.get(f"/api/invoices/{invoice_id}/export/csv").status_code == 200

    export_events = [
        event
        for event in audit.list_for_invoice(invoice_id, business_id)
        if event.event_type.startswith("export_")
    ]
    assert [event.event_type for event in export_events] == [
        "export_json_generated",
        "export_csv_generated",
    ]
    assert all(event.status == "completed" for event in export_events)
    assert export_events[0].metadata["format"] == "json"
    assert export_events[1].metadata["format"] == "csv"
    assert export_events[0].metadata["invoice_type"] == "B2B"
    assert "content" not in export_events[0].metadata


def test_blocked_export_records_no_success_event(monkeypatch, tmp_path, sign_in):
    monkeypatch.setattr(settings, "storage_root", str(tmp_path))
    client = TestClient(app)
    business_id = sign_in(client)
    audit = AuditService()
    broken = invoice()
    broken.supplier.name = None
    pipeline, invoice_id = pipeline_with(audit, extracted=broken, business_id=business_id)
    monkeypatch.setattr(invoices_routes, "extraction", pipeline)
    monkeypatch.setattr(invoices_routes, "audit", audit)

    response = client.get(f"/api/invoices/{invoice_id}/export/json")

    assert response.status_code == 409
    export_events = [
        event
        for event in audit.list_for_invoice(invoice_id, business_id)
        if event.event_type.startswith("export_")
    ]
    assert export_events == []
