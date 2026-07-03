"""Auth router — login, token refresh, password reset, admin user management."""
import uuid
from typing import Optional
import boto3
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from ..core.config import get_settings
from ..core.database import get_db
from ..core.auth import get_current_user_sub

router = APIRouter()


# ─── Request / Response models ───────────────────────────────────────────────

class LoginRequest(BaseModel):
    email: str
    password: str


class RefreshRequest(BaseModel):
    refreshToken: str


class ForgotPasswordRequest(BaseModel):
    email: str


class ConfirmForgotPasswordRequest(BaseModel):
    email: str
    code: str
    newPassword: str


class CreateUserRequest(BaseModel):
    email: str
    name: str
    password: str
    role: str = "member"  # "admin" or "member"


# ─── Helpers ─────────────────────────────────────────────────────────────────

def get_cognito():
    return boto3.client("cognito-idp", region_name=get_settings().aws_region)


async def require_admin(db: AsyncSession, user_sub: str) -> None:
    """Raise 403 if the calling user does not have role='admin'."""
    row = (
        await db.execute(
            text("SELECT role FROM users WHERE cognito_sub = :sub"),
            {"sub": user_sub},
        )
    ).mappings().one_or_none()
    if not row or row["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")


# ─── Public endpoints ─────────────────────────────────────────────────────────

@router.post("/login")
async def login(req: LoginRequest):
    """Authenticate user and return JWT tokens."""
    settings = get_settings()
    cognito = get_cognito()
    try:
        result = cognito.admin_initiate_auth(
            UserPoolId=settings.cognito_user_pool_id,
            ClientId=settings.cognito_client_id,
            AuthFlow="ADMIN_USER_PASSWORD_AUTH",
            AuthParameters={
                "USERNAME": req.email,
                "PASSWORD": req.password,
            },
        )
        auth = result["AuthenticationResult"]
        return {
            "idToken": auth["IdToken"],
            "accessToken": auth["AccessToken"],
            "refreshToken": auth.get("RefreshToken"),
        }
    except cognito.exceptions.NotAuthorizedException:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    except cognito.exceptions.UserNotFoundException:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/refresh")
async def refresh_token(req: RefreshRequest):
    """Exchange a Cognito refresh token for a new idToken and accessToken.

    Returns 401 when the refresh token has expired or been revoked so the
    frontend knows to redirect the user to the login page.
    """
    settings = get_settings()
    cognito = get_cognito()
    try:
        result = cognito.initiate_auth(
            ClientId=settings.cognito_client_id,
            AuthFlow="REFRESH_TOKEN_AUTH",
            AuthParameters={
                "REFRESH_TOKEN": req.refreshToken,
            },
        )
        auth = result["AuthenticationResult"]
        return {
            "idToken": auth["IdToken"],
            "accessToken": auth["AccessToken"],
        }
    except cognito.exceptions.NotAuthorizedException:
        raise HTTPException(status_code=401, detail="Refresh token expired. Please log in again.")
    except cognito.exceptions.UserNotFoundException:
        raise HTTPException(status_code=401, detail="User not found. Please log in again.")
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/forgot-password")
async def forgot_password(req: ForgotPasswordRequest):
    """Initiate password reset."""
    settings = get_settings()
    cognito = get_cognito()
    try:
        cognito.forgot_password(ClientId=settings.cognito_client_id, Username=req.email)
        return {"message": "Password reset code sent to your email"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/confirm-forgot-password")
async def confirm_forgot_password(req: ConfirmForgotPasswordRequest):
    """Confirm password reset with code."""
    settings = get_settings()
    cognito = get_cognito()
    try:
        cognito.confirm_forgot_password(
            ClientId=settings.cognito_client_id,
            Username=req.email,
            ConfirmationCode=req.code,
            Password=req.newPassword,
        )
        return {"message": "Password reset successful"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# ─── Authenticated endpoints ──────────────────────────────────────────────────

@router.get("/me")
async def get_me(
    db: AsyncSession = Depends(get_db),
    user_sub: str = Depends(get_current_user_sub),
):
    """Return the current user's profile including role."""
    row = (
        await db.execute(
            text("SELECT id, email, name, role, created_at FROM users WHERE cognito_sub = :sub"),
            {"sub": user_sub},
        )
    ).mappings().one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="User not found")
    return {
        "id": str(row["id"]),
        "email": row["email"],
        "name": row["name"],
        "role": row["role"],
        "created_at": row["created_at"].isoformat(),
    }


# ─── Admin-only endpoints ─────────────────────────────────────────────────────

@router.post("/admin/create-user", status_code=status.HTTP_201_CREATED)
async def create_user(
    req: CreateUserRequest,
    db: AsyncSession = Depends(get_db),
    user_sub: str = Depends(get_current_user_sub),
):
    """Create a new user (admin only). Creates Cognito account + DB record."""
    await require_admin(db, user_sub)

    if req.role not in ("admin", "member"):
        raise HTTPException(status_code=400, detail="role must be 'admin' or 'member'")

    settings = get_settings()
    cognito = get_cognito()

    # Create user in Cognito with a permanent password (no force-change)
    try:
        cognito_response = cognito.admin_create_user(
            UserPoolId=settings.cognito_user_pool_id,
            Username=req.email,
            UserAttributes=[
                {"Name": "email", "Value": req.email},
                {"Name": "email_verified", "Value": "true"},
                {"Name": "name", "Value": req.name},
            ],
            MessageAction="SUPPRESS",  # Don't send the Cognito welcome email
        )
        cognito_sub = next(
            (a["Value"] for a in cognito_response["User"]["Attributes"] if a["Name"] == "sub"),
            None,
        )
        # Set a permanent password so the user doesn't have to reset on first login
        cognito.admin_set_user_password(
            UserPoolId=settings.cognito_user_pool_id,
            Username=req.email,
            Password=req.password,
            Permanent=True,
        )
    except cognito.exceptions.UsernameExistsException:
        raise HTTPException(status_code=409, detail="An account with this email already exists")
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Insert into users table
    new_id = uuid.uuid4()
    try:
        await db.execute(
            text(
                """INSERT INTO users (id, cognito_sub, email, name, role, created_at)
                   VALUES (:id, :cognito_sub, :email, :name, :role, NOW())"""
            ),
            {
                "id": str(new_id),
                "cognito_sub": cognito_sub,
                "email": req.email,
                "name": req.name,
                "role": req.role,
            },
        )
        await db.commit()
    except Exception as e:
        # Roll back Cognito user creation on DB failure
        try:
            cognito.admin_delete_user(
                UserPoolId=settings.cognito_user_pool_id,
                Username=req.email,
            )
        except Exception:
            pass
        raise HTTPException(status_code=500, detail=f"Failed to create user in database: {e}")

    return {
        "id": str(new_id),
        "email": req.email,
        "name": req.name,
        "role": req.role,
    }


@router.get("/users")
async def list_users(
    db: AsyncSession = Depends(get_db),
    user_sub: str = Depends(get_current_user_sub),
):
    """List all users (admin only)."""
    await require_admin(db, user_sub)

    rows = (
        await db.execute(
            text(
                """SELECT id, email, name, role, created_at
                   FROM users
                   ORDER BY created_at ASC"""
            )
        )
    ).mappings().all()

    return [
        {
            "id": str(r["id"]),
            "email": r["email"],
            "name": r["name"],
            "role": r["role"],
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        }
        for r in rows
    ]


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(
    user_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user_sub: str = Depends(get_current_user_sub),
):
    """Delete a user from Cognito and DB (admin only). Cannot delete yourself."""
    await require_admin(db, user_sub)

    # Look up the target user
    row = (
        await db.execute(
            text("SELECT id, email, cognito_sub FROM users WHERE id = CAST(:id AS uuid)"),
            {"id": str(user_id)},
        )
    ).mappings().one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="User not found")

    # Prevent self-deletion
    if row["cognito_sub"] == user_sub:
        raise HTTPException(status_code=400, detail="You cannot delete your own account")

    settings = get_settings()
    cognito = get_cognito()

    # Delete from Cognito (best-effort — don't fail if already gone)
    try:
        cognito.admin_delete_user(
            UserPoolId=settings.cognito_user_pool_id,
            Username=row["email"],
        )
    except cognito.exceptions.UserNotFoundException:
        pass  # Already removed from Cognito — continue to DB cleanup
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete from Cognito: {e}")

    # Delete from DB
    await db.execute(
        text("DELETE FROM users WHERE id = CAST(:id AS uuid)"),
        {"id": str(user_id)},
    )
    await db.commit()
