"""
Database migration v3 — adds template_name column to generation_jobs table.

This column stores the requested output template, e.g.:
  - None / NULL   → built-in Genese branded template (default)
  - 'plain_text'  → minimal unstyled document (no branding)
  - '<doc_type>'  → custom uploaded template for that document type

Usage:
    DB_SECRET_ARN=<arn> AWS_REGION=us-east-1 python db_migration_v3.py
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
    "ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS template_name VARCHAR(100);"
)
print("Migration v3: template_name column added to generation_jobs")

cur.close()
conn.close()
print("Migration v3 complete")
