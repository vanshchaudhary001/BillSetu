from fastapi import APIRouter

from app.schemas.invoice import InvoiceValidationRequest
from app.schemas.validation import ValidationResponse
from app.services.validation_engine import ValidationEngine

router = APIRouter(tags=["validation"])
engine = ValidationEngine()


@router.post("/invoices/validate", response_model=ValidationResponse)
def validate_invoice(request: InvoiceValidationRequest) -> ValidationResponse:
    return engine.validate(
        request.invoice,
        request.existing_fingerprints,
        business_scheme=request.business_scheme,
        annual_turnover=request.annual_turnover,
    )
