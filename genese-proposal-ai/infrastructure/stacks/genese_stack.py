"""Genese Proposal AI — Full AWS CDK Stack.

Provisions: VPC, S3, CloudFront, Cognito, Aurora PostgreSQL Serverless v2 + pgvector,
ElastiCache Redis Serverless, SQS, ECR, ECS Fargate (API + Worker), ALB, IAM, CloudWatch.
"""
import aws_cdk as cdk
from aws_cdk import (
    Stack, Duration, RemovalPolicy, CfnOutput, SecretValue,
    aws_ec2 as ec2,
    aws_s3 as s3,
    aws_cloudfront as cloudfront,
    aws_cloudfront_origins as origins,
    aws_cognito as cognito,
    aws_rds as rds,
    aws_sqs as sqs,
    aws_ecr as ecr,
    aws_ecs as ecs,
    aws_elasticloadbalancingv2 as elbv2,
    aws_iam as iam,
    aws_logs as logs,
    aws_secretsmanager as secretsmanager,
    aws_ssm as ssm,
)
from constructs import Construct


class GeneseProposalAIStack(Stack):

    def __init__(self, scope: Construct, construct_id: str, **kwargs):
        super().__init__(scope, construct_id, **kwargs)

        # ── VPC ──────────────────────────────────────────────────────────────
        vpc = ec2.Vpc(self, "Vpc",
            max_azs=2,
            nat_gateways=1,
            subnet_configuration=[
                ec2.SubnetConfiguration(name="Public", subnet_type=ec2.SubnetType.PUBLIC, cidr_mask=24),
                ec2.SubnetConfiguration(name="Private", subnet_type=ec2.SubnetType.PRIVATE_WITH_EGRESS, cidr_mask=24),
            ],
        )

        # ── S3 ───────────────────────────────────────────────────────────────
        documents_bucket = s3.Bucket(self, "DocumentsBucket",
            bucket_name=f"genese-proposal-ai-docs-{self.account}-{self.region}",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            removal_policy=RemovalPolicy.DESTROY,
            auto_delete_objects=True,
            lifecycle_rules=[s3.LifecycleRule(
                id="ArchiveGenerated",
                prefix="generated/",
                transitions=[s3.Transition(storage_class=s3.StorageClass.INFREQUENT_ACCESS, transition_after=Duration.days(30))],
            )],
        )

        frontend_bucket = s3.Bucket(self, "FrontendBucket",
            bucket_name=f"genese-proposal-ai-frontend-{self.account}-{self.region}",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            removal_policy=RemovalPolicy.DESTROY,
            auto_delete_objects=True,
        )

        # ── CloudFront ────────────────────────────────────────────────────────
        distribution = cloudfront.Distribution(self, "Distribution",
            default_behavior=cloudfront.BehaviorOptions(
                origin=origins.S3BucketOrigin.with_origin_access_control(frontend_bucket),
                viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            ),
            default_root_object="index.html",
            error_responses=[
                cloudfront.ErrorResponse(http_status=404, response_http_status=200, response_page_path="/index.html"),
                cloudfront.ErrorResponse(http_status=403, response_http_status=200, response_page_path="/index.html"),
            ],
        )

        # ── Cognito ───────────────────────────────────────────────────────────
        user_pool = cognito.UserPool(self, "UserPool",
            user_pool_name="genese-proposal-ai",
            self_sign_up_enabled=False,       # Internal tool — admin creates users
            sign_in_aliases=cognito.SignInAliases(email=True),
            password_policy=cognito.PasswordPolicy(min_length=8, require_lowercase=True, require_uppercase=True, require_digits=True, require_symbols=False),
            removal_policy=RemovalPolicy.DESTROY,
        )

        user_pool_client = cognito.UserPoolClient(self, "UserPoolClient",
            user_pool=user_pool,
            user_pool_client_name="genese-web-client",
            auth_flows=cognito.AuthFlow(admin_user_password=True, user_password=True, user_srp=True),
            generate_secret=False,
        )

        # ── Aurora PostgreSQL Serverless v2 + pgvector ────────────────────────
        db_sg = ec2.SecurityGroup(self, "DbSG", vpc=vpc, description="Aurora SG")

        db_secret = secretsmanager.Secret(self, "DbSecret",
            secret_name="/genese/db-credentials",
            generate_secret_string=secretsmanager.SecretStringGenerator(
                secret_string_template='{"username":"genese","dbname":"genese"}',
                generate_string_key="password",
                # RDS forbids: / @ " space — exclude all of them plus other common special chars that cause issues
                exclude_characters=' %+~`#$&*()|[]{}:;<>?!\'/\"\\@/',
                exclude_punctuation=False,
                password_length=32,
            ),
        )

        db_cluster = rds.DatabaseCluster(self, "AuroraCluster",
            engine=rds.DatabaseClusterEngine.aurora_postgres(version=rds.AuroraPostgresEngineVersion.VER_16_4),
            default_database_name="genese",
            serverless_v2_min_capacity=0.5,
            serverless_v2_max_capacity=4,
            writer=rds.ClusterInstance.serverless_v2("Writer"),
            vpc=vpc,
            vpc_subnets=ec2.SubnetSelection(subnet_type=ec2.SubnetType.PRIVATE_WITH_EGRESS),
            security_groups=[db_sg],
            credentials=rds.Credentials.from_secret(db_secret),
            removal_policy=RemovalPolicy.DESTROY,
        )

        # ── ElastiCache Redis (skipped — Tavily cache degrades gracefully without it)
        # Note: ElastiCache Serverless may not be available in all environments.
        # The worker's redis_cache.py returns None gracefully when REDIS_URL is unset.
        redis_endpoint = ""  # Can be added later when ElastiCache is provisioned separately

        # ── SQS Queue + DLQ ───────────────────────────────────────────────────
        dlq = sqs.Queue(self, "GenerationDLQ",
            queue_name="genese-generation-jobs-dlq",
            retention_period=Duration.days(14),
        )

        generation_queue = sqs.Queue(self, "GenerationQueue",
            queue_name="genese-generation-jobs",
            visibility_timeout=Duration.seconds(600),
            retention_period=Duration.days(4),
            dead_letter_queue=sqs.DeadLetterQueue(max_receive_count=3, queue=dlq),
        )

        # ── ECR Repositories — import existing (images already pushed) ────────
        api_repo = ecr.Repository.from_repository_name(self, "ApiRepo", "genese-proposal-ai-api")
        worker_repo = ecr.Repository.from_repository_name(self, "WorkerRepo", "genese-proposal-ai-worker")

        # ── ECS Cluster ───────────────────────────────────────────────────────
        cluster = ecs.Cluster(self, "Cluster", cluster_name="genese-proposal-ai", vpc=vpc)

        # Tavily secret
        tavily_secret = secretsmanager.Secret(self, "TavilySecret",
            secret_name="/genese/tavily-api-key",
            secret_string_value=SecretValue.unsafe_plain_text("REPLACE_WITH_TAVILY_KEY"),
        )

        # Common environment variables
        common_env = {
            "AWS_REGION": self.region,
            "DOCUMENTS_BUCKET": documents_bucket.bucket_name,
            "GENERATION_QUEUE_URL": generation_queue.queue_url,
            "COGNITO_USER_POOL_ID": user_pool.user_pool_id,
            "COGNITO_CLIENT_ID": user_pool_client.user_pool_client_id,
            "DB_SECRET_ARN": db_secret.secret_arn,
            "TAVILY_SECRET_ARN": tavily_secret.secret_arn,
            "REDIS_URL": "",  # Optional - set after provisioning ElastiCache separately
        }

        # ── API Task Definition ───────────────────────────────────────────────
        api_task = ecs.FargateTaskDefinition(self, "ApiTask", cpu=512, memory_limit_mib=1024)
        api_task.add_container("Api",
            image=ecs.ContainerImage.from_ecr_repository(api_repo, tag="latest"),
            environment=common_env,
            logging=ecs.LogDrivers.aws_logs(
                stream_prefix="api",
                log_group=logs.LogGroup(self, "ApiLogs", log_group_name="/ecs/genese-api", removal_policy=RemovalPolicy.DESTROY),
            ),
            port_mappings=[ecs.PortMapping(container_port=8000)],
            health_check=ecs.HealthCheck(
                command=["CMD-SHELL", "curl -f http://localhost:8000/health || exit 1"],
                interval=Duration.seconds(30),
                timeout=Duration.seconds(5),
                retries=3,
            ),
        )

        # ── Worker Task Definition ────────────────────────────────────────────
        worker_task = ecs.FargateTaskDefinition(self, "WorkerTask", cpu=1024, memory_limit_mib=2048)
        worker_task.add_container("Worker",
            image=ecs.ContainerImage.from_ecr_repository(worker_repo, tag="latest"),
            environment=common_env,
            logging=ecs.LogDrivers.aws_logs(
                stream_prefix="worker",
                log_group=logs.LogGroup(self, "WorkerLogs", log_group_name="/ecs/genese-worker", removal_policy=RemovalPolicy.DESTROY),
            ),
        )

        # ── Grant permissions ─────────────────────────────────────────────────
        for task in [api_task, worker_task]:
            documents_bucket.grant_read_write(task.task_role)
            generation_queue.grant_send_messages(task.task_role)
            generation_queue.grant_consume_messages(task.task_role)
            db_secret.grant_read(task.task_role)
            tavily_secret.grant_read(task.task_role)
            task.task_role.add_managed_policy(iam.ManagedPolicy.from_aws_managed_policy_name("AmazonBedrockFullAccess"))

        # ── Security group rules ──────────────────────────────────────────────
        api_sg = ec2.SecurityGroup(self, "ApiSG", vpc=vpc, description="ECS API SG")
        worker_sg = ec2.SecurityGroup(self, "WorkerSG", vpc=vpc, description="ECS Worker SG")
        db_sg.add_ingress_rule(api_sg, ec2.Port.tcp(5432), "API to Aurora")
        db_sg.add_ingress_rule(worker_sg, ec2.Port.tcp(5432), "Worker to Aurora")

        # ── ALB (for API service — created here, service created via CLI) ──────
        alb = elbv2.ApplicationLoadBalancer(self, "ApiLB",
            vpc=vpc,
            internet_facing=True,
            security_group=ec2.SecurityGroup(self, "AlbSG", vpc=vpc, description="ALB SG"),
        )
        alb_sg = alb.connections.security_groups[0]
        api_sg.add_ingress_rule(alb_sg, ec2.Port.tcp(8000), "ALB to API")

        target_group = elbv2.ApplicationTargetGroup(self, "ApiTG",
            vpc=vpc,
            port=8000,
            protocol=elbv2.ApplicationProtocol.HTTP,
            target_type=elbv2.TargetType.IP,
            health_check=elbv2.HealthCheck(path="/health", interval=Duration.seconds(30), healthy_threshold_count=2, unhealthy_threshold_count=3),
        )

        alb.add_listener("Listener",
            port=80,
            default_target_groups=[target_group],
        )

        # NOTE: ECS Cluster and Task Definitions are created here.
        # ECS Services are created via AWS CLI after CDK deploy to avoid
        # CloudFormation ECS stabilization timeout issues.

        # ── CloudFormation Outputs ────────────────────────────────────────────
        CfnOutput(self, "ApiUrl", value=f"http://{alb.load_balancer_dns_name}", description="API Load Balancer URL")
        CfnOutput(self, "TargetGroupArn", value=target_group.target_group_arn, description="ALB Target Group ARN")
        CfnOutput(self, "AlbArn", value=alb.load_balancer_arn, description="ALB ARN")
        CfnOutput(self, "CloudFrontUrl", value=f"https://{distribution.distribution_domain_name}", description="Frontend CloudFront URL")
        CfnOutput(self, "FrontendBucketName", value=frontend_bucket.bucket_name, description="Frontend S3 bucket")
        CfnOutput(self, "DocumentsBucketName", value=documents_bucket.bucket_name, description="Documents S3 bucket")
        CfnOutput(self, "UserPoolId", value=user_pool.user_pool_id, description="Cognito User Pool ID")
        CfnOutput(self, "UserPoolClientId", value=user_pool_client.user_pool_client_id, description="Cognito Client ID")
        CfnOutput(self, "ApiRepoUri", value=f"{self.account}.dkr.ecr.{self.region}.amazonaws.com/genese-proposal-ai-api", description="ECR repo for API image")
        CfnOutput(self, "WorkerRepoUri", value=f"{self.account}.dkr.ecr.{self.region}.amazonaws.com/genese-proposal-ai-worker", description="ECR repo for Worker image")
        CfnOutput(self, "DbSecretArn", value=db_secret.secret_arn, description="DB credentials secret ARN")
        CfnOutput(self, "TavilySecretArn", value=tavily_secret.secret_arn, description="Tavily API key secret ARN")
