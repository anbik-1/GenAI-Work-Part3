"""Auth router — signup, login, password reset via Amazon Cognito."""
import boto3
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel
from ..core.config import get_settings

router = APIRouter()


class SignupRequest(BaseModel):
    email: str
    password: str
    name: str


class LoginRequest(BaseModel):
    email: str
    password: str


class ForgotPasswordRequest(BaseModel):
    email: str


class ConfirmForgotPasswordRequest(BaseModel):
    email: str
    code: str
    newPassword: str


def get_cognito():
    return boto3.client("cognito-idp", region_name=get_settings().aws_region)


@router.post("/signup", status_code=status.HTTP_201_CREATED)
async def signup(req: SignupRequest):
    """Register a new user via Cognito. Auto-confirms for demo."""
    settings = get_settings()
    cognito = get_cognito()
    try:
        cognito.sign_up(
            ClientId=settings.cognito_client_id,
            Username=req.email,
            Password=req.password,
            UserAttributes=[
                {"Name": "email", "Value": req.email},
                {"Name": "name", "Value": req.name},
            ],
        )
        # Auto-confirm for demo
        cognito.admin_confirm_sign_up(
            UserPoolId=settings.cognito_user_pool_id,
            Username=req.email,
        )
        return {"message": "User registered successfully"}
    except cognito.exceptions.UsernameExistsException:
        raise HTTPException(status_code=409, detail="An account with this email already exists")
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


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
