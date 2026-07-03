"""
Database migration v2 — adds outcome, proposal_score, and pdf_s3_key columns
to the generation_jobs table.

Usage:
    DB_SECRET_ARN=<arn> AWS_REGION=us-east-1 python db_migration_v2.py
"""
import json
import os
import sys

import boto3
import psycopg2

region = os.environ.get("AWS_REGION", "us-east-1")
sm = boto3.client("secretsmanager", region_name=region)

secret_arn = os.environ.get("DB_SECRET_ARN", "")
if not secret_arn:
    print("ERROR: DB_SECRET_ARN environment variable is not set", file=sys.stderr)
    sys.exit(1)

s = json.loads(sm.get_secret_value(SecretId=secret_arn)["SecretString"])

conn = psycopg2.connect(
    host=s["host"],
    port=int(s.get("port", 5432)),
    dbname=s.get("dbname", "genese"),
    user=s["username"],
    password=s["password"],
)
# autocommit — DDL does not need an explicit transaction
conn.set_isolation_level(0)

cur = conn.cursor()

cur.execute(
    "ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS outcome VARCHAR(20) DEFAULT 'pending';"
)
cur.execute(
    "ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS proposal_score JSONB;"
)
cur.execute(
    "ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS pdf_s3_key VARCHAR(1000);"
)

print("Migration v2: added outcome, proposal_score, pdf_s3_key")

# arch_references table
cur.execute("""
    CREATE TABLE IF NOT EXISTS arch_references (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        description TEXT,
        engagement_type VARCHAR(100) DEFAULT 'general',
        s3_key VARCHAR(1000) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
    );
""")
print("Migration v2: arch_references table ready")

# sections_content column for inline reading of generated docs
cur.execute("""
    ALTER TABLE generation_jobs
    ADD COLUMN IF NOT EXISTS sections_content JSONB;
""")
print("Migration v2: sections_content column ready")

# drawio_s3_key for draw.io export
cur.execute("""
    ALTER TABLE generation_jobs
    ADD COLUMN IF NOT EXISTS drawio_s3_key VARCHAR(1000);
""")
print("Migration v2 complete")
cur.close()
conn.close()
