"""Worker service configuration."""
import json
import boto3
from functools import lru_cache
from pydantic_settings import BaseSettings
from pydantic import Field


class WorkerSettings(BaseSettings):
    aws_region: str = Field(default="us-east-1", alias="AWS_REGION")
    database_url: str = Field(default="", alias="DATABASE_URL")
    documents_bucket: str = Field(default="", alias="DOCUMENTS_BUCKET")
    generation_queue_url: str = Field(default="", alias="GENERATION_QUEUE_URL")
    db_secret_arn: str = Field(default="", alias="DB_SECRET_ARN")
    tavily_secret_arn: str = Field(default="", alias="TAVILY_SECRET_ARN")
    redis_url: str = Field(default="", alias="REDIS_URL")
    app_env: str = Field(default="production", alias="APP_ENV")
    # SQS polling
    sqs_wait_time_seconds: int = Field(default=20, alias="SQS_WAIT_TIME_SECONDS")
    sqs_max_messages: int = Field(default=1, alias="SQS_MAX_MESSAGES")

    class Config:
        env_file = ".env"
        populate_by_name = True


@lru_cache()
def get_settings() -> WorkerSettings:
    settings = WorkerSettings()

    if not settings.database_url and settings.db_secret_arn:
        client = boto3.client("secretsmanager", region_name=settings.aws_region)
        secret = json.loads(
            client.get_secret_value(SecretId=settings.db_secret_arn)["SecretString"]
        )
        h, p, u, pw = secret["host"], secret.get("port", 5432), secret["username"], secret["password"]
        db = secret.get("dbname", "genese")
        settings.database_url = f"postgresql+asyncpg://{u}:{pw}@{h}:{p}/{db}"

    return settings


@lru_cache()
def get_tavily_api_key() -> str:
    """Fetch Tavily API key from Secrets Manager. Returns empty string if not set."""
    settings = get_settings()
    if not settings.tavily_secret_arn:
        return ""
    try:
        client = boto3.client("secretsmanager", region_name=settings.aws_region)
        raw = client.get_secret_value(SecretId=settings.tavily_secret_arn)["SecretString"]
        # Try JSON format first, fall back to plain string
        try:
            secret = json.loads(raw)
            return secret.get("api_key", "")
        except json.JSONDecodeError:
            # Secret is a plain string (not JSON) — return as-is
            return raw.strip()
    except Exception as e:
        print(f"[config] Failed to fetch Tavily secret: {e}")
        return ""
