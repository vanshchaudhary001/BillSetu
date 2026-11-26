from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sqlite3
from typing import Iterator
from uuid import uuid4

from app.core.security import (
    generate_session_token,
    hash_password,
    hash_session_token,
    verify_password,
)


@dataclass(frozen=True)
class UserRecord:
    id: str
    email: str
    password_hash: str
    created_at: str
    updated_at: str
    is_active: bool


@dataclass(frozen=True)
class BusinessRecord:
    id: str
    name: str
    created_at: str
    updated_at: str
    is_active: bool


@dataclass(frozen=True)
class MembershipRecord:
    id: str
    user_id: str
    business_id: str
    role: str
    created_at: str


class DuplicateEmailError(Exception):
    pass


class InvalidCredentialsError(Exception):
    pass


class BusinessNotFoundError(Exception):
    pass


class BusinessAccessDeniedError(Exception):
    pass


class InactiveBusinessError(Exception):
    pass


class DuplicateMembershipError(Exception):
    pass


def normalize_email(email: str) -> str:
    return email.strip().casefold()


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def timestamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="microseconds")


class AuthStore:
    def __init__(self, database_path: str) -> None:
        self._database_path = Path(database_path)
        self._database_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self._database_path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self._connection() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    email TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    is_active INTEGER NOT NULL CHECK (is_active IN (0, 1))
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS sessions (
                    session_id_hash TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    revoked_at TEXT,
                    active_business_id TEXT REFERENCES businesses(id)
                )
                """
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id)"
            )
            # Backwards-compatible migration for databases created before the
            # active-business column existed.
            session_columns = {
                row["name"] for row in connection.execute("PRAGMA table_info(sessions)").fetchall()
            }
            if "active_business_id" not in session_columns:
                connection.execute(
                    "ALTER TABLE sessions ADD COLUMN active_business_id TEXT REFERENCES businesses(id)"
                )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS businesses (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    is_active INTEGER NOT NULL CHECK (is_active IN (0, 1))
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS memberships (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
                    role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
                    created_at TEXT NOT NULL,
                    UNIQUE (user_id, business_id)
                )
                """
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS memberships_user_id_idx ON memberships(user_id)"
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS memberships_business_id_idx ON memberships(business_id)"
            )

    def create_user_and_session(
        self,
        user: UserRecord,
        session_id_hash: str,
        expires_at: str,
        previous_session_id_hash: str | None,
        active_business_id: str | None = None,
    ) -> None:
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute(
                    """
                    INSERT INTO users (id, email, password_hash, created_at, updated_at, is_active)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        user.id,
                        user.email,
                        user.password_hash,
                        user.created_at,
                        user.updated_at,
                        int(user.is_active),
                    ),
                )
            except sqlite3.IntegrityError as error:
                if "users.email" in str(error):
                    raise DuplicateEmailError from error
                raise
            self._rotate_session(
                connection,
                session_id_hash,
                user.id,
                user.created_at,
                expires_at,
                previous_session_id_hash,
                active_business_id,
            )

    def create_user_business_and_session(
        self,
        user: UserRecord,
        business: BusinessRecord,
        membership: MembershipRecord,
        session_id_hash: str,
        expires_at: str,
        previous_session_id_hash: str | None,
        active_business_id: str | None = None,
    ) -> None:
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute(
                    """
                    INSERT INTO users (id, email, password_hash, created_at, updated_at, is_active)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        user.id,
                        user.email,
                        user.password_hash,
                        user.created_at,
                        user.updated_at,
                        int(user.is_active),
                    ),
                )
            except sqlite3.IntegrityError as error:
                if "users.email" in str(error):
                    raise DuplicateEmailError from error
                raise
            try:
                connection.execute(
                    """
                    INSERT INTO businesses (id, name, created_at, updated_at, is_active)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        business.id,
                        business.name,
                        business.created_at,
                        business.updated_at,
                        int(business.is_active),
                    ),
                )
            except sqlite3.IntegrityError as error:
                raise
            try:
                connection.execute(
                    """
                    INSERT INTO memberships (id, user_id, business_id, role, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        membership.id,
                        membership.user_id,
                        membership.business_id,
                        membership.role,
                        membership.created_at,
                    ),
                )
            except sqlite3.IntegrityError as error:
                if "memberships.user_id, memberships.business_id" in str(error) or "UNIQUE" in str(error).upper():
                    raise DuplicateMembershipError from error
                raise
            self._rotate_session(
                connection,
                session_id_hash,
                user.id,
                user.created_at,
                expires_at,
                previous_session_id_hash,
                active_business_id if active_business_id is not None else business.id,
            )

    def create_membership(self, membership: MembershipRecord) -> None:
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute(
                    """
                    INSERT INTO memberships (id, user_id, business_id, role, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        membership.id,
                        membership.user_id,
                        membership.business_id,
                        membership.role,
                        membership.created_at,
                    ),
                )
            except sqlite3.IntegrityError as error:
                if "UNIQUE" in str(error).upper():
                    raise DuplicateMembershipError from error
                raise

    def create_business_with_owner(
        self,
        business: BusinessRecord,
        membership: MembershipRecord,
    ) -> None:
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                """
                INSERT INTO businesses (id, name, created_at, updated_at, is_active)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    business.id,
                    business.name,
                    business.created_at,
                    business.updated_at,
                    int(business.is_active),
                ),
            )
            try:
                connection.execute(
                    """
                    INSERT INTO memberships (id, user_id, business_id, role, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        membership.id,
                        membership.user_id,
                        membership.business_id,
                        membership.role,
                        membership.created_at,
                    ),
                )
            except sqlite3.IntegrityError as error:
                if "UNIQUE" in str(error).upper():
                    raise DuplicateMembershipError from error
                raise

    def create_session(
        self,
        user_id: str,
        session_id_hash: str,
        created_at: str,
        expires_at: str,
        previous_session_id_hash: str | None,
        active_business_id: str | None = None,
    ) -> None:
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._rotate_session(
                connection,
                session_id_hash,
                user_id,
                created_at,
                expires_at,
                previous_session_id_hash,
                active_business_id,
            )

    @staticmethod
    def _rotate_session(
        connection: sqlite3.Connection,
        session_id_hash: str,
        user_id: str,
        created_at: str,
        expires_at: str,
        previous_session_id_hash: str | None,
        active_business_id: str | None = None,
    ) -> None:
        if previous_session_id_hash:
            connection.execute(
                """
                UPDATE sessions SET revoked_at = ?
                WHERE session_id_hash = ? AND revoked_at IS NULL
                """,
                (created_at, previous_session_id_hash),
            )
        connection.execute(
            """
            INSERT INTO sessions (session_id_hash, user_id, created_at, expires_at, revoked_at, active_business_id)
            VALUES (?, ?, ?, ?, NULL, ?)
            """,
            (session_id_hash, user_id, created_at, expires_at, active_business_id),
        )

    def get_user_by_email(self, email: str) -> UserRecord | None:
        with self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM users WHERE email = ?",
                (email,),
            ).fetchone()
        return self._user_from_row(row) if row else None

    def get_user_for_session(self, session_id_hash: str, now: str) -> UserRecord | None:
        with self._connection() as connection:
            row = connection.execute(
                """
                SELECT users.*
                FROM sessions
                JOIN users ON users.id = sessions.user_id
                WHERE sessions.session_id_hash = ?
                  AND sessions.revoked_at IS NULL
                  AND sessions.expires_at > ?
                """,
                (session_id_hash, now),
            ).fetchone()
        return self._user_from_row(row) if row else None

    def revoke_session(self, session_id_hash: str, revoked_at: str) -> None:
        with self._connection() as connection:
            connection.execute(
                """
                UPDATE sessions SET revoked_at = ?
                WHERE session_id_hash = ? AND revoked_at IS NULL
                """,
                (revoked_at, session_id_hash),
            )

    def get_business(self, business_id: str) -> BusinessRecord | None:
        with self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM businesses WHERE id = ?",
                (business_id,),
            ).fetchone()
        return self._business_from_row(row) if row else None

    def list_businesses_for_user(self, user_id: str) -> list[BusinessRecord]:
        with self._connection() as connection:
            rows = connection.execute(
                """
                SELECT businesses.*
                FROM businesses
                JOIN memberships ON memberships.business_id = businesses.id
                WHERE memberships.user_id = ?
                ORDER BY memberships.created_at ASC, businesses.created_at ASC
                """,
                (user_id,),
            ).fetchall()
        return [self._business_from_row(row) for row in rows]

    def get_membership(self, user_id: str, business_id: str) -> MembershipRecord | None:
        with self._connection() as connection:
            row = connection.execute(
                """
                SELECT * FROM memberships
                WHERE user_id = ? AND business_id = ?
                """,
                (user_id, business_id),
            ).fetchone()
        return self._membership_from_row(row) if row else None

    def list_memberships_for_user(self, user_id: str) -> list[MembershipRecord]:
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT * FROM memberships WHERE user_id = ? ORDER BY created_at ASC",
                (user_id,),
            ).fetchall()
        return [self._membership_from_row(row) for row in rows]

    def list_memberships_for_business(self, business_id: str) -> list[MembershipRecord]:
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT * FROM memberships WHERE business_id = ? ORDER BY created_at ASC",
                (business_id,),
            ).fetchall()
        return [self._membership_from_row(row) for row in rows]

    def get_active_business_id_for_session(
        self, session_id_hash: str, now: str
    ) -> str | None:
        with self._connection() as connection:
            row = connection.execute(
                """
                SELECT active_business_id
                FROM sessions
                WHERE session_id_hash = ?
                  AND revoked_at IS NULL
                  AND expires_at > ?
                """,
                (session_id_hash, now),
            ).fetchone()
        return row["active_business_id"] if row else None

    def set_session_active_business(
        self, session_id_hash: str, business_id: str, now: str
    ) -> int:
        with self._connection() as connection:
            cursor = connection.execute(
                """
                UPDATE sessions
                SET active_business_id = ?
                WHERE session_id_hash = ?
                  AND revoked_at IS NULL
                  AND expires_at > ?
                """,
                (business_id, session_id_hash, now),
            )
            return cursor.rowcount

    @staticmethod
    def _business_from_row(row: sqlite3.Row) -> BusinessRecord:
        return BusinessRecord(
            id=row["id"],
            name=row["name"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            is_active=bool(row["is_active"]),
        )

    @staticmethod
    def _membership_from_row(row: sqlite3.Row) -> MembershipRecord:
        return MembershipRecord(
            id=row["id"],
            user_id=row["user_id"],
            business_id=row["business_id"],
            role=row["role"],
            created_at=row["created_at"],
        )

    @staticmethod
    def _user_from_row(row: sqlite3.Row) -> UserRecord:
        return UserRecord(
            id=row["id"],
            email=row["email"],
            password_hash=row["password_hash"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            is_active=bool(row["is_active"]),
        )


class AuthService:
    def __init__(self, store: AuthStore, session_ttl_seconds: int) -> None:
        self._store = store
        self._session_ttl = timedelta(seconds=session_ttl_seconds)

    def register(
        self,
        email: str,
        password: str,
        previous_session_token: str | None = None,
    ) -> tuple[UserRecord, str]:
        normalized_email = normalize_email(email)
        current_time = utc_now()
        current_timestamp = timestamp(current_time)
        session_token = generate_session_token()
        user = UserRecord(
            id=str(uuid4()),
            email=normalized_email,
            password_hash=hash_password(password),
            created_at=current_timestamp,
            updated_at=current_timestamp,
            is_active=True,
        )
        business = BusinessRecord(
            id=str(uuid4()),
            name="My Business",
            created_at=current_timestamp,
            updated_at=current_timestamp,
            is_active=True,
        )
        membership = MembershipRecord(
            id=str(uuid4()),
            user_id=user.id,
            business_id=business.id,
            role="owner",
            created_at=current_timestamp,
        )
        self._store.create_user_business_and_session(
            user,
            business,
            membership,
            hash_session_token(session_token),
            timestamp(current_time + self._session_ttl),
            hash_session_token(previous_session_token) if previous_session_token else None,
            business.id,
        )
        return user, session_token

    def login(
        self,
        email: str,
        password: str,
        previous_session_token: str | None = None,
    ) -> tuple[UserRecord, str]:
        user = self._store.get_user_by_email(normalize_email(email))
        if user is None:
            verify_password(password, _DUMMY_PASSWORD_HASH)
            raise InvalidCredentialsError
        password_is_valid = verify_password(password, user.password_hash)
        if not password_is_valid or not user.is_active:
            raise InvalidCredentialsError

        current_time = utc_now()
        session_token = generate_session_token()
        active_business_id = None
        memberships = self._store.list_memberships_for_user(user.id)
        if memberships:
            businesses = {
                business.id: business
                for business in (
                    self._store.get_business(membership.business_id)
                    for membership in memberships
                )
                if business is not None
            }
            for membership in memberships:
                business = businesses.get(membership.business_id)
                if business is not None and business.is_active:
                    active_business_id = business.id
                    break
        self._store.create_session(
            user.id,
            hash_session_token(session_token),
            timestamp(current_time),
            timestamp(current_time + self._session_ttl),
            hash_session_token(previous_session_token) if previous_session_token else None,
            active_business_id,
        )
        return user, session_token

    def current_user(self, session_token: str | None) -> UserRecord | None:
        if not session_token:
            return None
        return self._store.get_user_for_session(
            hash_session_token(session_token),
            timestamp(utc_now()),
        )

    def logout(self, session_token: str | None) -> None:
        if session_token:
            self._store.revoke_session(
                hash_session_token(session_token),
                timestamp(utc_now()),
            )

    def current_business(
        self, user: UserRecord, session_token: str | None = None
    ) -> BusinessRecord:
        now = timestamp(utc_now())
        active_business_id = None
        if session_token:
            active_business_id = self._store.get_active_business_id_for_session(
                hash_session_token(session_token), now
            )
        if active_business_id:
            membership = self._store.get_membership(user.id, active_business_id)
            business = self._store.get_business(active_business_id)
            if membership is not None and business is not None:
                if not business.is_active:
                    raise InactiveBusinessError
                return business
        memberships = self._store.list_memberships_for_user(user.id)
        for membership in memberships:
            business = self._store.get_business(membership.business_id)
            if business is not None and business.is_active:
                if session_token:
                    self._store.set_session_active_business(
                        hash_session_token(session_token), business.id, now
                    )
                return business
        raise BusinessNotFoundError

    def list_businesses(self, user: UserRecord) -> list[BusinessRecord]:
        return self._store.list_businesses_for_user(user.id)

    def get_membership(
        self, user_id: str, business_id: str
    ) -> MembershipRecord | None:
        return self._store.get_membership(user_id, business_id)

    def create_business(
        self,
        user: UserRecord,
        name: str,
        session_token: str | None = None,
    ) -> BusinessRecord:
        normalized_name = (name or "").strip()
        if not normalized_name:
            raise ValueError("Business name is required.")
        current_time = utc_now()
        current_timestamp = timestamp(current_time)
        business = BusinessRecord(
            id=str(uuid4()),
            name=normalized_name,
            created_at=current_timestamp,
            updated_at=current_timestamp,
            is_active=True,
        )
        membership = MembershipRecord(
            id=str(uuid4()),
            user_id=user.id,
            business_id=business.id,
            role="owner",
            created_at=current_timestamp,
        )
        self._store.create_business_with_owner(business, membership)
        if session_token:
            self._store.set_session_active_business(
                hash_session_token(session_token), business.id, timestamp(utc_now())
            )
        return business

    def switch_business(
        self,
        user: UserRecord,
        business_id: str,
        session_token: str | None,
    ) -> BusinessRecord:
        membership = self._store.get_membership(user.id, business_id)
        if membership is None:
            raise BusinessAccessDeniedError
        business = self._store.get_business(business_id)
        if business is None:
            raise BusinessNotFoundError
        if not business.is_active:
            raise InactiveBusinessError
        if session_token:
            updated = self._store.set_session_active_business(
                hash_session_token(session_token), business_id, timestamp(utc_now())
            )
            if updated == 0:
                raise BusinessAccessDeniedError
        return business

    def require_membership(
        self, user_id: str, business_id: str
    ) -> MembershipRecord:
        membership = self._store.get_membership(user_id, business_id)
        if membership is None:
            raise BusinessAccessDeniedError
        business = self._store.get_business(business_id)
        if business is None:
            raise BusinessNotFoundError
        if not business.is_active:
            raise InactiveBusinessError
        return membership


_DUMMY_PASSWORD_HASH = hash_password("not-a-real-account-password")
