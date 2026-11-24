import asyncio
import json
from io import BytesIO

from fastapi import UploadFile
from fastapi.testclient import TestClient

from app.core.config import settings
from app.main import app
from app.services.document_service import DocumentService


def pdf_upload() -> UploadFile:
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] >>",
    ]

    pdf = bytearray(b"%PDF-1.4\n")
    offsets = []

    for index, obj in enumerate(objects, start=1):
        offsets.append(len(pdf))
        pdf.extend(f"{index} 0 obj\n".encode())
        pdf.extend(obj)
        pdf.extend(b"\nendobj\n")

    xref_offset = len(pdf)

    pdf.extend(f"xref\n0 {len(objects) + 1}\n".encode())
    pdf.extend(b"0000000000 65535 f \n")

    for offset in offsets:
        pdf.extend(f"{offset:010d} 00000 n \n".encode())

    pdf.extend(
        f"trailer\n"
        f"<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n"
        f"{xref_offset}\n"
        f"%%EOF\n".encode()
    )

    return UploadFile(
        file=BytesIO(bytes(pdf)),
        filename="invoice.pdf",
        headers={"content-type": "application/pdf"},
    )


def test_upload_creates_persistent_metadata(monkeypatch, tmp_path):
    monkeypatch.setattr(
        settings,
        "storage_root",
        str(tmp_path / "private-documents"),
    )
    service = DocumentService()
    record = asyncio.run(service.upload(pdf_upload()))

    metadata_path = tmp_path / "documents.json"
    assert metadata_path.exists()

    payload = json.loads(
        metadata_path.read_text(encoding="utf-8")
    )

    assert payload[record.document_id]["record"]["document_id"] == record.document_id
    assert payload[record.document_id]["storage_path"]


def test_fresh_service_retrieves_existing_document(monkeypatch, tmp_path):
    monkeypatch.setattr(
        settings,
        "storage_root",
        str(tmp_path / "private-documents"),
    )
    first_service = DocumentService()
    uploaded = asyncio.run(first_service.upload(pdf_upload()))

    fresh_service = DocumentService()
    restored = fresh_service.get(uploaded.document_id)

    assert restored == uploaded
    assert fresh_service.bytes_for(uploaded.document_id).startswith(b"%PDF-")


def test_mark_persists_changes(monkeypatch, tmp_path):
    monkeypatch.setattr(
        settings,
        "storage_root",
        str(tmp_path / "private-documents"),
    )
    service = DocumentService()
    uploaded = asyncio.run(service.upload(pdf_upload()))

    service.mark(
        uploaded.document_id,
        status="extracted",
        invoice_id="invoice-123",
    )

    fresh_service = DocumentService()
    restored = fresh_service.get(uploaded.document_id)

    assert restored.status == "extracted"
    assert restored.invoice_id == "invoice-123"


def test_unknown_document_id_returns_404_through_api():
    response = TestClient(app).get(
        "/api/documents/does-not-exist"
    )

    assert response.status_code == 404
    assert response.json() == {"detail": "Document not found"}