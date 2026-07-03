"""Scoring chain — evaluates a completed proposal on 5 dimensions using Claude."""
import json
from langchain.prompts import ChatPromptTemplate
from ..core.bedrock import get_llm


def score_proposal(document_type: str, client_name: str, sections_content: dict) -> dict:
    """
    Score the proposal on 5 dimensions using Claude. Returns a JSON dict.

    Dimensions (each 1-10):
      completeness, clarity, technical_depth, client_alignment, value_proposition
    Plus an overall score and a one-sentence summary.
    """
    sections_text = "\n\n".join(
        f"{k.upper()}:\n{v}"
        for k, v in sections_content.items()
        if isinstance(v, str)
    )[:3000]

    prompt = ChatPromptTemplate.from_messages([
        ("system", "You are a senior proposal evaluator. Score this proposal strictly as JSON."),
        ("human", """Score this {doc_type} for {client} on these 5 dimensions (1-10 each):
1. completeness - are all sections thorough?
2. clarity - is the writing clear and professional?
3. technical_depth - does it show deep AWS/cloud expertise?
4. client_alignment - does it address the client's specific needs?
5. value_proposition - is the business value clearly articulated?

Proposal sections:
{sections}

Return ONLY JSON: {{"completeness": 8, "clarity": 9, "technical_depth": 7, "client_alignment": 8, "value_proposition": 9, "overall": 8, "summary": "One sentence assessment"}}"""),
    ])

    llm = get_llm()
    response = llm.invoke(
        prompt.format_messages(
            doc_type=document_type,
            client=client_name,
            sections=sections_text,
        )
    )

    raw = response.content.strip()

    # Strip markdown code fences if present
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        raw = raw[4:] if raw.startswith("json") else raw

    return json.loads(raw.strip())
