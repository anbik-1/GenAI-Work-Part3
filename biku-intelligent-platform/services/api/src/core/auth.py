"""Cognito JWT validation middleware and current-user dependency."""
import httpx
from functools import lru_cache
from typing import Optional
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError
from .config import get_settings

bearer_scheme = HTTPBearer()


@lru_cache()
def _get_jwks(user_pool_id: str, region: str) -> dict:
    """Fetch Cognito JWKs (cached — keys rarely change)."""
    url = (
        f"https://cognito-idp.{region}.amazonaws.com/"
        f"{user_pool_id}/.well-known/jwks.json"
    )
    response = httpx.get(url, timeout=10)
    response.raise_for_status()
    return response.json()


def validate_token(token: str) -> dict:
    """Validate a Cognito JWT and return its claims."""
    settings = get_settings()
    jwks = _get_jwks(settings.cognito_user_pool_id, settings.aws_region)

    # Decode header to find the right key
    unverified_header = jwt.get_unverified_header(token)
    key = next(
        (k for k in jwks["keys"] if k["kid"] == unverified_header["kid"]),
        None,
    )
    if not key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token signing key not found",
        )

    try:
        claims = jwt.decode(
            token,
            key,
            algorithms=["RS256"],
            audience=settings.cognito_client_id,
        )
    except JWTError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid token: {e}",
        )

    return claims


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
) -> dict:
    """FastAPI dependency — validates token and returns Cognito claims."""
    return validate_token(credentials.credentials)


async def get_current_user_sub(
    current_user: dict = Depends(get_current_user),
) -> str:
    """Returns the Cognito sub (user ID) from the token claims."""
    return current_user["sub"]
