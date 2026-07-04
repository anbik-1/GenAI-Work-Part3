"""S3 helper functions — upload, presigned URLs, download."""
import boto3
from botocore.exceptions import ClientError
from .config import get_settings


def get_s3_client():
    settings = get_settings()
    return boto3.client("s3", region_name=settings.aws_region)


def upload_file(file_bytes: bytes, s3_key: str, content_type: str = "application/octet-stream") -> str:
    """Upload bytes to S3. Returns the s3_key."""
    settings = get_settings()
    client = get_s3_client()
    client.put_object(
        Bucket=settings.documents_bucket,
        Key=s3_key,
        Body=file_bytes,
        ContentType=content_type,
    )
    return s3_key


def get_presigned_url(s3_key: str, expiry_seconds: int = 86400) -> str:
    """Generate a presigned download URL (default: 24 hours)."""
    settings = get_settings()
    client = get_s3_client()
    url = client.generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.documents_bucket, "Key": s3_key},
        ExpiresIn=expiry_seconds,
    )
    return url


def delete_s3_object(s3_key: str) -> None:
    """Delete an object from S3."""
    settings = get_settings()
    client = get_s3_client()
    try:
        client.delete_object(Bucket=settings.documents_bucket, Key=s3_key)
    except ClientError:
        pass  # Ignore if already deleted
