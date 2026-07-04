"""Health check endpoint — no authentication required."""
from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def health_check():
    """ALB health check and liveness probe."""
    return {"status": "healthy", "service": "biku-intelligent-platform-api"}
