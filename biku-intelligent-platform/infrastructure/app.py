#!/usr/bin/env python3
import aws_cdk as cdk
from stacks.genese_stack import GeneseProposalAIStack

app = cdk.App()

GeneseProposalAIStack(
    app, "BikuIntelligentPlatformStack",
    app_name="biku-intelligent-platform",
    env=cdk.Environment(
        account=app.account,
        region=app.region,
    ),
    description="Biku Intelligent Platform — AI system for proposals, SoWs, and case studies",
)

app.synth()
