from fastapi.testclient import TestClient

from app.main import app


def test_validation_api_returns_typed_response(clean_invoice):
    response = TestClient(app).post("/api/invoices/validate", json={"invoice": clean_invoice.model_dump(mode="json")})
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "validated"
    assert payload["gstr1_bucket"] == "b2b"
    assert payload["export_ready"] is True
    assert payload["confidence"][0]["band"] == "high"
