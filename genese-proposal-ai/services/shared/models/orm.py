"""SQLAlchemy ORM models for Genese Proposal AI."""
import uuid
from datetime import datetime
from sqlalchemy import Column, String, Integer, Text, DateTime, ForeignKey, JSON
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import DeclarativeBase, relationship
from pgvector.sqlalchemy import Vector


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cognito_sub = Column(String(255), unique=True, nullable=False)
    email = Column(String(255), nullable=False)
    name = Column(String(255))
    created_at = Column(DateTime, default=datetime.utcnow)

    documents = relationship("Document", back_populates="uploader")
    jobs = relationship("GenerationJob", back_populates="user")


class Document(Base):
    __tablename__ = "documents"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    filename = Column(String(500), nullable=False)
    document_type = Column(String(50), nullable=False)   # proposal, sow, case_study, other
    engagement_type = Column(String(100))                # aws_migration, data_platform, etc.
    client_name = Column(String(255))
    s3_key = Column(String(1000), nullable=False)
    chunk_count = Column(Integer, default=0)
    uploaded_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    # Ingestion progress and token tracking
    ingestion_status = Column(String(50), default="pending")  # pending, processing, complete, failed
    embedding_model = Column(String(255))
    embedding_tokens = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)

    uploader = relationship("User", back_populates="documents")
    chunks = relationship("DocumentChunk", back_populates="document", cascade="all, delete-orphan")


class DocumentChunk(Base):
    __tablename__ = "document_chunks"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    document_id = Column(UUID(as_uuid=True), ForeignKey("documents.id", ondelete="CASCADE"))
    chunk_index = Column(Integer, nullable=False)
    content = Column(Text, nullable=False)
    embedding = Column(Vector(1024))    # Amazon Titan Text Embeddings v2 default dimension
    metadata_ = Column("metadata", JSON)
    created_at = Column(DateTime, default=datetime.utcnow)

    document = relationship("Document", back_populates="chunks")


class GenerationJob(Base):
    __tablename__ = "generation_jobs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    document_type = Column(String(50), nullable=False)
    client_name = Column(String(255), nullable=False)
    engagement_type = Column(String(100), nullable=False)
    key_requirements = Column(Text, nullable=False)
    context_notes = Column(Text)
    status = Column(String(50), default="queued")  # queued, processing, complete, failed
    status_detail = Column(String(255))
    rag_context = Column(JSON)         # retrieved chunks used
    tavily_sources = Column(JSON)      # web sources used
    output_s3_key = Column(String(1000))
    error_message = Column(Text)
    # Token usage and model info
    llm_model = Column(String(255))
    input_tokens = Column(Integer, default=0)
    output_tokens = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)
    completed_at = Column(DateTime)

    user = relationship("User", back_populates="jobs")
