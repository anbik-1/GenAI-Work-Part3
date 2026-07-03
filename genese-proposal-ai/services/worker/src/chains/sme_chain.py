"""
SME (Subject Matter Expert) review chain.

Claude acts as a domain expert for the specific engagement type.
It reviews the drafted proposal sections, validates technical claims,
checks for outdated recommendations, and improves the content.

Can be toggled on/off per generation job via sme_review_enabled flag.
"""
import json
import logging
from ..core.bedrock import get_llm
from langchain.prompts import ChatPromptTemplate
from shared import BEDROCK_LLM_MODEL_ID

logger = logging.getLogger(__name__)

# Domain expertise personas per engagement type
SME_PERSONAS = {
    "aws_migration": "AWS Migration specialist with 10+ years experience leading enterprise cloud migrations using AWS Migration Hub, Application Migration Service, and Database Migration Service.",
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

Your task is to review a proposal draft and improve it based on your domain expertise.

Review each section for:
1. Technical accuracy — are the recommended services current and appropriate?
2. Completeness — are there important considerations missing for this engagement type?
3. Specificity — are recommendations specific enough to be actionable?
4. Current best practices — does it reflect the latest AWS guidance?

Return the improved sections as a JSON object with the same keys.
Only improve sections where you can add genuine value.
Keep the writing style professional and consultative.
Return ONLY the JSON object — no explanation, no markdown fences."""

SME_HUMAN = """Client: {client_name}
Engagement Type: {engagement_type}
Key Requirements: {requirements}

Current Draft Sections:
{sections_text}

Review and improve these sections from your domain expertise perspective.
Return JSON with the same keys but improved content where relevant."""


def run_sme_review_chain(
    document_type: str,
    client_name: str,
    engagement_type: str,
    key_requirements: str,
    sections: dict,
) -> dict:
    """
    Run SME review on drafted sections.
    Returns improved sections dict (same keys, better content).
    Falls back to original sections on any error.
    """
    persona = SME_PERSONAS.get(engagement_type, SME_PERSONAS["general"])

    # Serialize sections for the prompt
    sections_text = "\n\n".join(
        f"=== {k.upper().replace('_', ' ')} ===\n{v}"
        for k, v in sections.items()
        if isinstance(v, str) and v.strip()
    )[:4000]  # keep within context

    prompt = ChatPromptTemplate.from_messages([
        ("system", SME_SYSTEM),
        ("human", SME_HUMAN),
    ])

    llm = get_llm()
    try:
        response = llm.invoke(prompt.format_messages(
            persona=persona,
            client_name=client_name,
            engagement_type=engagement_type.replace("_", " ").title(),
            requirements=key_requirements[:500],
            sections_text=sections_text,
        ))

        raw = response.content.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
            raw = raw.strip().rstrip("```").strip()

        improved = json.loads(raw)

        # Merge: only replace sections that are actually in the response
        merged = dict(sections)
        for k, v in improved.items():
            if k in merged and isinstance(v, str) and v.strip():
                merged[k] = v

        logger.info(f"[sme_chain] SME review improved {len(improved)} sections for {client_name}")
        return merged

    except Exception as e:
        logger.warning(f"[sme_chain] SME review failed: {e} — returning original sections")
        return sections
