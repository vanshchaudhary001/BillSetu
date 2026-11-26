from fastapi import APIRouter, Depends, HTTPException, Request, Response, status

from app.api.dependencies import (
    get_auth_service,
    get_current_business,
    get_current_user,
    require_business_membership,
)
from app.core.config import settings
from app.schemas.business import (
    BusinessCreateRequest,
    BusinessResponse,
)
from app.services.auth_service import AuthService, BusinessAccessDeniedError

router = APIRouter(prefix="/businesses", tags=["businesses"])


def public_business(business) -> BusinessResponse:
    return BusinessResponse(
        id=business.id,
        name=business.name,
        created_at=business.created_at,
        updated_at=business.updated_at,
        is_active=business.is_active,
    )


@router.get("", response_model=list[BusinessResponse])
def list_businesses(
    user=Depends(get_current_user),
    service: AuthService = Depends(get_auth_service),
) -> list[BusinessResponse]:
    return [public_business(business) for business in service.list_businesses(user)]


@router.get("/current", response_model=BusinessResponse)
def current_business(
    business=Depends(get_current_business),
) -> BusinessResponse:
    return public_business(business)


@router.post("", response_model=BusinessResponse, status_code=status.HTTP_201_CREATED)
def create_business(
    payload: BusinessCreateRequest,
    request: Request,
    user=Depends(get_current_user),
    service: AuthService = Depends(get_auth_service),
) -> BusinessResponse:
    try:
        business = service.create_business(
            user, payload.name, request.cookies.get(settings.auth_cookie_name)
        )
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error
    return public_business(business)


@router.post("/{business_id}/switch", response_model=BusinessResponse)
def switch_business(
    business_id: str,
    request: Request,
    user=Depends(get_current_user),
    service: AuthService = Depends(get_auth_service),
    membership=Depends(require_business_membership),
) -> BusinessResponse:
    try:
        business = service.switch_business(
            user, business_id, request.cookies.get(settings.auth_cookie_name)
        )
    except BusinessAccessDeniedError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Business membership required.") from error
    return public_business(business)
