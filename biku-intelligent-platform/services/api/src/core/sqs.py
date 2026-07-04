"""SQS helpers — publish generation and ingestion jobs to the queue."""
import json
import boto3
from .config import get_settings


def get_sqs_client():
    settings = get_settings()
    return boto3.client("sqs", region_name=settings.aws_region)


def publish_job(message: dict) -> str:
    """Send a job message to the SQS generation queue. Returns the message ID."""
    settings = get_settings()
    client = get_sqs_client()
    response = client.send_message(
        QueueUrl=settings.generation_queue_url,
        MessageBody=json.dumps(message),
    )
    return response["MessageId"]
