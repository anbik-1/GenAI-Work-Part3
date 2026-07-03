"""
SME (Subject Matter Expert) review chain — interactive report mode.

Claude acts as a domain expert for the specific engagement type.
Instead of silently improving sections, it now returns a structured REPORT
with findings, recommendations, discrepancies, and proposed improvements
so the user can decide before any changes are applied.
"""
import json
import logging
from ..core.bedrock import get_llm
from langchain.prompts import ChatPromptTemplate

logger = logging.getLogger(__name__)

# Domain expertise personas per engagement type
SME_PERSONAS = {
    "aws_migration": "AWS Migration specialist with 10+ years experience leading enterprise cloud migrations using AWS Migration Hub, Application Migration Service (MGN), and Database Migration Service.",
    "data_platform": "Data platform architect specializing in AWS data lakes, Redshift, Glue, Athena, and real-time streaming with Kinesis and MSK.",
    "managed_services": "AWS Managed Services expert with deep knowledge of AWS Operations, Config, Systems Manager, and CloudWatch for enterprise support.",
    "security_audit": "AWS security architect and certified CISSP specializing in IAM, GuardDuty, Security Hub, WAF, and compliance frameworks (SOC2, ISO27001, PCI-DSS).",
    "devops_transformation": "DevOps transformation lead specializing in AWS CodePipeline, CodeBuild, ECS, EKS, Terraform, and GitOps workflows.",
    "ai_ml_platform": "AWS AI/ML architect specializing in SageMaker, Bedrock, and building production-grade ML pipelines.",
    "cloud_native_development": "Cloud-native architect specializing in serverless (Lambda, API Gateway), containers (ECS Fargate, EKS), and event-driven architectures.",
    "finops_optimization": "AWS FinOps specialist with expertise in Cost Explorer, Savings Plans, Reserved Instances, and rightsizing strategies.",
    "cloud_adoption": "AWS Cloud Adoption Framework (CAF) specialist helping enterprises plan and execute cloud adoption programs.",
    "disaster_recovery": "AWS disaster recovery architect specializing in RTO/RPO objectives, multi-region architectures, Route 53 failover, and backup strategies.",
    "cloud_optimization": "AWS Well-Architected Framework reviewer specializing in performance efficiency, cost optimization, and reliability improvements.",
    "general": "Senior AWS solutions architect with broad expertise across all AWS service categories and cloud best practices.",
}

SME_SYSTEM = """You are a {persona}

Your task is to perform a thorough expert review of a proposal draft and return a structured JSON report.

Review each section for:
1. Technical accuracy — are the recommended services current and appropriate?
2. Completeness — are there important considerations missing for this engagement type?
3. Specificity — are recommendations specific enough to be actionable?
4. Current best practices — does it reflect the latest AWS guidance?
5. Consistency — do sections contradict each other (e.g. architecture mentions EC2 but solution mentions containers)?

You MUST return a single JSON object with EXACTLY this structure — no explanation, no markdown fences, no extra keys:
{{
  "persona": "Brief description of the reviewer persona",
  "overall_assessment": "2-4 sentence summary of the proposal's technical quality and key gaps",
  "overall_score": 7,
  "findings": [
    {{
      "section": "section_key_name",
      "severity": "high",
      "issue": "Clear description of the technical problem or gap",
      "recommendation": "Specific, actionable recommendation to address this issue"
    }}
  ],
  "discrepancies": [
    {{
      "description": "Clear description of the inconsistency between sections",
      "section": "primary_section_key_name"
    }}
  ],
  "proposed_improvements": {{
    "section_key": "Full improved text for this section — only include sections with actual improvements"
  }}
}}

Rules:
- overall_score: integer 1-10 (1=very poor, 10=excellent)
- findings severity: MUST be exactly "high", "medium", or "low"
- findings: list at least 1, up to 8 findings
- discrepancies: list cross-section inconsistencies (can be empty list [])
- proposed_improvements: ONLY include sections where you can make a meaningful improvement
- Return ONLY the JSON object — absolutely no text before or after"""

SME_HUMAN = """Client: {client_name}
Engagement Type: {engagement_type}
Key Requirements: {requirements}

Current Draft Sections:
{sections_text}

Perform your expert review and return the structured JSON report."""


def run_sme_review_chain(
    document_type: str,
    client_name: str,
    engagement_type: str,
    key_requirements: str,
    sections: dict,
) -> dict:
    """
    Run SME review on drafted sections.

    Returns a SME review report dict with shape:
    {
      "persona": str,
      "overall_assessment": str,
      "overall_score": int (1-10),
      "findings": [{"section": str, "severity": "high|medium|low", "issue": str, "recommendation": str}],
      "discrepancies": [{"description": str, "section": str}],
      "proposed_improvements": {section_key: improved_text, ...}
    }

    Raises on unrecoverable errors so orchestrator can handle gracefully.
    """
    persona = SME_PERSONAS.get(engagement_type, SME_PERSONAS["general"])

    # Serialize sections for the prompt — include all string sections
    sections_text = "\n\n".join(
        f"=== {k.upper().replace('_', ' ')} ===\n{v}"
        for k, v in sections.items()
        if isinstance(v, str) and v.strip()
    )[:6000]  # keep within context

    prompt = ChatPromptTemplate.from_messages([
        ("system", SME_SYSTEM),
        ("human", SME_HUMAN),
    ])

    llm = get_llm()
    response = llm.invoke(prompt.format_messages(
        persona=persona,
        client_name=client_name,
        engagement_type=engagement_type.replace("_", " ").title(),
        requirements=key_requirements[:500],
        sections_text=sections_text,
    ))

    raw = response.content.strip()
    # Strip markdown fences if present
    if raw.startswith("```"):
        parts = raw.split("```")
        raw = parts[1] if len(parts) > 1 else raw
        if raw.startswith("json"):
            raw = raw[4:]
        raw = raw.strip().rstrip("```").strip()

    report = json.loads(raw)

    # Validate and normalise required keys
    report.setdefault("persona", persona)
    report.setdefault("overall_assessment", "")
    report.setdefault("overall_score", 5)
    report.setdefault("findings", [])
    report.setdefault("discrepancies", [])
    report.setdefault("proposed_improvements", {})

    # Clamp score
    try:
        report["overall_score"] = max(1, min(10, int(report["overall_score"])))
    except (TypeError, ValueError):
        report["overall_score"] = 5

    # Normalise finding severity values
    valid_severities = {"high", "medium", "low"}
    for finding in report.get("findings", []):
        if finding.get("severity") not in valid_severities:
            finding["severity"] = "medium"

    logger.info(
        f"[sme_chain] SME review complete for {client_name}: "
        f"score={report['overall_score']}, "
        f"findings={len(report['findings'])}, "
        f"improvements={len(report['proposed_improvements'])}"
    )
    return report


def apply_sme_improvements(sections: dict, report: dict) -> dict:
    """
    Merge proposed_improvements from a SME report into the sections dict.

    Only sections explicitly included in proposed_improvements are updated.
    All other sections are returned unchanged.

    Args:
        sections: Current proposal sections dict.
        report:   SME review report returned by run_sme_review_chain().

    Returns:
        New sections dict with improvements applied.
    """
    proposed = report.get("proposed_improvements", {})
    if not proposed:
        logger.info("[sme_chain] apply_sme_improvements: no improvements to apply")
        return dict(sections)

    merged = dict(sections)
    applied = 0
    for key, improved_text in proposed.items():
        if key in merged and isinstance(improved_text, str) and improved_text.strip():
            merged[key] = improved_text
            applied += 1

    logger.info(f"[sme_chain] Applied {applied} SME improvements out of {len(proposed)} proposed")
    return merged
