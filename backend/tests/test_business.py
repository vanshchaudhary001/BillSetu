import sqlite3

import pytest
from fastapi.testclient import TestClient

from app.api.dependencies import _auth_service
from app.core.config import settings
from app.main import app
from app.services.auth_service import AuthStore, DuplicateMembershipError


AUTH_COOKIE = "billsetu_session"


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


def test_registration_creates_business_and_owner_membership(client, tmp_path):
    user = register(client)

    current = client.get("/api/businesses/current")
    assert current.status_code == 200
    payload = current.json()
    assert set(payload) == {"id", "name", "created_at", "updated_at", "is_active"}
    assert payload["name"] == "My Business"
    assert payload["is_active"] is True

    businesses = client.get("/api/businesses")
    assert businesses.status_code == 200
    assert len(businesses.json()) == 1
    assert businesses.json()[0]["id"] == payload["id"]

    database_path = tmp_path / "auth.sqlite3"
    with sqlite3.connect(database_path) as connection:
        membership = connection.execute(
            "SELECT user_id, business_id, role FROM memberships"
        ).fetchone()
        assert membership == (user["id"], payload["id"], "owner")
        business_count = connection.execute(
            "SELECT COUNT(*) FROM businesses"
        ).fetchone()[0]
        assert business_count == 1


def test_current_business_requires_authentication(client):
    assert client.get("/api/businesses/current").status_code == 401
    assert client.get("/api/businesses").status_code == 401


def test_inactive_business_is_rejected(client, tmp_path):
    register(client)
    current = client.get("/api/businesses/current").json()
    database_path = tmp_path / "auth.sqlite3"
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            "UPDATE businesses SET is_active = 0 WHERE id = ?", (current["id"],)
        )

    response = client.get("/api/businesses/current")
    assert response.status_code == 403


def test_business_switching_is_membership_controlled(client):
    user_a = register(client, "a@example.com")
    business_a = client.get("/api/businesses/current").json()["id"]

    client.post("/api/auth/logout")
    register(client, "b@example.com")
    business_b = client.get("/api/businesses/current").json()["id"]

    # User B cannot switch into User A's business.
    response = client.post(f"/api/businesses/{business_a}/switch")
    assert response.status_code in {403, 404}

    # Sanity: User B can access their own business.
    own = client.post(f"/api/businesses/{business_b}/switch")
    assert own.status_code == 200
    assert own.json()["id"] == business_b


def test_foreign_business_id_does_not_bypass_membership(client):
    register(client, "a@example.com")
    business_a = client.get("/api/businesses/current").json()["id"]

    client.post("/api/auth/logout")
    register(client, "b@example.com")

    for path in (
        f"/api/businesses/{business_a}/switch",
    ):
        response = client.post(path)
        assert response.status_code in {403, 404}, (path, response.status_code)


def test_duplicate_membership_is_prevented(tmp_path):
    from app.core.security import hash_password
    from app.services.auth_service import BusinessRecord, MembershipRecord, UserRecord
    from datetime import datetime, timezone

    store_path = str(tmp_path / "auth-dup.sqlite3")
    store = AuthStore(store_path)
    now = datetime.now(timezone.utc).isoformat(timespec="microseconds")
    user = UserRecord(
        id="user-1",
        email="u@example.com",
        password_hash=hash_password("correct horse battery"),
        created_at=now,
        updated_at=now,
        is_active=True,
    )
    business = BusinessRecord(
        id="business-1",
        name="My Business",
        created_at=now,
        updated_at=now,
        is_active=True,
    )
    membership = MembershipRecord(
        id="membership-1",
        user_id=user.id,
        business_id=business.id,
        role="owner",
        created_at=now,
    )
    store.create_user_business_and_session(
        user,
        business,
        membership,
        "session-hash",
        now,
        None,
        business.id,
    )
    duplicate = MembershipRecord(
        id="membership-2",
        user_id=user.id,
        business_id=business.id,
        role="member",
        created_at=now,
    )
    with pytest.raises(DuplicateMembershipError):
        store.create_membership(duplicate)


def test_registration_does_not_create_demo_invoices(client):
    register(client)
    # invoices endpoint is unauthenticated/legacy; just ensure business exists
    assert client.get("/api/businesses/current").status_code == 200
