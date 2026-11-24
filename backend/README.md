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

- `POST /api/invoices/validate` accepts canonical invoice JSON and returns validation issues, GSTR-1 bucket, confidence, and export readiness.
- `POST /api/documents/upload` validates, normalizes, hashes, and stores an allowed document using a generated server-side filename.
- `GET /api/documents/{document_id}` returns the document security record.
- `POST /api/documents/{document_id}/extract` sends a non-quarantined document through the Gemini adapter, validates the structured Pydantic invoice, and runs deterministic validation.
- `GET /api/invoices/{invoice_id}` returns the canonical invoice produced by extraction.
- `POST /api/invoices/{invoice_id}/validate` reruns deterministic validation.
- `GET /api/invoices/{invoice_id}/gstr1` returns the internal normalized GSTR-1 representation (not an official filing payload).
- `GET /api/invoices/{invoice_id}/audit` and `GET /api/documents/{document_id}/audit` return the internal processing history.
- `GET /api/invoices/{invoice_id}/export/json` and `/export/csv` return in-memory downloads, but only when the existing validation result has `export_ready` true (otherwise `409`).

## Frontend integration

The static prototype is served separately, e.g. `http://localhost:4173` (`python -m http.server 4173` from the repository root). The backend allows exactly those development origins by default and sends CORS headers on success and error responses:

| Item | Value |
| --- | --- |
| Backend | `http://localhost:8000` |
| Swagger UI | `http://localhost:8000/docs` |
| Frontend development origin | `http://localhost:4173` (also `http://127.0.0.1:4173`) |
| Allowed methods | `GET`, `POST` |
| Allowed request headers | `Content-Type`, `Authorization` |
| Exposed response header | `Content-Disposition` (so the browser can read export filenames) |
| Credentials | not allowed (no cookies or browser auth) |

Override the origins with `CORS_ALLOWED_ORIGINS=http://localhost:4173,https://your-host` in the environment. Keep it an explicit list; a wildcard is not configured.

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
