"""
Architecture diagram generator.
Claude designs the architecture as structured JSON,
then the `diagrams` library renders it as a professional AWS PNG.
"""
import json
import os
import tempfile
import boto3
from ..core.config import get_settings
from shared import BEDROCK_LLM_MODEL_ID

# ── Prompt ────────────────────────────────────────────────────────────────────

ARCH_SYSTEM = """You are an AWS Solutions Architect at Genese Solution.
Design a clear, accurate AWS architecture for the given proposal.

Return ONLY valid JSON — no markdown, no explanation, just the JSON object.

The JSON schema:
{
  "title": "Architecture title",
  "description": "One sentence description",
  "layers": [
    {
      "name": "Layer name (e.g. Client, Edge, Compute, Data, Security)",
      "color": "hex color for the cluster background (light pastel)",
      "nodes": [
        {
          "id": "unique_id",
          "label": "Service Name",
          "service": "aws_service_key",
          "description": "what it does in 5 words"
        }
      ]
    }
  ],
  "connections": [
    {
      "from": "node_id",
      "to": "node_id",
      "label": "optional edge label (HTTPS, SQL, SQS, etc.)"
    }
  ]
}

Available service keys (use exact spelling):
EC2, Lambda, ECS, Fargate, EKS, Lightsail,
S3, EBS, EFS, Glacier,
RDS, Aurora, DynamoDB, ElastiCache, Redshift, DocumentDB,
APIGateway, CloudFront, Route53, ALB, NLB, VPC, DirectConnect,
Cognito, IAM, KMS, WAF, Shield, SecretsManager,
CloudWatch, CloudTrail, SNS, SQS, EventBridge, StepFunctions,
Bedrock, SageMaker, Rekognition, Textract, Comprehend,
CodePipeline, CodeBuild, CodeDeploy, ECR,
Glue, Athena, Kinesis, EMR, QuickSight,
ELB, NatGateway, InternetGateway, TransitGateway

Rules:
- 5 to 15 nodes maximum (keep it readable)
- Group related services in the same layer
- Always include at least: Users, one compute layer, one data layer
- Connections must only reference valid node IDs
- Colors should be light pastels: #E8F4FD, #FDF2E9, #E9F7EF, #F9EBEA, #F4ECF7
"""

ARCH_HUMAN = """Proposal context:
Client: {client_name}
Engagement: {engagement_type}
Requirements: {key_requirements}

Proposed solution summary (from generated proposal):
{solution_summary}

Design the AWS architecture diagram for this. Return only the JSON."""


# ── AWS service → diagrams library mapping ────────────────────────────────────

SERVICE_MAP = {
    # Compute
    "EC2": ("diagrams.aws.compute", "EC2"),
    "Lambda": ("diagrams.aws.compute", "Lambda"),
    "ECS": ("diagrams.aws.compute", "ECS"),
    "Fargate": ("diagrams.aws.compute", "Fargate"),
    "EKS": ("diagrams.aws.compute", "EKS"),
    "Lightsail": ("diagrams.aws.compute", "Lightsail"),
    # Storage
    "S3": ("diagrams.aws.storage", "S3"),
    "EBS": ("diagrams.aws.storage", "EBS"),
    "EFS": ("diagrams.aws.storage", "EFS"),
    "Glacier": ("diagrams.aws.storage", "S3Glacier"),
    # Database
    "RDS": ("diagrams.aws.database", "RDS"),
    "Aurora": ("diagrams.aws.database", "Aurora"),
    "DynamoDB": ("diagrams.aws.database", "Dynamodb"),
    "ElastiCache": ("diagrams.aws.database", "ElastiCache"),
    "Redshift": ("diagrams.aws.database", "Redshift"),
    "DocumentDB": ("diagrams.aws.database", "DocumentdbMongodbCompatibility"),
    # Network
    "APIGateway": ("diagrams.aws.network", "APIGateway"),
    "CloudFront": ("diagrams.aws.network", "CloudFront"),
    "Route53": ("diagrams.aws.network", "Route53"),
    "ALB": ("diagrams.aws.network", "ALB"),
    "NLB": ("diagrams.aws.network", "NLB"),
    "ELB": ("diagrams.aws.network", "ELB"),
    "VPC": ("diagrams.aws.network", "VPC"),
    "DirectConnect": ("diagrams.aws.network", "DirectConnect"),
    "NatGateway": ("diagrams.aws.network", "NATGateway"),
    "InternetGateway": ("diagrams.aws.network", "InternetGateway"),
    "TransitGateway": ("diagrams.aws.network", "TransitGateway"),
    # Security
    "Cognito": ("diagrams.aws.security", "Cognito"),
    "IAM": ("diagrams.aws.security", "IAM"),
    "KMS": ("diagrams.aws.security", "KMS"),
    "WAF": ("diagrams.aws.security", "WAF"),
    "Shield": ("diagrams.aws.security", "Shield"),
    "SecretsManager": ("diagrams.aws.security", "SecretsManager"),
    # Integration
    "SNS": ("diagrams.aws.integration", "SNS"),
    "SQS": ("diagrams.aws.integration", "SQS"),
    "EventBridge": ("diagrams.aws.integration", "Eventbridge"),
    "StepFunctions": ("diagrams.aws.integration", "StepFunctions"),
    # Management
    "CloudWatch": ("diagrams.aws.management", "Cloudwatch"),
    "CloudTrail": ("diagrams.aws.management", "CloudTrail"),
    # ML/AI
    "Bedrock": ("diagrams.aws.ml", "Sagemaker"),   # closest icon
    "SageMaker": ("diagrams.aws.ml", "Sagemaker"),
    "Rekognition": ("diagrams.aws.ml", "Rekognition"),
    "Textract": ("diagrams.aws.ml", "Textract"),
    "Comprehend": ("diagrams.aws.ml", "Comprehend"),
    # DevOps
    "CodePipeline": ("diagrams.aws.devtools", "CodePipeline"),
    "CodeBuild": ("diagrams.aws.devtools", "CodeBuild"),
    "CodeDeploy": ("diagrams.aws.devtools", "CodeDeploy"),
    "ECR": ("diagrams.aws.devtools", "ECR"),
    # Analytics
    "Glue": ("diagrams.aws.analytics", "Glue"),
    "Athena": ("diagrams.aws.analytics", "Athena"),
    "Kinesis": ("diagrams.aws.analytics", "KinesisDataStreams"),
    "EMR": ("diagrams.aws.analytics", "EMR"),
    "QuickSight": ("diagrams.aws.analytics", "Quicksight"),
}

# Generic fallback
DEFAULT_MODULE = ("diagrams.aws.general", "General")


def _get_node_class(service_key: str):
    """Import and return the diagrams node class for a given AWS service key."""
    module_path, class_name = SERVICE_MAP.get(service_key, DEFAULT_MODULE)
    try:
        import importlib
        module = importlib.import_module(module_path)
        return getattr(module, class_name)
    except (ImportError, AttributeError):
        # Fall back to generic EC2 icon
        from diagrams.aws.compute import EC2
        return EC2


def design_architecture(
    client_name: str,
    engagement_type: str,
    key_requirements: str,
    solution_summary: str,
    feedback: str | None = None,
    previous_json: str | None = None,
) -> dict:
    """
    Ask Claude to design the architecture as JSON.
    If feedback is provided, iterates on the previous design.
    Returns the parsed architecture dict.
    """
    settings = get_settings()
    bedrock = boto3.client("bedrock-runtime", region_name=settings.aws_region)

    human_content = ARCH_HUMAN.format(
        client_name=client_name,
        engagement_type=engagement_type.replace("_", " ").title(),
        key_requirements=key_requirements[:500],
        solution_summary=solution_summary[:800],
    )

    if feedback and previous_json:
        human_content += f"\n\nPREVIOUS ARCHITECTURE:\n{previous_json}\n\nUSER FEEDBACK:\n{feedback}\n\nPlease revise the architecture based on the feedback above."

    response = bedrock.invoke_model(
        modelId=BEDROCK_LLM_MODEL_ID,
        body=json.dumps({
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 2048,
            "temperature": 0.2,
            "messages": [
                {"role": "user", "content": [
                    {"type": "text", "text": ARCH_SYSTEM + "\n\n" + human_content}
                ]}
            ],
        }),
    )

    raw = json.loads(response["body"].read())["content"][0]["text"].strip()
    # Strip markdown if present
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
        raw = raw.strip().rstrip("```").strip()

    return json.loads(raw)


def render_architecture_png(arch_json: dict, output_path: str) -> str:
    """
    Render the architecture JSON as a PNG using the diagrams library.
    Returns the path to the generated PNG file.
    """
    from diagrams import Diagram, Cluster, Edge
    import importlib

    # Set output filename (diagrams appends .png automatically)
    png_name = output_path.rstrip(".png")

    graph_attr = {
        "fontsize": "14",
        "bgcolor": "white",
        "pad": "0.5",
        "splines": "ortho",
        "nodesep": "0.8",
        "ranksep": "1.0",
    }
    node_attr = {
        "fontsize": "12",
        "fontname": "Arial",
    }
    edge_attr = {
        "fontsize": "10",
        "fontname": "Arial",
        "color": "#555555",
    }

    title = arch_json.get("title", "Architecture Diagram")
    layers = arch_json.get("layers", [])
    connections = arch_json.get("connections", [])

    node_objects = {}  # id → diagrams node object

    with Diagram(
        title,
        filename=png_name,
        show=False,
        direction="LR",
        graph_attr=graph_attr,
        node_attr=node_attr,
        edge_attr=edge_attr,
    ):
        # Create nodes inside clusters (layers)
        for layer in layers:
            layer_name = layer.get("name", "Layer")
            nodes = layer.get("nodes", [])
            color = layer.get("color", "#F0F0F0")

            with Cluster(layer_name, graph_attr={"bgcolor": color, "fontsize": "13", "fontname": "Arial Bold"}):
                for node in nodes:
                    node_id = node["id"]
                    label = node.get("label", node_id)
                    service = node.get("service", "EC2")
                    NodeClass = _get_node_class(service)
                    node_objects[node_id] = NodeClass(label)

        # Draw connections
        for conn in connections:
            from_id = conn.get("from")
            to_id = conn.get("to")
            label = conn.get("label", "")
            if from_id in node_objects and to_id in node_objects:
                edge = Edge(label=label, color="#2563EB") if label else Edge(color="#555555")
                node_objects[from_id] >> edge >> node_objects[to_id]

    return f"{png_name}.png"


def generate_architecture_diagram(
    client_name: str,
    engagement_type: str,
    key_requirements: str,
    solution_summary: str,
    feedback: str | None = None,
    previous_json: str | None = None,
) -> tuple[dict, str, bytes]:
    """
    Full pipeline: design → render → return.
    Returns: (arch_json, png_path, png_bytes)
    """
    # 1. Ask Claude to design the architecture
    arch_json = design_architecture(
        client_name=client_name,
        engagement_type=engagement_type,
        key_requirements=key_requirements,
        solution_summary=solution_summary,
        feedback=feedback,
        previous_json=previous_json,
    )

    # 2. Render to PNG in a temp directory
    with tempfile.TemporaryDirectory() as tmpdir:
        output_path = os.path.join(tmpdir, "architecture")
        png_path = render_architecture_png(arch_json, output_path)
        with open(png_path, "rb") as f:
            png_bytes = f.read()

    return arch_json, png_path, png_bytes
