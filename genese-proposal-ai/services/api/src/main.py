"""Genese Proposal AI — FastAPI application entry point."""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .core.config import get_settings
from .routers import health, documents, generate, search, jobs, auth

settings = get_settings()

app = FastAPI(
    title="Genese Proposal AI",
    description="Internal AI system for generating proposals, SoWs, and case studies.",
    version="1.0.0",
    docs_url="/docs" if settings.app_env != "production" else None,
)

# CORS — allow frontend origin
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routers
app.include_router(health.router, tags=["Health"])
app.include_router(auth.router, prefix="/auth", tags=["Auth"])
app.include_router(documents.router, prefix="/documents", tags=["Documents"])
app.include_router(generate.router, prefix="/generate", tags=["Generate"])
app.include_router(search.router, prefix="/search", tags=["Search"])
app.include_router(jobs.router, prefix="/jobs", tags=["Jobs"])
