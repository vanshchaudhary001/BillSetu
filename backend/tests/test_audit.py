import asyncio
from datetime import date, timedelta
from decimal import Decimal
from io import BytesIO
from uuid import UUID

import pytest
from fastapi import UploadFile
from fastapi.testclient import TestClient
from PIL import Image

from app.api.routes import documents as documents_routes
from app.api.routes import invoices as invoices_routes
from app.api.routes.documents import extraction
from app.core.config import settings
from app.main import app
from app.schemas.invoice import CanonicalInvoice, InvoiceTotals, LineItem, Party
from app.services.audit_service import AuditService
from app.services.document_service import DocumentService
from app.services.extraction_service import ExtractionService
from app.services.validation_engine import ValidationEngine
from app.validators.r01_gstin import _checksum


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
    def __init__(self, value: CanonicalInvoice | None = None, error: Exception | None = None):
        self.value = value or invoice()
        self.error = error

    def extract(self, data: bytes, mime_type: str) -> CanonicalInvoice:
        if self.error:
            raise self.error
        return self.value


@pytest.fixture
def audit(tmp_path, monkeypatch) -> AuditService:
    monkeypatch.setattr(settings, "storage_root", str(tmp_path / "private-documents"))
    return AuditService()


def test_record_creates_uuid_and_utc_timestamp(audit, tmp_path):
    event = audit.record(
        event_type="document_uploaded",
        status="completed",
        message="Document uploaded.",
        document_id="doc-1",
    )

    assert UUID(event.event_id)
    assert event.created_at.tzinfo is not None
    assert event.created_at.utcoffset() == timedelta(0)
    assert (tmp_path / "audit_events.json").exists()


def test_events_survive_service_reload(audit):
    first = audit.record(
        event_type="document_uploaded",
        status="completed",
        message="Document uploaded.",
        document_id="doc-1",
    )

    reloaded = AuditService()
    restored = reloaded.list_for_document("doc-1")

    assert [event.event_id for event in restored] == [first.event_id]
    assert restored[0].event_type == "document_uploaded"


def test_missing_audit_file_behaves_as_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "storage_root", str(tmp_path / "private-documents"))
    service = AuditService()

    assert service.list_for_document("missing") == []
    assert service.list_for_invoice("missing") == []
    assert not (tmp_path / "audit_events.json").exists()


def test_listing_filters_and_orders_chronologically(audit):
    audit.record(event_type="document_uploaded", status="completed", message="a", document_id="doc-1")
    audit.record(event_type="security_checked", status="completed", message="b", document_id="doc-1")
    audit.record(event_type="document_uploaded", status="completed", message="c", document_id="doc-2")
    audit.record(
        event_type="extraction_completed",
        status="completed",
        message="d",
        document_id="doc-1",
        invoice_id="inv-1",
    )

    document_events = audit.list_for_document("doc-1")
    invoice_events = audit.list_for_invoice("inv-1")

    assert [event.event_type for event in document_events] == [
        "document_uploaded",
        "security_checked",
        "extraction_completed",
    ]
    assert [event.event_type for event in invoice_events] == ["extraction_completed"]
    assert [event.message for event in document_events] == ["a", "b", "d"]
    assert document_events == sorted(document_events, key=lambda event: event.created_at)


def test_upload_records_document_and_security_events(audit):
    documents = DocumentService(audit=audit)

    uploaded = asyncio.run(documents.upload(png_upload()))

    events = audit.list_for_document(uploaded.document_id)
    assert [event.event_type for event in events] == ["document_uploaded", "security_checked"]
    assert all(event.status == "completed" for event in events)
    assert events[0].metadata["sha256"] == uploaded.sha256


def test_extraction_records_pipeline_events(audit, tmp_path):
    documents = DocumentService(audit=audit)
    uploaded = asyncio.run(documents.upload(png_upload()))
    pipeline = ExtractionService(documents, FakeGemini(), ValidationEngine(), audit=audit)

    _, invoice_id, validation = pipeline.extract(uploaded.document_id)

    document_events = audit.list_for_document(uploaded.document_id)
    assert [event.event_type for event in document_events] == [
        "document_uploaded",
        "security_checked",
        "extraction_started",
        "extraction_completed",
        "validation_completed",
    ]
    assert document_events[2].status == "started"
    assert document_events[-1].status == "completed"
    assert validation.status == "validated"

    invoice_events = audit.list_for_invoice(invoice_id)
    assert [event.event_type for event in invoice_events] == [
        "extraction_completed",
        "validation_completed",
    ]


def test_gstr1_generation_records_event(audit, monkeypatch):
    documents = DocumentService(audit=audit)
    uploaded = asyncio.run(documents.upload(png_upload()))
    pipeline = ExtractionService(documents, FakeGemini(), ValidationEngine(), audit=audit)
    _, invoice_id, _ = pipeline.extract(uploaded.document_id)

    monkeypatch.setattr(invoices_routes, "extraction", pipeline)
    monkeypatch.setattr(invoices_routes, "audit", audit)

    record = invoices_routes.get_invoice_gstr1(invoice_id)

    assert record.invoice_type == "B2B"
    events = audit.list_for_invoice(invoice_id)
    assert events[-1].event_type == "gstr1_generated"
    assert events[-1].status == "completed"
    assert events[-1].metadata["invoice_type"] == "B2B"


def test_extraction_failure_is_recorded_and_original_exception_preserved(audit):
    documents = DocumentService(audit=audit)
    uploaded = asyncio.run(documents.upload(png_upload()))
    pipeline = ExtractionService(
        documents,
        FakeGemini(error=RuntimeError("provider down")),
        ValidationEngine(),
        audit=audit,
    )

    with pytest.raises(RuntimeError, match="provider down"):
        pipeline.extract(uploaded.document_id)

    events = audit.list_for_document(uploaded.document_id)
    assert [event.event_type for event in events] == [
        "document_uploaded",
        "security_checked",
        "extraction_started",
        "extraction_failed",
    ]
    assert events[-1].status == "failed"
    assert events[-1].metadata["error_type"] == "RuntimeError"


def test_audit_failure_does_not_break_upload(audit, monkeypatch):
    def explode(**kwargs):
        raise OSError("audit storage unavailable")

    monkeypatch.setattr(audit, "record", explode)
    documents = DocumentService(audit=audit)

    uploaded = asyncio.run(documents.upload(png_upload()))

    assert uploaded.status == "uploaded"
    assert uploaded.size_bytes > 0


def test_audit_failure_does_not_mask_extraction_error(audit, monkeypatch):
    documents = DocumentService(audit=audit)
    uploaded = asyncio.run(documents.upload(png_upload()))

    def explode(**kwargs):
        raise OSError("audit storage unavailable")

    monkeypatch.setattr(audit, "record", explode)
    pipeline = ExtractionService(
        documents,
        FakeGemini(error=RuntimeError("provider down")),
        ValidationEngine(),
        audit=audit,
    )

    with pytest.raises(RuntimeError, match="provider down"):
        pipeline.extract(uploaded.document_id)


def test_invoice_audit_endpoint_returns_history(audit, monkeypatch, clean_invoice):
    audit.record(
        event_type="extraction_completed",
        status="completed",
        message="Canonical invoice created.",
        document_id="doc-1",
        invoice_id="inv-1",
    )
    audit.record(
        event_type="validation_completed",
        status="review_required",
        message="Validation finished.",
        document_id="doc-1",
        invoice_id="inv-1",
    )
    monkeypatch.setitem(extraction.invoices, "inv-1", clean_invoice)
    monkeypatch.setattr(invoices_routes, "audit", audit)

    response = TestClient(app).get("/api/invoices/inv-1/audit")

    assert response.status_code == 200
    payload = response.json()
    assert [event["event_type"] for event in payload] == [
        "extraction_completed",
        "validation_completed",
    ]
    assert payload[0]["created_at"] <= payload[1]["created_at"]


def test_unknown_invoice_audit_returns_404():
    response = TestClient(app).get("/api/invoices/does-not-exist/audit")

    assert response.status_code == 404
    assert response.json() == {"detail": "Invoice not found"}


def test_document_audit_endpoint_returns_history(audit, monkeypatch):
    documents = DocumentService(audit=audit)
    uploaded = asyncio.run(documents.upload(png_upload()))
    monkeypatch.setattr(documents_routes, "documents", documents)
    monkeypatch.setattr(documents_routes, "audit", audit)

    response = TestClient(app).get(f"/api/documents/{uploaded.document_id}/audit")

    assert response.status_code == 200
    assert [event["event_type"] for event in response.json()] == [
        "document_uploaded",
        "security_checked",
    ]


def test_unknown_document_audit_returns_404():
    response = TestClient(app).get("/api/documents/does-not-exist/audit")

    assert response.status_code == 404
    assert response.json() == {"detail": "Document not found"}
