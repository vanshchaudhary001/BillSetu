from fastapi import APIRouter, Depends, HTTPException, Request, Response, status

from app.api.dependencies import get_auth_service, get_current_user
from app.core.config import settings
from app.schemas.auth import CredentialsRequest, LogoutResponse, UserResponse
from app.services.auth_service import (
    AuthService,
    DuplicateEmailError,
    InvalidCredentialsError,
    UserRecord,
)


router = APIRouter(prefix="/auth", tags=["authentication"])


def public_user(user: UserRecord) -> UserResponse:
    return UserResponse(
        id=user.id,
        email=user.email,
        created_at=user.created_at,
        updated_at=user.updated_at,
        is_active=user.is_active,
    )


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=settings.auth_cookie_name,
        value=token,
        max_age=settings.auth_session_ttl_seconds,
        path="/",
        secure=settings.auth_cookie_secure,
        httponly=True,
        samesite="lax",
    )


@router.post("/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def register(
    payload: CredentialsRequest,
    request: Request,
    response: Response,
    service: AuthService = Depends(get_auth_service),
) -> UserResponse:
    try:
        user, token = service.register(
            payload.email,
            payload.password,
            request.cookies.get(settings.auth_cookie_name),
        )
    except DuplicateEmailError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with this email already exists.",
        ) from error
    set_session_cookie(response, token)
    return public_user(user)


@router.post("/login", response_model=UserResponse)
def login(
    payload: CredentialsRequest,
    request: Request,
    response: Response,
    service: AuthService = Depends(get_auth_service),
) -> UserResponse:
    try:
        user, token = service.login(
            payload.email,
            payload.password,
            request.cookies.get(settings.auth_cookie_name),
        )
    except InvalidCredentialsError as error:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password.",
        ) from error
    set_session_cookie(response, token)
    return public_user(user)


@router.post("/logout", response_model=LogoutResponse)
def logout(
    request: Request,
    response: Response,
    service: AuthService = Depends(get_auth_service),
) -> LogoutResponse:
    service.logout(request.cookies.get(settings.auth_cookie_name))
    response.delete_cookie(
        key=settings.auth_cookie_name,
        path="/",
        secure=settings.auth_cookie_secure,
        httponly=True,
        samesite="lax",
    )
    return LogoutResponse(status="logged_out")


@router.get("/me", response_model=UserResponse)
def current_user(user: UserRecord = Depends(get_current_user)) -> UserResponse:
    return public_user(user)
