"""Phase 8B-6: authorization enforcement for business-owned records.

The security boundary under test is:

    session -> user -> active business -> membership -> business-scoped record

Everything here drives the real HTTP API, so the assertions are about what a
caller actually receives, not about internal service state.
"""

import sqlite3
from datetime import date
from decimal import Decimal
from io import BytesIO
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import UploadFile
from fastapi.testclient import TestClient
from PIL import Image

from app.api.routes import documents as documents_routes
from app.api.routes import invoices as invoices_routes
from app.core.config import settings
from app.main import app
from app.schemas.audit import AuditEvent
from app.schemas.documents import DocumentRecord
from app.schemas.invoice import CanonicalInvoice, InvoiceTotals, LineItem, Party
from app.services.audit_service import AuditService
from app.services.document_service import DocumentService
from app.services.extraction_service import ExtractionService
from app.services.validation_engine import ValidationEngine
from app.validators.r01_gstin import _checksum

INVOICE_READ_PATHS = ["", "/audit", "/gstr1", "/export/json", "/export/csv"]
DOCUMENT_READ_PATHS = ["", "/content", "/audit"]


def gstin(prefix: str = "09ABCDE1234F1Z") -> str:
    return prefix + _checksum(prefix)


def png_bytes() -> bytes:
    image = Image.new("RGB", (32, 32), "white")
    stream = BytesIO()
    image.save(stream, format="PNG")
    return stream.getvalue()


def invoice(number: str = "SH/26-27/0041") -> CanonicalInvoice:
    return CanonicalInvoice(
        invoice_number=number,
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


def png_upload() -> UploadFile:
    stream = BytesIO(png_bytes())
    return UploadFile(
        file=stream, filename="invoice.png", headers={"content-type": "image/png"}
    )


class FakeGemini:
    def extract(self, data: bytes, mime_type: str) -> CanonicalInvoice:
        return invoice()


def wire(monkeypatch, documents, audit, extraction) -> None:
    monkeypatch.setattr(documents_routes, "documents", documents)
    monkeypatch.setattr(documents_routes, "extraction", extraction)
    monkeypatch.setattr(documents_routes, "audit", audit)
    monkeypatch.setattr(invoices_routes, "extraction", extraction)
    monkeypatch.setattr(invoices_routes, "audit", audit)


@pytest.fixture
def api(monkeypatch, tmp_path, sign_in):
    """A signed-in client whose application records live in an isolated directory."""
    monkeypatch.setattr(settings, "storage_root", str(tmp_path / "private-documents"))
    audit = AuditService()
    documents = DocumentService(audit=audit)
    extraction = ExtractionService(
        documents, FakeGemini(), ValidationEngine(), audit=audit
    )
    wire(monkeypatch, documents, audit, extraction)
    with TestClient(app) as client:
        sign_in(client)
        yield SimpleNamespace(
            client=client,
            audit=audit,
            documents=documents,
            extraction=extraction,
            data_dir=tmp_path,
            sign_in=sign_in,
        )


def current_business_id(api) -> str:
    return api.client.get("/api/businesses/current").json()["id"]


def upload_and_extract(api) -> dict:
    """Upload and extract a document in the caller's active business."""
    uploaded = api.client.post(
        "/api/documents/upload",
        files={"file": ("invoice.png", png_bytes(), "image/png")},
    )
    assert uploaded.status_code == 201, uploaded.text
    document = uploaded.json()
    extracted = api.client.post(f"/api/documents/{document['document_id']}/extract")
    assert extracted.status_code == 200, extracted.text
    return {
        "document_id": document["document_id"],
        "invoice_id": extracted.json()["invoice_id"],
        "business_id": document["business_id"],
    }


def sign_out(api) -> None:
    assert api.client.post("/api/auth/logout").status_code == 200


# --------------------------------------------------------------------------
# Authentication
# --------------------------------------------------------------------------


@pytest.mark.parametrize("suffix", DOCUMENT_READ_PATHS)
def test_unauthenticated_cannot_read_document_records(api, suffix):
    record = upload_and_extract(api)
    sign_out(api)

    response = api.client.get(f"/api/documents/{record['document_id']}{suffix}")

    assert response.status_code == 401
    assert response.json() == {"detail": "Not authenticated"}


@pytest.mark.parametrize("suffix", INVOICE_READ_PATHS)
def test_unauthenticated_cannot_read_invoice_records(api, suffix):
    record = upload_and_extract(api)
    sign_out(api)

    response = api.client.get(f"/api/invoices/{record['invoice_id']}{suffix}")

    assert response.status_code == 401


def test_unauthenticated_cannot_list_records(api):
    upload_and_extract(api)
    sign_out(api)

    assert api.client.get("/api/documents").status_code == 401
    assert api.client.get("/api/invoices").status_code == 401


def test_unauthenticated_cannot_modify_records(api):
    record = upload_and_extract(api)
    sign_out(api)

    extract = api.client.post(f"/api/documents/{record['document_id']}/extract")
    validate = api.client.post(f"/api/invoices/{record['invoice_id']}/validate")
    upload = api.client.post(
        "/api/documents/upload",
        files={"file": ("invoice.png", png_bytes(), "image/png")},
    )

    assert extract.status_code == 401
    assert validate.status_code == 401
    assert upload.status_code == 401


def test_invalid_session_cookie_is_rejected(api):
    record = upload_and_extract(api)
    api.client.cookies.set(settings.auth_cookie_name, "not-a-real-session")

    assert api.client.get(f"/api/invoices/{record['invoice_id']}").status_code == 401


# --------------------------------------------------------------------------
# Same-business access
# --------------------------------------------------------------------------


def test_business_can_use_every_owned_record(api):
    business_id = current_business_id(api)
    record = upload_and_extract(api)

    document = api.client.get(f"/api/documents/{record['document_id']}")
    content = api.client.get(f"/api/documents/{record['document_id']}/content")
    document_audit = api.client.get(f"/api/documents/{record['document_id']}/audit")
    invoice_response = api.client.get(f"/api/invoices/{record['invoice_id']}")
    validation = api.client.post(f"/api/invoices/{record['invoice_id']}/validate")
    gstr1 = api.client.get(f"/api/invoices/{record['invoice_id']}/gstr1")
    invoice_audit = api.client.get(f"/api/invoices/{record['invoice_id']}/audit")
    json_export = api.client.get(f"/api/invoices/{record['invoice_id']}/export/json")
    csv_export = api.client.get(f"/api/invoices/{record['invoice_id']}/export/csv")

    assert document.status_code == 200
    assert document.json()["business_id"] == business_id
    assert content.status_code == 200
    assert content.content.startswith(b"\xff\xd8\xff")
    assert document_audit.status_code == 200
    assert invoice_response.status_code == 200
    assert validation.status_code == 200
    assert validation.json()["export_ready"] is True
    assert gstr1.status_code == 200
    assert invoice_audit.status_code == 200
    assert json_export.status_code == 200
    assert csv_export.status_code == 200

    document_events = document_audit.json()
    assert document_events
    assert {event["business_id"] for event in document_events} == {business_id}
    assert {event["document_id"] for event in document_events} == {
        record["document_id"]
    }
    assert all(
        event["business_id"] == business_id for event in invoice_audit.json()
    )


def test_business_lists_only_its_own_records(api):
    record = upload_and_extract(api)

    invoices = api.client.get("/api/invoices")
    documents = api.client.get("/api/documents")

    assert invoices.status_code == 200
    assert [row["invoice_id"] for row in invoices.json()] == [record["invoice_id"]]
    summary = invoices.json()[0]
    assert summary["invoice_number"] == "SH/26-27/0041"
    assert summary["document_id"] == record["document_id"]
    assert Decimal(str(summary["grand_total"])) == Decimal("53100")

    assert documents.status_code == 200
    assert [row["document_id"] for row in documents.json()] == [record["document_id"]]


# --------------------------------------------------------------------------
# Cross-business isolation
# --------------------------------------------------------------------------


@pytest.mark.parametrize("suffix", INVOICE_READ_PATHS)
def test_cross_business_invoice_access_is_not_found(api, suffix):
    record = upload_and_extract(api)
    sign_out(api)
    api.sign_in(api.client, "other@example.com")

    foreign = api.client.get(f"/api/invoices/{record['invoice_id']}{suffix}")
    missing = api.client.get(f"/api/invoices/{uuid4()}{suffix}")

    assert foreign.status_code == 404
    assert missing.status_code == 404
    # Identical response: a cross-business record is indistinguishable from one
    # that does not exist at all.
    assert foreign.json() == missing.json()


@pytest.mark.parametrize("suffix", DOCUMENT_READ_PATHS)
def test_cross_business_document_access_is_not_found(api, suffix):
    record = upload_and_extract(api)
    sign_out(api)
    api.sign_in(api.client, "other@example.com")

    foreign = api.client.get(f"/api/documents/{record['document_id']}{suffix}")
    missing = api.client.get(f"/api/documents/{uuid4()}{suffix}")

    assert foreign.status_code == 404
    assert missing.status_code == 404
    assert foreign.json() == missing.json()


def test_cross_business_mutations_are_not_found(api):
    record = upload_and_extract(api)
    invoices_before = (api.data_dir / "invoices.json").read_text(encoding="utf-8")
    sign_out(api)
    api.sign_in(api.client, "other@example.com")

    extract = api.client.post(f"/api/documents/{record['document_id']}/extract")
    validate = api.client.post(f"/api/invoices/{record['invoice_id']}/validate")

    assert extract.status_code == 404
    assert validate.status_code == 404
    # Nothing was written for the other business.
    assert (api.data_dir / "invoices.json").read_text(encoding="utf-8") == invoices_before


def test_cross_business_listings_stay_empty(api):
    upload_and_extract(api)
    sign_out(api)
    api.sign_in(api.client, "other@example.com")

    assert api.client.get("/api/invoices").json() == []
    assert api.client.get("/api/documents").json() == []


def test_query_parameters_cannot_widen_a_listing(api):
    foreign_business = "business-that-does-not-exist"
    record = upload_and_extract(api)

    invoices = api.client.get("/api/invoices", params={"business_id": foreign_business})
    documents = api.client.get("/api/documents", params={"business_id": foreign_business})

    assert [row["invoice_id"] for row in invoices.json()] == [record["invoice_id"]]
    assert [row["document_id"] for row in documents.json()] == [record["document_id"]]


# --------------------------------------------------------------------------
# Upload ownership
# --------------------------------------------------------------------------


def test_upload_owner_comes_from_the_session_not_the_request(api):
    business_id = current_business_id(api)

    response = api.client.post(
        "/api/documents/upload",
        files={"file": ("invoice.png", png_bytes(), "image/png")},
        data={"business_id": "someone-elses-business"},
        params={"business_id": "someone-elses-business"},
    )

    assert response.status_code == 201
    assert response.json()["business_id"] == business_id


# --------------------------------------------------------------------------
# Legacy records (business_id = null)
# --------------------------------------------------------------------------


def write_legacy_records(data_dir, documents: DocumentService) -> None:
    """Persist pre-ownership records exactly as the migration leaves them."""
    import json  # local: only this test writes raw files

    legacy_invoice = invoice().model_dump(mode="json")
    (data_dir / "invoices.json").write_text(
        json.dumps(
            {
                "schema_version": 2,
                "records": {"inv-legacy": {"business_id": None, "invoice": legacy_invoice}},
            }
        ),
        encoding="utf-8",
    )

    storage_path = data_dir / "private-documents" / "legacy.pdf"
    storage_path.parent.mkdir(parents=True, exist_ok=True)
    storage_path.write_bytes(b"%PDF-1.4\nlegacy")
    legacy_document = DocumentRecord(
        document_id="doc-legacy",
        filename="legacy.pdf",
        media_type="application/pdf",
        extension=".pdf",
        size_bytes=13,
        sha256="0" * 64,
        status="uploaded",
        created_at="2026-10-01T10:00:00+00:00",
        business_id=None,
    ).model_dump(mode="json")
    (data_dir / "documents.json").write_text(
        json.dumps(
            {
                "doc-legacy": {
                    "record": legacy_document,
                    "storage_path": str(storage_path),
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
        business_id=None,
    ).model_dump(mode="json")
    (data_dir / "audit_events.json").write_text(
        json.dumps([legacy_event]), encoding="utf-8"
    )


@pytest.fixture
def api_with_legacy_records(api, monkeypatch):
    write_legacy_records(api.data_dir, api.documents)
    # Fresh services so the records are read back from disk rather than memory.
    audit = AuditService()
    documents = DocumentService(audit=audit)
    extraction = ExtractionService(
        documents, FakeGemini(), ValidationEngine(), audit=audit
    )
    wire(monkeypatch, documents, audit, extraction)
    return SimpleNamespace(
        client=api.client,
        audit=audit,
        documents=documents,
        extraction=extraction,
        data_dir=api.data_dir,
        sign_in=api.sign_in,
    )


def test_legacy_records_are_absent_from_business_listings(api_with_legacy_records):
    api = api_with_legacy_records

    assert api.client.get("/api/invoices").json() == []
    assert api.client.get("/api/documents").json() == []


@pytest.mark.parametrize("suffix", INVOICE_READ_PATHS)
def test_legacy_invoice_is_not_reachable_through_business_endpoints(
    api_with_legacy_records, suffix
):
    api = api_with_legacy_records

    response = api.client.get(f"/api/invoices/inv-legacy{suffix}")

    assert response.status_code == 404
    assert response.json() == {"detail": "Invoice not found"}


@pytest.mark.parametrize("suffix", DOCUMENT_READ_PATHS)
def test_legacy_document_is_not_reachable_through_business_endpoints(
    api_with_legacy_records, suffix
):
    api = api_with_legacy_records

    response = api.client.get(f"/api/documents/doc-legacy{suffix}")

    assert response.status_code == 404
    assert response.json() == {"detail": "Document not found"}


def test_legacy_records_cannot_be_mutated_or_claimed(api_with_legacy_records):
    api = api_with_legacy_records

    extract = api.client.post("/api/documents/doc-legacy/extract")
    validate = api.client.post("/api/invoices/inv-legacy/validate")

    assert extract.status_code == 404
    assert validate.status_code == 404
    # The unowned document was not retroactively claimed, and no invoice was
    # created from it.
    assert api.documents.get("doc-legacy").business_id is None
    assert api.extraction.list_owned(current_business_id(api)) == []
    # The legacy audit history is not exposed through the business context.
    assert api.client.get("/api/documents/doc-legacy/audit").status_code == 404


def test_legacy_records_remain_intact_on_disk(api_with_legacy_records):
    api = api_with_legacy_records
    # Exercise the business endpoints so any rewrite of the JSON files happens.
    upload_and_extract(api)
    api.client.get("/api/invoices/inv-legacy")
    api.client.get("/api/documents/doc-legacy")

    import json  # local: only this test inspects raw files

    invoices = json.loads((api.data_dir / "invoices.json").read_text(encoding="utf-8"))
    assert invoices["records"]["inv-legacy"]["business_id"] is None
    assert (
        invoices["records"]["inv-legacy"]["invoice"]["invoice_number"]
        == "SH/26-27/0041"
    )

    documents = json.loads(
        (api.data_dir / "documents.json").read_text(encoding="utf-8")
    )
    assert documents["doc-legacy"]["record"]["business_id"] is None

    events = json.loads(
        (api.data_dir / "audit_events.json").read_text(encoding="utf-8")
    )
    legacy_events = [event for event in events if event["event_id"] == "event-legacy"]
    assert legacy_events and legacy_events[0]["business_id"] is None


# --------------------------------------------------------------------------
# Business state
# --------------------------------------------------------------------------


def deactivate_business(business_id: str) -> None:
    with sqlite3.connect(settings.auth_database_path) as connection:
        connection.execute(
            "UPDATE businesses SET is_active = 0 WHERE id = ?", (business_id,)
        )


def test_inactive_business_cannot_reach_its_records(api):
    record = upload_and_extract(api)
    business_id = current_business_id(api)

    deactivate_business(business_id)

    for path in (
        "/api/invoices",
        "/api/documents",
        f"/api/invoices/{record['invoice_id']}",
        f"/api/invoices/{record['invoice_id']}/export/csv",
        f"/api/documents/{record['document_id']}",
        f"/api/documents/{record['document_id']}/content",
    ):
        response = api.client.get(path)
        assert response.status_code == 403, (path, response.status_code)

    extract = api.client.post(f"/api/documents/{record['document_id']}/extract")
    assert extract.status_code == 403


def test_user_without_a_business_context_is_forbidden(api):
    upload_and_extract(api)
    with sqlite3.connect(settings.auth_database_path) as connection:
        connection.execute("DELETE FROM memberships")

    assert api.client.get("/api/invoices").status_code == 403
    assert api.client.get("/api/documents").status_code == 403
    assert (
        api.client.get(f"/api/invoices/{uuid4()}").json()
        == {"detail": "Business context required."}
    )


def test_switching_business_keeps_records_isolated(api):
    first_business = current_business_id(api)
    first = upload_and_extract(api)

    created = api.client.post("/api/businesses", json={"name": "Second Business"})
    assert created.status_code == 201
    second_business = created.json()["id"]
    assert second_business != first_business
    # Creating a business makes it the active context.
    assert current_business_id(api) == second_business

    assert api.client.get("/api/invoices").json() == []
    assert api.client.get("/api/documents").json() == []
    assert api.client.get(f"/api/invoices/{first['invoice_id']}").status_code == 404

    second = upload_and_extract(api)
    assert [row["invoice_id"] for row in api.client.get("/api/invoices").json()] == [
        second["invoice_id"]
    ]

    switched = api.client.post(f"/api/businesses/{first_business}/switch")
    assert switched.status_code == 200

    assert [row["invoice_id"] for row in api.client.get("/api/invoices").json()] == [
        first["invoice_id"]
    ]
    assert [row["document_id"] for row in api.client.get("/api/documents").json()] == [
        first["document_id"]
    ]
    assert api.client.get(f"/api/invoices/{second['invoice_id']}").status_code == 404
    assert api.client.get(f"/api/documents/{second['document_id']}").status_code == 404


def test_user_with_multiple_businesses_sees_one_context_at_a_time(api):
    first_business = current_business_id(api)
    api.client.post("/api/businesses", json={"name": "Branch Office"})
    second_business = current_business_id(api)

    sign_out(api)
    api.client.post(
        "/api/auth/login",
        json={"email": "owner@example.com", "password": "correct horse battery"},
    )

    businesses = api.client.get("/api/businesses").json()
    assert [business["id"] for business in businesses] == [
        first_business,
        second_business,
    ]
    # Signing in again picks one active context, not both.
    active = current_business_id(api)
    assert active in {first_business, second_business}
    assert api.client.get("/api/invoices").json() == []


# --------------------------------------------------------------------------
# Ownership integrity across businesses
# --------------------------------------------------------------------------


def test_records_from_two_businesses_stay_separate_end_to_end(api):
    import json  # local: only this test inspects raw files

    business_a = current_business_id(api)
    record_a = upload_and_extract(api)

    sign_out(api)
    business_b = api.sign_in(api.client, "b@example.com")
    record_b = upload_and_extract(api)

    assert business_a != business_b
    assert record_a["business_id"] == business_a
    assert record_b["business_id"] == business_b

    invoices = json.loads((api.data_dir / "invoices.json").read_text(encoding="utf-8"))
    assert invoices["records"][record_a["invoice_id"]]["business_id"] == business_a
    assert invoices["records"][record_b["invoice_id"]]["business_id"] == business_b

    documents = json.loads(
        (api.data_dir / "documents.json").read_text(encoding="utf-8")
    )
    assert documents[record_a["document_id"]]["record"]["business_id"] == business_a
    assert documents[record_b["document_id"]]["record"]["business_id"] == business_b

    events = json.loads(
        (api.data_dir / "audit_events.json").read_text(encoding="utf-8")
    )
    events_a = [event for event in events if event["business_id"] == business_a]
    events_b = [event for event in events if event["business_id"] == business_b]
    assert events_a and events_b
    assert {event["document_id"] for event in events_a} == {record_a["document_id"]}
    assert {event["document_id"] for event in events_b} == {record_b["document_id"]}
    assert None not in {event["business_id"] for event in events}

    # Business B's context cannot see or extend business A's records.
    assert api.client.get(f"/api/invoices/{record_a['invoice_id']}").status_code == 404
    assert (
        api.client.get(f"/api/documents/{record_a['document_id']}/content").status_code
        == 404
    )
    assert (
        api.client.post(f"/api/documents/{record_a['document_id']}/extract").status_code
        == 404
    )
    assert (
        api.client.post(f"/api/invoices/{record_a['invoice_id']}/validate").status_code
        == 404
    )
