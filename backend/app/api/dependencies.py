from functools import lru_cache

from fastapi import Depends, HTTPException, Request, status

from app.core.config import settings
from app.services.auth_service import (
    AuthService,
    AuthStore,
    BusinessNotFoundError,
    BusinessAccessDeniedError,
    InactiveBusinessError,
    UserRecord,
    BusinessRecord,
    MembershipRecord,
)


@lru_cache(maxsize=8)
def _auth_service(database_path: str, session_ttl_seconds: int) -> AuthService:
    return AuthService(AuthStore(database_path), session_ttl_seconds)


def get_auth_service() -> AuthService:
    return _auth_service(settings.auth_database_path, settings.auth_session_ttl_seconds)


def get_current_user(
    request: Request,
    service: AuthService = Depends(get_auth_service),
) -> UserRecord:
    session_token = request.cookies.get(settings.auth_cookie_name)
    user = service.current_user(session_token)
    if user is None or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )
    return user


def get_current_business(
    request: Request,
    user: UserRecord = Depends(get_current_user),
    service: AuthService = Depends(get_auth_service),
) -> BusinessRecord:
    session_token = request.cookies.get(settings.auth_cookie_name)
    try:
        return service.current_business(user, session_token)
    except BusinessNotFoundError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Business not found.",
        ) from error
    except InactiveBusinessError as error:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Business is inactive.",
        ) from error
    except BusinessAccessDeniedError as error:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Business access denied.",
        ) from error


def get_active_business(
    request: Request,
    user: UserRecord = Depends(get_current_user),
    service: AuthService = Depends(get_auth_service),
) -> BusinessRecord:
    """Authorization context for every business-owned record endpoint.

    Phase 8B-6. The business is always resolved from the session cookie, never
    from a request body, path or query parameter. Callers get:

    * 401 when there is no valid session (`get_current_user`);
    * 403 when the session is valid but cannot be used in a business context,
      because the user has no membership or the active business is inactive.

    An inactive active-business is rejected instead of quietly falling back to
    another membership: authorization never switches business on the caller's
    behalf.
    """
    session_token = request.cookies.get(settings.auth_cookie_name)
    try:
        return service.current_business(user, session_token)
    except BusinessNotFoundError as error:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Business context required.",
        ) from error
    except InactiveBusinessError as error:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Business is inactive.",
        ) from error
    except BusinessAccessDeniedError as error:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Business access denied.",
        ) from error


def require_business_membership(
    business_id: str,
    user: UserRecord = Depends(get_current_user),
    service: AuthService = Depends(get_auth_service),
) -> MembershipRecord:
    try:
        return service.require_membership(user.id, business_id)
    except BusinessNotFoundError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Business not found.",
        ) from error
    except InactiveBusinessError as error:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Business is inactive.",
        ) from error
    except BusinessAccessDeniedError as error:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Business membership required.",
        ) from error
