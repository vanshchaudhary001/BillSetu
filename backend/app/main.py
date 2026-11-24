from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes.validation import router as validation_router
from app.core.config import settings
from app.api.routes.documents import router as documents_router
from app.api.routes.invoices import router as invoices_router

app = FastAPI(
    title="BillSetu Backend",
    version="0.1.0",
    description="GST pre-flight preparation and validation API. It does not file returns.",
)

# Minimal development CORS: only the local static frontend origins, no wildcard,
# no credentialed requests. Override with CORS_ALLOWED_ORIGINS if needed.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_allowed_origins,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Authorization"],
    expose_headers=["Content-Disposition"],
    allow_credentials=False,
)


@app.get("/health", tags=["system"])
def health() -> dict[str, str]:
    return {"status": "ok", "service": "billsetu-backend", "version": "0.1.0"}


app.include_router(validation_router, prefix="/api")
app.include_router(documents_router, prefix="/api")
app.include_router(invoices_router, prefix="/api")
