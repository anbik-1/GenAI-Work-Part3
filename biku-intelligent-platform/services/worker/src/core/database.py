"""Worker database session (sync — worker runs synchronously)."""
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session
from .config import get_settings

_engine = None
_SessionLocal = None


def get_engine():
    global _engine
    if _engine is None:
        settings = get_settings()
        # Worker uses sync SQLAlchemy (simpler for the SQS consumer loop)
        sync_url = settings.database_url.replace("postgresql+asyncpg://", "postgresql+psycopg2://")
        _engine = create_engine(sync_url, pool_pre_ping=True, pool_size=3)
    return _engine


def get_session_factory():
    global _SessionLocal
    if _SessionLocal is None:
        _SessionLocal = sessionmaker(bind=get_engine(), autocommit=False, autoflush=False)
    return _SessionLocal


def get_db() -> Session:
    """Context manager — yields a synchronous SQLAlchemy session."""
    factory = get_session_factory()
    db = factory()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
