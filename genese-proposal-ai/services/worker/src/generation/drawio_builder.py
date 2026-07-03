"""
draw.io XML builder.

Converts the arch_json (produced by architecture_generator.py) into a valid
uncompressed draw.io (.drawio) XML file that can be opened directly in:
  - draw.io (diagrams.net)
  - Lucidchart (via draw.io import)
  - VS Code draw.io extension
  - Confluence draw.io macro

Also generates Mermaid diagram syntax as an alternative format.

Reference: https://www.drawio.com/docs/reference/diagram-generation/
"""
import xml.etree.ElementTree as ET
from xml.dom.minidom import parseString

# AWS service → draw.io shape style mapping
# Uses mxgraph.aws4 shape library (built into draw.io)
AWS_SHAPE_STYLES = {
    # Compute
    "EC2":           "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.ec2;",
    "Lambda":        "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.lambda;",
    "ECS":           "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.ecs;",
    "Fargate":       "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.fargate;",
    "EKS":           "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.eks;",
    "Lightsail":     "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.lightsail;",
    # Storage
    "S3":            "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.s3;",
    "EBS":           "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.ebs;",
    "EFS":           "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.efs;",
    "Glacier":       "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.s3_glacier;",
    # Database
    "RDS":           "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.rds;",
    "Aurora":        "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.aurora;",
    "DynamoDB":      "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.dynamodb;",
    "ElastiCache":   "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.elasticache;",
    "Redshift":      "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.redshift;",
    "DocumentDB":    "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.documentdb;",
    # Network
    "CloudFront":    "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.cloudfront;",
    "APIGateway":    "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.api_gateway;",
    "Route53":       "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.route_53;",
    "ALB":           "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.application_load_balancer;",
    "NLB":           "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.network_load_balancer;",
    "ELB":           "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.elastic_load_balancing;",
    "VPC":           "shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.group_vpc;",
    "NatGateway":    "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.nat_gateway;",
    "InternetGateway": "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.internet_gateway;",
    "TransitGateway": "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.transit_gateway;",
    "DirectConnect": "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.direct_connect;",
    # Security
    "Cognito":       "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.cognito;",
    "IAM":           "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.role;",
    "KMS":           "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.kms;",
    "WAF":           "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.waf;",
    "Shield":        "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.shield;",
    "SecretsManager": "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.secrets_manager;",
    # Integration
    "SNS":           "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.sns;",
    "SQS":           "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.sqs;",
    "EventBridge":   "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.eventbridge;",
    "StepFunctions": "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.step_functions;",
    # Management
    "CloudWatch":    "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.cloudwatch;",
    "CloudTrail":    "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.cloudtrail;",
    # ML
    "Bedrock":       "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.bedrock;",
    "SageMaker":     "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.sagemaker;",
    # DevOps
    "CodePipeline":  "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.codepipeline;",
    "CodeBuild":     "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.codebuild;",
    "CodeDeploy":    "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.codedeploy;",
    "ECR":           "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.ecr;",
    # Analytics
    "Glue":          "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.glue;",
    "Athena":        "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.athena;",
    "Kinesis":       "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.kinesis_data_streams;",
    "EMR":           "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.emr;",
    "QuickSight":    "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.quicksight;",
}

DEFAULT_STYLE = "rounded=1;whiteSpace=wrap;html=1;"
CLUSTER_STYLE = "points=[[0,0],[0.25,0],[0.5,0],[0.75,0],[1,0],[1,0.25],[1,0.5],[1,0.75],[1,1],[0.75,1],[0.5,1],[0.25,1],[0,1],[0,0.75],[0,0.5],[0,0.25]];shape=mxgraph.aws4.group;grStroke=0;verticalLabelPosition=top;verticalAlign=bottom;align=center;spacingTop=0;fontStyle=1;fontSize=11;"
EDGE_STYLE = "edgeStyle=orthogonalEdgeStyle;html=1;exitX=1;exitY=0.5;exitDx=0;exitDy=0;entryX=0;entryY=0.5;entryDx=0;entryDy=0;"


def generate_drawio_xml(arch_json: dict) -> str:
    """
    Convert arch_json dict to a valid draw.io XML string.
    The file can be saved as .drawio and opened directly in draw.io / diagrams.net.
    """
    title = arch_json.get("title", "Architecture Diagram")
    layers = arch_json.get("layers", [])
    connections = arch_json.get("connections", [])

    # Build mxfile XML tree
    mxfile = ET.Element("mxfile")
    diagram = ET.SubElement(mxfile, "diagram", id="page-1", name=title[:50])
    graph_model = ET.SubElement(diagram, "mxGraphModel",
        dx="1422", dy="762", grid="1", gridSize="10", guides="1",
        tooltips="1", connect="1", arrows="1", fold="1",
        page="1", pageScale="1", pageWidth="1169", pageHeight="827",
        math="0", shadow="0")
    root = ET.SubElement(graph_model, "root")

    # Mandatory structural cells
    ET.SubElement(root, "mxCell", id="0")
    ET.SubElement(root, "mxCell", id="1", parent="0")

    cell_id = 2
    node_id_map: dict[str, str] = {}  # arch node_id → mxCell id

    # Layout: stack layers horizontally, 300px per layer, 120px per node
    x_offset = 40
    y_start = 40
    layer_width = 280
    node_height = 60
    node_width = 60
    layer_padding = 30

    for layer in layers:
        layer_name = layer.get("name", "Layer")
        nodes = layer.get("nodes", [])
        color = layer.get("color", "#dae8fc")

        layer_height = max(len(nodes) * (node_height + 20) + 60, 120)
        cluster_id = str(cell_id)
        cell_id += 1

        cluster_cell = ET.SubElement(root, "mxCell",
            id=cluster_id,
            value=layer_name,
            style=f"{CLUSTER_STYLE}fillColor={color};strokeColor=#6c8ebf;",
            vertex="1", parent="1")
        ET.SubElement(cluster_cell, "mxGeometry",
            x=str(x_offset), y=str(y_start),
            width=str(layer_width), height=str(layer_height),
            **{"as": "geometry"})

        # Place nodes inside the cluster
        node_y = y_start + 50
        node_x = x_offset + (layer_width - node_width) // 2

        for node in nodes:
            nid = node.get("id", f"node_{cell_id}")
            label = node.get("label", nid)
            service = node.get("service", "")
            style = AWS_SHAPE_STYLES.get(service, DEFAULT_STYLE)
            style += "labelBackgroundColor=none;labelPosition=center;verticalLabelPosition=bottom;align=center;verticalAlign=top;"

            mx_id = str(cell_id)
            node_id_map[nid] = mx_id
            cell_id += 1

            node_cell = ET.SubElement(root, "mxCell",
                id=mx_id,
                value=label,
                style=style,
                vertex="1", parent=cluster_id)
            ET.SubElement(node_cell, "mxGeometry",
                x=str(node_x - x_offset),
                y=str(node_y - y_start),
                width=str(node_width),
                height=str(node_height),
                **{"as": "geometry"})
            node_y += node_height + 24

        x_offset += layer_width + 40

    # Draw connections
    for conn in connections:
        from_id = node_id_map.get(conn.get("from", ""))
        to_id = node_id_map.get(conn.get("to", ""))
        if not from_id or not to_id:
            continue
        edge_label = conn.get("label", "")
        edge_cell = ET.SubElement(root, "mxCell",
            id=str(cell_id),
            value=edge_label,
            style=EDGE_STYLE,
            edge="1", source=from_id, target=to_id, parent="1")
        ET.SubElement(edge_cell, "mxGeometry", relative="1", **{"as": "geometry"})
        cell_id += 1

    # Serialize to pretty XML
    raw_xml = ET.tostring(mxfile, encoding="unicode", xml_declaration=False)
    pretty = parseString(raw_xml).toprettyxml(indent="  ")
    # Remove the XML declaration added by toprettyxml (draw.io doesn't need it)
    lines = pretty.split("\n")
    if lines[0].startswith("<?xml"):
        lines = lines[1:]
    return "\n".join(lines)


def generate_mermaid(arch_json: dict) -> str:
    """
    Convert arch_json to Mermaid flowchart syntax.
    Can be rendered in GitHub, Notion, Confluence, or any Mermaid-compatible tool.
    """
    title = arch_json.get("title", "Architecture")
    layers = arch_json.get("layers", [])
    connections = arch_json.get("connections", [])

    lines = [f"---", f"title: {title}", f"---", "flowchart LR"]

    for layer in layers:
        layer_name = layer.get("name", "Layer").replace(" ", "_").replace("-", "_")
        nodes = layer.get("nodes", [])
        lines.append(f"  subgraph {layer_name}[\"{layer.get('name', 'Layer')}\"]")
        for node in nodes:
            nid = node.get("id", "node").replace("-", "_").replace(" ", "_")
            label = node.get("label", nid)
            service = node.get("service", "")
            lines.append(f"    {nid}[\"{label}\\n{service}\"]")
        lines.append("  end")

    for conn in connections:
        from_id = (conn.get("from") or "").replace("-", "_").replace(" ", "_")
        to_id = (conn.get("to") or "").replace("-", "_").replace(" ", "_")
        label = conn.get("label", "")
        if from_id and to_id:
            if label:
                lines.append(f"  {from_id} -->|{label}| {to_id}")
            else:
                lines.append(f"  {from_id} --> {to_id}")

    return "\n".join(lines)
