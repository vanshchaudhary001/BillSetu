"""Phase 8B-5: business ownership of persisted invoices, documents and audit events."""

import asyncio
import json
from datetime import date
from decimal import Decimal
from io import BytesIO

import pytest
from fastapi import UploadFile
from fastapi.testclient import TestClient
from PIL import Image

from app.api.dependencies import _auth_service
from app.api.routes import documents as documents_routes
from app.core.config import settings
from app.main import app
from app.schemas.audit import AuditEvent
from app.schemas.documents import DocumentRecord
from app.schemas.invoice import CanonicalInvoice, InvoiceTotals, LineItem, Party
from app.services.audit_service import AuditService
from app.services.document_service import DocumentService
from app.services.extraction_service import ExtractionService, OwnershipConflictError
from app.services.validation_engine import ValidationEngine
from app.storage import migrate_persistent_storage
from app.validators.r01_gstin import _checksum


def gstin(prefix: str = "09ABCDE1234F1Z") -> str:
    return prefix + _checksum(prefix)


def png_upload() -> UploadFile:
    image = Image.new("RGB", (32, 32), "white")
    stream = BytesIO()
    image.save(stream, format="PNG")
    stream.seek(0)
    return UploadFile(
        file=stream, filename="invoice.png", headers={"content-type": "image/png"}
    )


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
    def extract(self, data: bytes, mime_type: str) -> CanonicalInvoice:
        return invoice()


@pytest.fixture
def data_dir(monkeypatch, tmp_path):
    """Point the record services at an isolated data directory."""
    monkeypatch.setattr(settings, "storage_root", str(tmp_path / "private-documents"))
    return tmp_path


def write_legacy_state(data_dir) -> None:
    """Create pre-ownership files exactly as the previous phase wrote them."""
    legacy_invoice = invoice().model_dump(mode="json")
    (data_dir / "invoices.json").write_text(
        json.dumps({"inv-legacy": legacy_invoice}), encoding="utf-8"
    )

    legacy_document = DocumentRecord(
        document_id="doc-legacy",
        filename="legacy.pdf",
        media_type="application/pdf",
        extension=".pdf",
        size_bytes=12,
        sha256="0" * 64,
        status="uploaded",
        created_at="2026-10-01T10:00:00+00:00",
    ).model_dump(mode="json")
    legacy_document.pop("business_id")
    (data_dir / "documents.json").write_text(
        json.dumps(
            {
                "doc-legacy": {
                    "record": legacy_document,
                    "storage_path": str(data_dir / "private-documents" / "legacy.pdf"),
                }
            }
        ),
        encoding="utf-8",
    )

    legacy_event = AuditEvent(
        event_id="event-legacy",
        document_id="doc-legacy",
        invoice_id="inv-legacy",
        event_type="document_uploaded",
        status="completed",
        message="Legacy upload.",
        created_at="2026-10-01T10:00:00+00:00",
    ).model_dump(mode="json")
    legacy_event.pop("business_id")
    (data_dir / "audit_events.json").write_text(
        json.dumps([legacy_event]), encoding="utf-8"
    )


# --------------------------------------------------------------------------
# Migration
# --------------------------------------------------------------------------


def test_migration_marks_legacy_records_unowned_and_keeps_them(data_dir):
    write_legacy_state(data_dir)

    report = migrate_persistent_storage(data_dir)

    assert report.applied is True
    assert set(report.migrated_files) == {
        "invoices.json",
        "documents.json",
        "audit_events.json",
    }

    invoices = json.loads((data_dir / "invoices.json").read_text(encoding="utf-8"))
    assert invoices["schema_version"] == 2
    assert list(invoices["records"]) == ["inv-legacy"]
    assert invoices["records"]["inv-legacy"]["business_id"] is None
    assert invoices["records"]["inv-legacy"]["invoice"]["invoice_number"] == "SH/26-27/0041"

    documents = json.loads((data_dir / "documents.json").read_text(encoding="utf-8"))
    assert documents["doc-legacy"]["record"]["business_id"] is None
    assert documents["doc-legacy"]["record"]["document_id"] == "doc-legacy"

    events = json.loads((data_dir / "audit_events.json").read_text(encoding="utf-8"))
    assert len(events) == 1
    assert events[0]["business_id"] is None
    assert events[0]["event_id"] == "event-legacy"

    marker = json.loads((data_dir / "storage_schema.json").read_text(encoding="utf-8"))
    assert marker["schema_version"] == 2
    for name in ("invoices.json", "documents.json", "audit_events.json"):
        assert (data_dir / f"{name}.pre-ownership.bak").exists()


def test_migration_is_idempotent_and_does_not_duplicate(data_dir):
    write_legacy_state(data_dir)

    first = migrate_persistent_storage(data_dir)
    assert first.applied is True
    snapshot = {
        name: (data_dir / name).read_bytes()
        for name in ("invoices.json", "documents.json", "audit_events.json")
    }

    second = migrate_persistent_storage(data_dir)

    assert second.applied is False
    assert second.migrated_files == ()
    for name, content in snapshot.items():
        assert (data_dir / name).read_bytes() == content

    invoices = json.loads((data_dir / "invoices.json").read_text(encoding="utf-8"))
    assert len(invoices["records"]) == 1
    events = json.loads((data_dir / "audit_events.json").read_text(encoding="utf-8"))
    assert len(events) == 1


def test_migration_on_fresh_state_changes_nothing(tmp_path):
    report = migrate_persistent_storage(tmp_path)

    assert report.applied is False
    assert report.migrated_files == ()
    assert list(tmp_path.iterdir()) == []


def test_migration_leaves_owned_records_untouched(data_dir):
    audit = AuditService()
    documents = DocumentService(audit=audit)
    pipeline = ExtractionService(documents, FakeGemini(), ValidationEngine(), audit=audit)
    uploaded = asyncio.run(documents.upload(png_upload(), business_id="business-a"))
    pipeline.extract(uploaded.document_id, business_id="business-a")

    report = migrate_persistent_storage(data_dir)

    assert report.applied is False
    invoices = json.loads((data_dir / "invoices.json").read_text(encoding="utf-8"))
    assert all(
        entry["business_id"] == "business-a"
        for entry in invoices["records"].values()
    )


def test_migrated_state_is_readable_after_restart(data_dir):
    write_legacy_state(data_dir)
    migrate_persistent_storage(data_dir)

    audit = AuditService()
    documents = DocumentService(audit=audit)
    pipeline = ExtractionService(documents, FakeGemini(), ValidationEngine(), audit=audit)

    assert pipeline.invoice("inv-legacy").invoice_number == "SH/26-27/0041"
    assert pipeline.invoice_business_id("inv-legacy") is None
    assert documents.get("doc-legacy").business_id is None
    events = audit.list_for_document("doc-legacy", None)
    assert [event.event_id for event in events] == ["event-legacy"]
    assert events[0].business_id is None
    assert audit.list_for_business("business-a") == []


# --------------------------------------------------------------------------
# Ownership
# --------------------------------------------------------------------------


def test_new_document_invoice_and_audit_carry_business_ownership(data_dir):
    audit = AuditService()
    documents = DocumentService(audit=audit)
    pipeline = ExtractionService(documents, FakeGemini(), ValidationEngine(), audit=audit)

    uploaded = asyncio.run(documents.upload(png_upload(), business_id="business-a"))
    document, invoice_id, _ = pipeline.extract(
        uploaded.document_id, business_id="business-a"
    )

    assert uploaded.business_id == "business-a"
    assert document.business_id == "business-a"
    assert pipeline.invoice_business_id(invoice_id) == "business-a"

    documents_payload = json.loads(
        (data_dir / "documents.json").read_text(encoding="utf-8")
    )
    assert documents_payload[uploaded.document_id]["record"]["business_id"] == "business-a"

    invoices_payload = json.loads(
        (data_dir / "invoices.json").read_text(encoding="utf-8")
    )
    assert invoices_payload["records"][invoice_id]["business_id"] == "business-a"

    events_payload = json.loads(
        (data_dir / "audit_events.json").read_text(encoding="utf-8")
    )
    assert events_payload
    assert all(event["business_id"] == "business-a" for event in events_payload)
    assert {event["event_type"] for event in events_payload} == {
        "document_uploaded",
        "security_checked",
        "extraction_started",
        "extraction_completed",
        "validation_completed",
    }

    # Restart: ownership is read back from persistence, not from memory.
    restarted_audit = AuditService()
    restarted_documents = DocumentService(audit=restarted_audit)
    restarted_pipeline = ExtractionService(
        restarted_documents, FakeGemini(), ValidationEngine(), audit=restarted_audit
    )
    assert restarted_documents.get(uploaded.document_id).business_id == "business-a"
    assert restarted_pipeline.invoice_business_id(invoice_id) == "business-a"
    assert restarted_audit.list_for_business("business-a") == restarted_audit._events
    assert restarted_audit.list_for_business("business-b") == []


def test_cross_business_records_are_isolated_in_persistence(data_dir):
    audit = AuditService()
    documents = DocumentService(audit=audit)
    pipeline = ExtractionService(documents, FakeGemini(), ValidationEngine(), audit=audit)

    document_a = asyncio.run(documents.upload(png_upload(), business_id="business-a"))
    _, invoice_a, _ = pipeline.extract(document_a.document_id, business_id="business-a")

    document_b = asyncio.run(documents.upload(png_upload(), business_id="business-b"))
    _, invoice_b, _ = pipeline.extract(document_b.document_id, business_id="business-b")

    invoices_payload = json.loads(
        (data_dir / "invoices.json").read_text(encoding="utf-8")
    )
    assert invoices_payload["records"][invoice_a]["business_id"] == "business-a"
    assert invoices_payload["records"][invoice_b]["business_id"] == "business-b"
    assert len(invoices_payload["records"]) == 2

    documents_payload = json.loads(
        (data_dir / "documents.json").read_text(encoding="utf-8")
    )
    assert documents_payload[document_a.document_id]["record"]["business_id"] == "business-a"
    assert documents_payload[document_b.document_id]["record"]["business_id"] == "business-b"

    events_a = audit.list_for_business("business-a")
    events_b = audit.list_for_business("business-b")
    assert events_a and events_b
    assert {event.document_id for event in events_a} == {document_a.document_id}
    assert {event.document_id for event in events_b} == {document_b.document_id}
    assert not {event.document_id for event in events_a} & {
        event.document_id for event in events_b
    }

    # The document -> invoice link never crosses the business boundary.
    assert documents.find_by_invoice(invoice_a) == document_a.document_id
    assert pipeline.invoice_business_id(invoice_b) == "business-b"


def test_document_cannot_produce_an_invoice_for_another_business(data_dir):
    audit = AuditService()
    documents = DocumentService(audit=audit)
    pipeline = ExtractionService(documents, FakeGemini(), ValidationEngine(), audit=audit)
    uploaded = asyncio.run(documents.upload(png_upload(), business_id="business-a"))

    with pytest.raises(OwnershipConflictError):
        pipeline.extract(uploaded.document_id, business_id="business-b")

    assert not (data_dir / "invoices.json").exists()
    assert documents.get(uploaded.document_id).business_id == "business-a"
    assert documents.get(uploaded.document_id).invoice_id is None


def test_legacy_document_stays_unowned_when_extracted(data_dir):
    audit = AuditService()
    documents = DocumentService(audit=audit)
    legacy = asyncio.run(documents.upload(png_upload()))
    assert legacy.business_id is None

    pipeline = ExtractionService(documents, FakeGemini(), ValidationEngine(), audit=audit)
    _, invoice_id, _ = pipeline.extract(legacy.document_id, business_id="business-a")

    assert pipeline.invoice_business_id(invoice_id) == "business-a"
    documents_payload = json.loads(
        (data_dir / "documents.json").read_text(encoding="utf-8")
    )
    assert documents_payload[legacy.document_id]["record"]["business_id"] is None
    assert documents.get(legacy.document_id).business_id is None


# --------------------------------------------------------------------------
# API compatibility
# --------------------------------------------------------------------------


@pytest.fixture
def authenticated_client(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "storage_root", str(tmp_path / "private-documents"))
    monkeypatch.setattr(settings, "auth_database_path", str(tmp_path / "auth.sqlite3"))
    monkeypatch.setattr(settings, "auth_session_ttl_seconds", 3600)
    monkeypatch.setattr(settings, "auth_cookie_secure", False)
    _auth_service.cache_clear()

    audit = AuditService()
    documents = DocumentService(audit=audit)
    monkeypatch.setattr(documents_routes, "audit", audit)
    monkeypatch.setattr(documents_routes, "documents", documents)

    with TestClient(app) as client:
        yield client, tmp_path
    _auth_service.cache_clear()


def test_authenticated_upload_persists_session_business_ownership(authenticated_client):
    client, tmp_path = authenticated_client
    registration = client.post(
        "/api/auth/register",
        json={"email": "owner@example.com", "password": "correct horse battery"},
    )
    assert registration.status_code == 201
    business_id = client.get("/api/businesses/current").json()["id"]

    response = client.post(
        "/api/documents/upload",
        files={"file": ("invoice.png", png_upload().file, "image/png")},
    )
    assert response.status_code == 201
    payload = response.json()
    assert payload["business_id"] == business_id

    documents_payload = json.loads(
        (tmp_path / "documents.json").read_text(encoding="utf-8")
    )
    assert documents_payload[payload["document_id"]]["record"]["business_id"] == business_id

    # Phase 8B-6: uploads require an authenticated business context, so an
    # anonymous client is rejected instead of creating an unowned record.
    client.post("/api/auth/logout")
    anonymous = client.post(
        "/api/documents/upload",
        files={"file": ("anon.png", png_upload().file, "image/png")},
    )
    assert anonymous.status_code == 401
