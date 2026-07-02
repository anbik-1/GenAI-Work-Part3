"""
Database migration script — creates all tables and enables pgvector extension.
Run once after deploying the CDK stack and before starting the services.

Usage:
  python scripts/db_migrate.py --secret-arn <DB_SECRET_ARN> --region us-east-1
"""
import json
import sys
import argparse
import boto3
import psycopg2
from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT


def get_db_credentials(secret_arn: str, region: str) -> dict:
    client = boto3.client("secretsmanager", region_name=region)
    secret = json.loads(client.get_secret_value(SecretId=secret_arn)["SecretString"])
    return secret


def run_migration(host: str, port: int, dbname: str, username: str, password: str):
    print(f"Connecting to {host}:{port}/{dbname}...")
    conn = psycopg2.connect(host=host, port=port, dbname=dbname, user=username, password=password, connect_timeout=30)
    conn.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
    cur = conn.cursor()

    print("Enabling pgvector extension...")
    cur.execute("CREATE EXTENSION IF NOT EXISTS vector;")

    print("Creating tables...")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            cognito_sub VARCHAR(255) UNIQUE NOT NULL,
            email VARCHAR(255) NOT NULL,
            name VARCHAR(255),
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS documents (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            filename VARCHAR(500) NOT NULL,
            document_type VARCHAR(50) NOT NULL,
            engagement_type VARCHAR(100),
            client_name VARCHAR(255),
            s3_key VARCHAR(1000) NOT NULL,
            chunk_count INTEGER DEFAULT 0,
            uploaded_by UUID REFERENCES users(id),
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS document_chunks (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
            chunk_index INTEGER NOT NULL,
            content TEXT NOT NULL,
            embedding vector(1024),
            metadata JSONB,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    """)

    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_chunks_embedding
        ON document_chunks USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100);
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS generation_jobs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID REFERENCES users(id),
            document_type VARCHAR(50) NOT NULL,
            client_name VARCHAR(255) NOT NULL,
            engagement_type VARCHAR(100) NOT NULL,
            key_requirements TEXT NOT NULL,
            context_notes TEXT,
            status VARCHAR(50) DEFAULT 'queued',
            status_detail VARCHAR(255),
            rag_context JSONB,
            tavily_sources JSONB,
            output_s3_key VARCHAR(1000),
            error_message TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            completed_at TIMESTAMPTZ
        );
    """)

    # Indexes for common query patterns
    cur.execute("CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON generation_jobs(user_id);")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_jobs_status ON generation_jobs(status);")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_docs_type ON documents(document_type);")

    print("✓ Migration complete — all tables and indexes created")
    cur.close()
    conn.close()


def main():
    parser = argparse.ArgumentParser(description="Run Genese Proposal AI DB migration")
    parser.add_argument("--secret-arn", required=True, help="Secrets Manager ARN for DB credentials")
    parser.add_argument("--region", default="us-east-1")
    args = parser.parse_args()

    creds = get_db_credentials(args.secret_arn, args.region)
    run_migration(
        host=creds["host"],
        port=int(creds.get("port", 5432)),
        dbname=creds.get("dbname", "genese"),
        username=creds["username"],
        password=creds["password"],
    )


if __name__ == "__main__":
    main()
