from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes.auth import router as auth_router
from app.api.routes.businesses import router as businesses_router
from app.api.routes.validation import router as validation_router
from app.core.config import settings
from app.api.routes.documents import router as documents_router
from app.api.routes.invoices import router as invoices_router
from app.storage import migrate_persistent_storage, storage_data_dir


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Idempotent: existing JSON records are only rewritten when they predate
    # business ownership. Legacy records keep `business_id = null`.
    migrate_persistent_storage(storage_data_dir())
    yield


app = FastAPI(
    title="Bill Setu Backend",
    version="0.1.0",
    description="GST pre-flight preparation and validation API. It does not file returns.",
    lifespan=lifespan,
)

# Only explicitly configured frontend origins can make credentialed requests.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_allowed_origins,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Authorization"],
    expose_headers=["Content-Disposition"],
    allow_credentials=True,
)


@app.get("/health", tags=["system"])
def health() -> dict[str, str]:
    return {"status": "ok", "service": "billsetu-backend", "version": "0.1.0"}


app.include_router(validation_router, prefix="/api")
app.include_router(documents_router, prefix="/api")
app.include_router(invoices_router, prefix="/api")
app.include_router(auth_router, prefix="/api")
app.include_router(businesses_router, prefix="/api")
