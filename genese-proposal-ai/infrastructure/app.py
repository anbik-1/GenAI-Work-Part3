#!/usr/bin/env python3
import aws_cdk as cdk
from stacks.genese_stack import GeneseProposalAIStack

app = cdk.App()

GeneseProposalAIStack(
    app, "GeneseProposalAIStack",
    env=cdk.Environment(
        account=app.account,
        region=app.region,
    ),
    description="Genese Proposal AI — Internal AI system for proposals, SoWs, and case studies",
)

app.synth()
