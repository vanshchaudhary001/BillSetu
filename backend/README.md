# BillSetu backend

BillSetu's backend is a modular FastAPI service for document preparation and GST pre-flight validation. It contains a strict canonical invoice model, independent deterministic GST rules, calibrated field confidence, secure local document normalization, and a replaceable Gemini extraction adapter. Local document storage is an MVP adapter; Supabase private Storage and RLS are the next persistence milestone.

## Run

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Backend: `http://localhost:8000` (or `http://127.0.0.1:8000`). Open `http://localhost:8000/docs` for the frontend-facing OpenAPI contract. Run tests with:

```powershell
python -m pytest -q
```

## API surface

- `POST /api/auth/register` creates a user and starts a server-side session.
- `POST /api/auth/login` verifies credentials and creates a fresh session.
- `GET /api/auth/me` returns the authenticated user's safe public fields.
- `POST /api/auth/logout` revokes the current session.
- `POST /api/invoices/validate` accepts canonical invoice JSON and returns validation issues, GSTR-1 bucket, confidence, and export readiness.
- `POST /api/documents/upload` validates, normalizes, hashes, and stores an allowed document using a generated server-side filename.
- `GET /api/documents/{document_id}` returns the document security record.
- `POST /api/documents/{document_id}/extract` sends a non-quarantined document through the Gemini adapter, validates the structured Pydantic invoice, and runs deterministic validation.
- `GET /api/invoices/{invoice_id}` returns the canonical invoice produced by extraction.
- `POST /api/invoices/{invoice_id}/validate` reruns deterministic validation.
- `GET /api/invoices/{invoice_id}/gstr1` returns the internal normalized GSTR-1 representation (not an official filing payload).
- `GET /api/invoices/{invoice_id}/audit` and `GET /api/documents/{document_id}/audit` return the internal processing history.
- `GET /api/invoices/{invoice_id}/export/json` and `/export/csv` return in-memory downloads, but only when the existing validation result has `export_ready` true (otherwise `409`).

## Frontend integration and authentication foundation

The React/Vite frontend runs separately, e.g. at `http://localhost:4173`. The backend allows exactly those development origins by default and sends CORS headers on success and error responses:

| Item | Value |
| --- | --- |
| Backend | `http://localhost:8000` |
| Swagger UI | `http://localhost:8000/docs` |
| Frontend development origin | `http://localhost:4173` (also `http://127.0.0.1:4173`) |
| Allowed methods | `GET`, `POST` |
| Allowed request headers | `Content-Type`, `Authorization` |
| Exposed response header | `Content-Disposition` (so the browser can read export filenames) |
| Credentials | allowed only for explicitly configured origins |

Override the origins with `CORS_ALLOWED_ORIGINS=http://localhost:4173,https://your-host` in the environment. Keep it an explicit list; a wildcard is not configured.

Auth users and sessions are stored in the separate SQLite database at `.data/auth.sqlite3` by default; this directory is ignored by Git. Configure `AUTH_DATABASE_PATH` to change it and `AUTH_SESSION_TTL_SECONDS` to change the default 12-hour session lifetime. `AUTH_COOKIE_NAME` defaults to `billsetu_session`. Passwords are stored as salted scrypt hashes. Session tokens are opaque, stored only as SHA-256 hashes in SQLite, and sent to the browser only in an HttpOnly, SameSite=Lax cookie. `Secure` is disabled by default for local development and enabled when `APP_ENV=production`; set `AUTH_COOKIE_SECURE` to explicitly override it. The next frontend-auth phase must use credentialed requests (`credentials: "include"`). Invoice and document endpoints that read or write a persistent record require this session (Phase 8B-6); see *Authorization enforcement* below.

## Business ownership of application records

Businesses and memberships live in the auth SQLite database. Invoices, documents and audit events stay in the existing JSON files (`invoices.json`, `documents.json`, `audit_events.json`) in the storage data directory, now with an explicit `business_id` association:

| Record | Storage | Ownership |
| --- | --- | --- |
| Invoice | `invoices.json` (`{"schema_version": 2, "records": {id: {"business_id", "invoice"}}}`) | `business_id` envelope field |
| Document | `documents.json` (`{id: {"record", "storage_path"}}`) | `record.business_id` |
| Audit event | `audit_events.json` (list) | `business_id` |

Ownership always comes from the authenticated session, never from a request body, query parameter or path. The only endpoint that creates a record is `POST /api/documents/upload`, and it derives the owner from the active business; there is no code path that accepts a caller-supplied owner. An invoice inherits the ownership of its source document, and extraction cannot cross a business boundary.

### Authorization enforcement (Phase 8B-6)

Every request to a persistent record resolves through one chain:

```
session cookie -> user -> active business -> membership -> business-scoped record
```

| Situation | Response |
| --- | --- |
| No or expired session | `401` |
| Session valid, but no usable active business (no membership, or inactive business) | `403` |
| Record belongs to another business, or does not exist, or is a legacy unowned record | `404` (identical body in all three cases) |

Record lookups are business-scoped operations in the service layer (`DocumentService.get_owned`, `ExtractionService.invoice_owned`), so the owner is part of the lookup rather than a check performed after an unscoped read. `GET /api/invoices` and `GET /api/documents` list only the active business's records.

`POST /api/invoices/validate` stays unauthenticated: it validates the request body only and touches no stored record. `POST /api/invoices/{invoice_id}/validate` operates on a stored invoice and is scoped like every other record endpoint.

Legacy records (`business_id: null`) are never claimed, assigned or listed. Through the business-scoped API they behave exactly like records that do not exist.

At startup the backend runs `app.storage.migrate_persistent_storage`, which normalises pre-8B-5 data: legacy invoices are wrapped in the owned envelope with `business_id: null`, and document/audit records gain an explicit `null` owner. Original files are copied to `<name>.pre-ownership.bak` before the first rewrite, and a `storage_schema.json` marker records the applied version. The migration never assigns legacy records to a user or business, is idempotent (a second run rewrites nothing), and is safe across restarts. `AUTH_DATABASE_PATH`, `DOCUMENT_STORAGE_ROOT` and the JSON files are all git-ignored local state.

### Request flow and IDs

Identifiers returned by one call are required by the next:

1. `POST /api/documents/upload` (multipart field `file`) → `DocumentRecord`; keep `document_id` and `status`. A `quarantined` document cannot be extracted.
2. `POST /api/documents/{document_id}/extract` → `ExtractResponse` with `document`, `invoice_id`, `invoice`, `validation`; keep `invoice_id`. Failures are `409` (quarantined), `503` (provider/configuration), `404` (unknown document).
3. `POST /api/invoices/{invoice_id}/validate` reruns deterministic validation → `ValidationResponse` (`status`, `issues`, `confidence`, `export_ready`, `summary`).
4. `GET /api/invoices/{invoice_id}` → the canonical invoice; `GET /api/invoices/{invoice_id}/gstr1` → the internal GSTR-1 representation; `GET /api/invoices/{invoice_id}/audit` and `GET /api/documents/{document_id}/audit` → chronological processing history.
5. `GET /api/invoices/{invoice_id}/export/json` and `/export/csv` → attachment downloads. They return `409` until the current validation result has `export_ready` true, and `404` for an unknown invoice.

`POST /api/invoices/validate` is a stateless endpoint that accepts canonical invoice JSON without any upload.

Set `GEMINI_API_KEY`, `GEMINI_PRIMARY_MODEL`, and optionally `GEMINI_FALLBACK_MODEL` in a local `.env` or process environment before using extraction. The application does not invent a model name or credential. Without configuration, extraction returns a clear provider-configuration error.

Upload security enforces a 10 MB limit, extension and MIME allow-lists, magic-byte checks, UUID filenames, SHA-256 hashing, Pillow decode/re-encode for images, EXIF removal, PDF inspection, and prompt-injection quarantine. Quarantined documents never reach Gemini.

The rule engine is authoritative for arithmetic, GSTIN checksum, tax split, duplicates, routing, and readiness. Gemini is integrated only behind the extraction adapter: it converts document bytes into a canonical invoice and never controls validation, calibration, GSTR-1, or export decisions.
