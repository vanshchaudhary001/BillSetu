import pytest
from fastapi.testclient import TestClient
from PIL import Image
from io import BytesIO

from app.api.routes import documents as documents_routes
from app.core.config import settings
from app.main import app
from app.services.document_service import DocumentService

FRONTEND_ORIGIN = "http://localhost:4173"
LOOPBACK_ORIGIN = "http://127.0.0.1:4173"
UNAPPROVED_ORIGIN = "http://evil.example"


def png_bytes() -> bytes:
    image = Image.new("RGB", (32, 32), "white")
    stream = BytesIO()
    image.save(stream, format="PNG")
    return stream.getvalue()


@pytest.fixture
def client(monkeypatch, tmp_path) -> TestClient:
    monkeypatch.setattr(settings, "storage_root", str(tmp_path / "private-documents"))
    monkeypatch.setattr(documents_routes, "documents", DocumentService())
    return TestClient(app)


def preflight(client: TestClient, path: str, origin: str, method: str, headers: str):
    return client.options(
        path,
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": headers,
        },
    )


def test_allowed_origin_receives_cors_headers(client):
    response = client.get("/health", headers={"Origin": FRONTEND_ORIGIN})

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == FRONTEND_ORIGIN
    assert response.headers["access-control-allow-origin"] != "*"


def test_export_filename_header_is_readable_by_browser(client):
    response = client.get("/health", headers={"Origin": FRONTEND_ORIGIN})

    exposed = response.headers.get("access-control-expose-headers", "").lower()
    assert "content-disposition" in exposed


def test_loopback_origin_is_allowed(client):
    response = client.get("/health", headers={"Origin": LOOPBACK_ORIGIN})

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == LOOPBACK_ORIGIN


def test_preflight_succeeds_for_upload_route(client):
    response = preflight(
        client, "/api/documents/upload", FRONTEND_ORIGIN, "POST", "content-type"
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == FRONTEND_ORIGIN
    assert "POST" in response.headers["access-control-allow-methods"]
    assert "content-type" in response.headers["access-control-allow-headers"].lower()


def test_preflight_succeeds_for_validate_route(client):
    response = preflight(
        client, "/api/invoices/validate", LOOPBACK_ORIGIN, "POST", "content-type, authorization"
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == LOOPBACK_ORIGIN
    allowed_headers = response.headers["access-control-allow-headers"].lower()
    assert "content-type" in allowed_headers
    assert "authorization" in allowed_headers
    assert "access-control-allow-credentials" not in response.headers


def test_unapproved_origin_is_rejected(client):
    simple = client.get("/health", headers={"Origin": UNAPPROVED_ORIGIN})
    assert simple.status_code == 200
    assert "access-control-allow-origin" not in simple.headers

    rejected = preflight(
        client, "/api/invoices/validate", UNAPPROVED_ORIGIN, "POST", "content-type"
    )
    assert rejected.status_code == 400
    assert "access-control-allow-origin" not in rejected.headers


def test_validation_api_unchanged_with_origin(client, clean_invoice):
    response = client.post(
        "/api/invoices/validate",
        json={"invoice": clean_invoice.model_dump(mode="json")},
        headers={"Origin": FRONTEND_ORIGIN},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "validated"
    assert payload["export_ready"] is True
    assert response.headers["access-control-allow-origin"] == FRONTEND_ORIGIN


def test_multipart_upload_works_from_frontend_origin(client):
    response = client.post(
        "/api/documents/upload",
        files={"file": ("invoice.png", png_bytes(), "image/png")},
        headers={"Origin": FRONTEND_ORIGIN},
    )

    assert response.status_code == 201
    assert response.headers["access-control-allow-origin"] == FRONTEND_ORIGIN
    record = response.json()
    assert record["status"] == "uploaded"
    assert record["media_type"] == "image/jpeg"
    assert record["document_id"]


def test_upload_errors_still_return_cors_headers(client):
    response = client.post(
        "/api/documents/upload",
        files={"file": ("invoice.exe", b"MZ\x00", "application/octet-stream")},
        headers={"Origin": FRONTEND_ORIGIN},
    )

    assert response.status_code == 415
    assert response.headers["access-control-allow-origin"] == FRONTEND_ORIGIN
