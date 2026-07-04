"""LangChain generation chain — uses Claude via Bedrock to draft proposals/SoWs.

The model used is resolved in this priority order:
  1. ``model_id`` argument passed to ``generate_document()`` (per-job override)
  2. ``BEDROCK_LLM_MODEL_ID`` env var (ECS task definition / .env)
  3. Hard-coded default: ``us.anthropic.claude-sonnet-4-6``
"""
import json
from langchain.prompts import ChatPromptTemplate
from ..core.bedrock import get_llm
from ..core.config import get_settings
from shared import PROPOSAL_SECTIONS, SOW_SECTIONS, CASE_STUDY_SECTIONS


SECTION_MAP = {
    "proposal": PROPOSAL_SECTIONS,
    "sow": SOW_SECTIONS,
    "case_study": CASE_STUDY_SECTIONS,
}

SYSTEM_PROMPT = """You are an expert proposal writer for Genese Solution, a leading cloud consulting firm.
Genese Solution specializes in AWS, Azure, and GCP cloud transformations, data platforms, and DevOps.

Your writing style is:
- Professional and consultative
- Outcome-focused (always tie recommendations to business value)
- Specific and evidence-based (cite past work and official sources when provided)
- Concise but comprehensive

You must respond with a valid JSON object containing one key per document section.
Each section value should be a complete, well-written paragraph or structured content (use \\n for line breaks).
Do not include any text outside the JSON object."""

PROPOSAL_PROMPT_TEMPLATE = """
Generate a complete, professional {document_type} for the following engagement:

CLIENT: {client_name}
ENGAGEMENT TYPE: {engagement_type}
KEY REQUIREMENTS:
{key_requirements}

{context_notes_section}

PAST WORK FROM OUR KNOWLEDGE BASE (use this to inform and personalize the content):
{rag_context}

{tavily_sources_section}

Generate the {document_type} with these sections: {sections}

Return ONLY a JSON object with these exact keys: {sections_json}
Each value should be 2-4 paragraphs of professional, client-ready content.
"""


def generate_document(
    document_type: str,
    client_name: str,
    engagement_type: str,
    key_requirements: str,
    rag_context: str,
    tavily_sources: str,
    context_notes: str | None = None,
    model_id: str | None = None,
) -> dict:
    """
    Generate a complete proposal/SoW/case study using Claude via Bedrock.

    Args:
        model_id: Optional Bedrock model ID override. If None, the model is
                  resolved from the ``BEDROCK_LLM_MODEL_ID`` env var or the
                  hard-coded default (``us.anthropic.claude-sonnet-4-6``).

    Returns:
        ``{"sections": {...}, "token_usage": {"input_tokens": N, "output_tokens": N, "model": "..."}}``
    """
    settings = get_settings()
    effective_model_id = model_id or settings.bedrock_llm_model_id

    sections = SECTION_MAP.get(document_type, PROPOSAL_SECTIONS)
    sections_str = ", ".join(sections)
    sections_json = json.dumps({s: "..." for s in sections})

    context_notes_section = (
        f"ADDITIONAL CONTEXT:\n{context_notes}" if context_notes else ""
    )
    tavily_sources_section = (
        f"VALIDATED FROM OFFICIAL DOCUMENTATION:\n{tavily_sources}"
        if tavily_sources
        else ""
    )

    prompt = ChatPromptTemplate.from_messages([
        ("system", SYSTEM_PROMPT),
        ("human", PROPOSAL_PROMPT_TEMPLATE),
    ])

    llm = get_llm(model_id=model_id)

    # Use the LLM directly (not via StrOutputParser) to capture usage metadata
    formatted = prompt.format_messages(
        document_type=document_type.replace("_", " ").title(),
        client_name=client_name,
        engagement_type=engagement_type.replace("_", " ").title(),
        key_requirements=key_requirements,
        rag_context=rag_context,
        tavily_sources_section=tavily_sources_section,
        context_notes_section=context_notes_section,
        sections=sections_str,
        sections_json=sections_json,
    )

    response = llm.invoke(formatted)
    raw_output = response.content

    # Extract token usage from response metadata
    token_usage = {"input_tokens": 0, "output_tokens": 0, "model": effective_model_id}
    usage = getattr(response, "usage_metadata", None) or getattr(response, "response_metadata", {})
    if isinstance(usage, dict):
        token_usage["input_tokens"] = (
            usage.get("input_tokens") or
            usage.get("prompt_tokens") or
            usage.get("usage", {}).get("input_tokens", 0)
        )
        token_usage["output_tokens"] = (
            usage.get("output_tokens") or
            usage.get("completion_tokens") or
            usage.get("usage", {}).get("output_tokens", 0)
        )
    elif hasattr(usage, "input_tokens"):
        token_usage["input_tokens"] = usage.input_tokens
        token_usage["output_tokens"] = usage.output_tokens

    # Parse the JSON response
    try:
        cleaned = raw_output.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("```")[1]
            if cleaned.startswith("json"):
                cleaned = cleaned[4:]
        sections_content = json.loads(cleaned.strip())
    except json.JSONDecodeError:
        sections_content = {"content": raw_output, "parse_error": True}

    return {"sections": sections_content, "token_usage": token_usage}
