from datetime import datetime

from pydantic import BaseModel, EmailStr, Field, field_validator


class CredentialsRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=1024)

    @field_validator("email", mode="before")
    @classmethod
    def trim_email(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class UserResponse(BaseModel):
    id: str
    email: EmailStr
    created_at: datetime
    updated_at: datetime
    is_active: bool


class LogoutResponse(BaseModel):
    status: str
