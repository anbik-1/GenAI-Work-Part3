"""Shared constants for Genese Proposal AI."""

DOCUMENT_TYPES = ["proposal", "sow", "case_study", "other"]

ENGAGEMENT_TYPES = [
    "aws_migration",
    "data_platform",
    "managed_services",
    "security_audit",
    "devops_transformation",
    "cloud_native_development",
    "finops_optimization",
    "disaster_recovery",
    "multi_cloud_strategy",
    "ai_ml_platform",
]

JOB_STATUS = {
    "QUEUED": "queued",
    "PROCESSING": "processing",
    "RETRIEVING": "retrieving_context",
    "VALIDATING": "validating_sources",
    "DRAFTING": "drafting_document",
    "GENERATING_DIAGRAM": "generating_diagram",
    "AWAITING_REVIEW": "awaiting_review",
    "SME_REVIEWING": "sme_reviewing",
    "FORMATTING": "formatting_output",
    "COMPLETE": "complete",
    "FAILED": "failed",
}

PROPOSAL_SECTIONS = [
    "executive_summary",
    "problem_statement",
    "proposed_solution",
    "architecture",
    "team",
    "timeline",
    "investment",
    "next_steps",
]

SOW_SECTIONS = [
    "project_overview",
    "scope_of_work",
    "deliverables",
    "assumptions_and_exclusions",
    "project_team",
    "timeline_and_milestones",
    "pricing",
    "terms_and_conditions",
]

CASE_STUDY_SECTIONS = [
    "client_overview",
    "challenge",
    "solution",
    "architecture_overview",
    "results",
    "key_takeaways",
]

# Bedrock model IDs
# Default LLM model ID. Override via BEDROCK_LLM_MODEL_ID env var in ECS task definition.
# Supported Bedrock models: us.anthropic.claude-sonnet-4-6, us.anthropic.claude-haiku-3-5,
#   us.anthropic.claude-sonnet-4-5, amazon.nova-pro-v1:0
# For non-Bedrock: set USE_OPENAI=true and OPENAI_API_KEY (requires code change in bedrock.py)
BEDROCK_LLM_MODEL_ID = "us.anthropic.claude-sonnet-4-6"
BEDROCK_EMBEDDING_MODEL_ID = "amazon.titan-embed-text-v2:0"
EMBEDDING_DIMENSION = 1024  # Amazon Titan Text Embeddings v2 default output dimension

# Chunking config
CHUNK_SIZE = 512
CHUNK_OVERLAP = 50
TOP_K_RESULTS = 5

# Cache TTL (seconds)
TAVILY_CACHE_TTL = 86400  # 24 hours
