"""LangChain generation chain — uses Claude Sonnet 4.6 to draft proposals/SoWs."""
import json
from langchain.prompts import ChatPromptTemplate
from langchain.schema.output_parser import StrOutputParser
from ..core.bedrock import get_llm
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
) -> dict:
    """
    Generate a complete proposal/SoW/case study using Claude Sonnet 4.6.
    Returns a dict with section names as keys and generated content as values.
    """
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

    llm = get_llm()
    chain = prompt | llm | StrOutputParser()

    raw_output = chain.invoke({
        "document_type": document_type.replace("_", " ").title(),
        "client_name": client_name,
        "engagement_type": engagement_type.replace("_", " ").title(),
        "key_requirements": key_requirements,
        "rag_context": rag_context,
        "tavily_sources_section": tavily_sources_section,
        "context_notes_section": context_notes_section,
        "sections": sections_str,
        "sections_json": sections_json,
    })

    # Parse the JSON response
    try:
        # Strip markdown code fences if present
        cleaned = raw_output.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("```")[1]
            if cleaned.startswith("json"):
                cleaned = cleaned[4:]
        return json.loads(cleaned.strip())
    except json.JSONDecodeError:
        # If JSON parsing fails, return the raw text under a fallback key
        return {"content": raw_output, "parse_error": True}
