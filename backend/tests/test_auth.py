import sqlite3
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app.api.dependencies import _auth_service
from app.core.config import Settings, settings
from app.core.security import hash_password, hash_session_token, verify_password
from app.main import app
from app.services.auth_service import AuthService, AuthStore


AUTH_COOKIE = "billsetu_session"
FRONTEND_ORIGIN = "http://localhost:4173"


@pytest.fixture
def client(monkeypatch, tmp_path) -> TestClient:
    database_path = str(tmp_path / "auth.sqlite3")
    monkeypatch.setattr(settings, "auth_database_path", database_path)
    monkeypatch.setattr(settings, "auth_session_ttl_seconds", 3600)
    monkeypatch.setattr(settings, "auth_cookie_secure", False)
    _auth_service.cache_clear()
    with TestClient(app) as test_client:
        yield test_client
    _auth_service.cache_clear()


def register(client: TestClient, email: str = "person@example.com") -> dict:
    response = client.post(
        "/api/auth/register",
        json={"email": email, "password": "correct horse battery"},
    )
    assert response.status_code == 201
    return response.json()


def test_registration_normalizes_email_and_returns_no_secrets(client, tmp_path):
    response = client.post(
        "/api/auth/register",
        json={"email": " Person@Example.COM ", "password": "correct horse battery"},
    )

    assert response.status_code == 201
    payload = response.json()
    assert payload["email"] == "person@example.com"
    assert set(payload) == {"id", "email", "created_at", "updated_at", "is_active"}
    assert client.cookies.get(AUTH_COOKIE)
    assert client.cookies.get(AUTH_COOKIE) not in response.text

    database_path = tmp_path / "auth.sqlite3"
    with sqlite3.connect(database_path) as connection:
        stored_email, password_hash = connection.execute(
            "SELECT email, password_hash FROM users WHERE id = ?",
            (payload["id"],),
        ).fetchone()
        stored_session_hash = connection.execute(
            "SELECT session_id_hash FROM sessions WHERE user_id = ?",
            (payload["id"],),
        ).fetchone()[0]

    assert stored_email == "person@example.com"
    assert password_hash != "correct horse battery"
    assert verify_password("correct horse battery", password_hash)
    assert client.cookies.get(AUTH_COOKIE) not in stored_session_hash
    database_contents = database_path.read_bytes()
    assert b"correct horse battery" not in database_contents
    assert client.cookies.get(AUTH_COOKIE).encode() not in database_contents


def test_duplicate_registration_is_case_insensitive(client):
    register(client)

    response = client.post(
        "/api/auth/register",
        json={"email": "PERSON@EXAMPLE.COM", "password": "correct horse battery"},
    )

    assert response.status_code == 409


def test_registration_rejects_invalid_email_and_short_password(client):
    invalid_email = client.post(
        "/api/auth/register",
        json={"email": "not-an-email", "password": "correct horse battery"},
    )
    short_password = client.post(
        "/api/auth/register",
        json={"email": "person@example.com", "password": "short"},
    )

    assert invalid_email.status_code == 422
    assert short_password.status_code == 422


def test_scrypt_uses_unique_salts_and_malformed_hashes_fail_safely():
    first_hash = hash_password("correct horse battery")
    second_hash = hash_password("correct horse battery")

    assert first_hash != second_hash
    assert verify_password("correct horse battery", first_hash)
    assert not verify_password("wrong password", first_hash)
    assert not verify_password("correct horse battery", "malformed")
    assert not verify_password("correct horse battery", None)


def test_login_creates_fresh_cookie_session_and_rejects_bad_credentials(client):
    user = register(client)
    first_token = client.cookies.get(AUTH_COOKIE)

    response = client.post(
        "/api/auth/login",
        json={"email": "PERSON@example.com", "password": "correct horse battery"},
    )
    second_token = client.cookies.get(AUTH_COOKIE)

    assert response.status_code == 200
    assert response.json()["id"] == user["id"]
    assert first_token != second_token
    assert second_token not in response.text
    assert client.get("/api/auth/me").status_code == 200

    wrong_password = client.post(
        "/api/auth/login",
        json={"email": "person@example.com", "password": "incorrect password"},
    )
    unknown_user = client.post(
        "/api/auth/login",
        json={"email": "missing@example.com", "password": "incorrect password"},
    )
    assert wrong_password.status_code == unknown_user.status_code == 401
    assert wrong_password.json() == unknown_user.json()


def test_me_rejects_missing_and_invalid_sessions(client):
    assert client.get("/api/auth/me").status_code == 401

    client.cookies.set(AUTH_COOKIE, "invalid-session-token")
    assert client.get("/api/auth/me").status_code == 401


def test_me_rejects_expired_and_revoked_sessions(client, tmp_path):
    register(client)
    token = client.cookies.get(AUTH_COOKIE)
    database_path = tmp_path / "auth.sqlite3"
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            "UPDATE sessions SET expires_at = ? WHERE session_id_hash = ?",
            ("2000-01-01T00:00:00+00:00", hash_session_token(token)),
        )
    assert client.get("/api/auth/me").status_code == 401

    client.post("/api/auth/logout")
    register(client, "second@example.com")
    token = client.cookies.get(AUTH_COOKIE)
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            "UPDATE sessions SET revoked_at = ? WHERE session_id_hash = ?",
            (datetime.now(timezone.utc).isoformat(), hash_session_token(token)),
        )
    assert client.get("/api/auth/me").status_code == 401


def test_me_rejects_inactive_users(client, tmp_path):
    register(client)
    database_path = tmp_path / "auth.sqlite3"
    with sqlite3.connect(database_path) as connection:
        connection.execute("UPDATE users SET is_active = 0")

    assert client.get("/api/auth/me").status_code == 401


def test_logout_revokes_session_and_persists_auth_across_store_instances(client, tmp_path):
    user = register(client)
    token = client.cookies.get(AUTH_COOKIE)

    persistent_service = AuthService(AuthStore(str(tmp_path / "auth.sqlite3")), 3600)
    assert persistent_service.current_user(token).id == user["id"]

    response = client.post("/api/auth/logout")

    assert response.status_code == 200
    assert response.json() == {"status": "logged_out"}
    assert client.get("/api/auth/me").status_code == 401
    assert persistent_service.current_user(token) is None


def test_cookie_attributes_follow_secure_setting(client, monkeypatch):
    response = client.post(
        "/api/auth/register",
        json={"email": "person@example.com", "password": "correct horse battery"},
    )
    cookie = response.headers["set-cookie"].lower()

    assert "httponly" in cookie
    assert "samesite=lax" in cookie
    assert "max-age=3600" in cookie
    assert "secure" not in cookie

    monkeypatch.setattr(settings, "auth_cookie_secure", True)
    secure_response = client.post(
        "/api/auth/register",
        json={"email": "secure@example.com", "password": "correct horse battery"},
    )
    assert "secure" in secure_response.headers["set-cookie"].lower()


def test_auth_cookie_flow_is_credentialed_for_configured_frontend_origin(client):
    registration = client.post(
        "/api/auth/register",
        json={"email": "person@example.com", "password": "correct horse battery"},
        headers={"Origin": FRONTEND_ORIGIN},
    )
    current_user = client.get(
        "/api/auth/me",
        headers={"Origin": FRONTEND_ORIGIN},
    )

    assert registration.status_code == 201
    assert registration.headers["access-control-allow-origin"] == FRONTEND_ORIGIN
    assert registration.headers["access-control-allow-credentials"] == "true"
    assert "httponly" in registration.headers["set-cookie"].lower()
    assert current_user.status_code == 200
    assert current_user.headers["access-control-allow-origin"] == FRONTEND_ORIGIN
    assert current_user.headers["access-control-allow-credentials"] == "true"


def test_cookie_secure_default_is_environment_aware(monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.delenv("AUTH_COOKIE_SECURE", raising=False)
    assert Settings().auth_cookie_secure is False

    monkeypatch.setenv("APP_ENV", "production")
    assert Settings().auth_cookie_secure is True

    monkeypatch.setenv("AUTH_COOKIE_SECURE", "false")
    assert Settings().auth_cookie_secure is False


def test_credentialed_cors_rejects_wildcard_origins():
    with pytest.raises(ValueError, match="explicit origins"):
        Settings(cors_allowed_origins=["*"])


def test_existing_invoice_and_document_routes_require_authentication(client):
    # Phase 8B-6: the request-body-only validation endpoint stays open because it
    # touches no persistent record; document records now require a session.
    invoice_response = client.post(
        "/api/invoices/validate",
        json={"invoice": {"invoice_number": "invalid"}},
    )
    document_response = client.get("/api/documents/unknown-document")

    assert invoice_response.status_code != 401
    assert document_response.status_code == 401
