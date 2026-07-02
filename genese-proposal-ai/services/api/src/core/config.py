"""Application configuration loaded from environment variables / AWS Secrets Manager."""
import json
import boto3
from functools import lru_cache
from pydantic_settings import BaseSettings
from pydantic import Field


class Settings(BaseSettings):
    # AWS
    aws_region: str = Field(default="us-east-1", alias="AWS_REGION")

    # Database — injected by ECS task from Secrets Manager at runtime
    database_url: str = Field(default="", alias="DATABASE_URL")

    # S3
    documents_bucket: str = Field(default="", alias="DOCUMENTS_BUCKET")

    # SQS
    generation_queue_url: str = Field(default="", alias="GENERATION_QUEUE_URL")

    # Cognito
    cognito_user_pool_id: str = Field(default="", alias="COGNITO_USER_POOL_ID")
    cognito_client_id: str = Field(default="", alias="COGNITO_CLIENT_ID")

    # Secrets Manager
    db_secret_arn: str = Field(default="", alias="DB_SECRET_ARN")

    # CORS
    cors_origins: list[str] = Field(default=["*"], alias="CORS_ORIGINS")

    # App
    app_env: str = Field(default="production", alias="APP_ENV")

    class Config:
        env_file = ".env"
        populate_by_name = True


@lru_cache()
def get_settings() -> Settings:
    settings = Settings()

    # If DATABASE_URL not directly set, fetch from Secrets Manager
    if not settings.database_url and settings.db_secret_arn:
        client = boto3.client("secretsmanager", region_name=settings.aws_region)
        secret = json.loads(
            client.get_secret_value(SecretId=settings.db_secret_arn)["SecretString"]
        )
        host = secret["host"]
        port = secret.get("port", 5432)
        username = secret["username"]
        password = secret["password"]
        dbname = secret.get("dbname", "genese")
        # asyncpg driver for async SQLAlchemy
        settings.database_url = (
            f"postgresql+asyncpg://{username}:{password}@{host}:{port}/{dbname}"
        )

    return settings
