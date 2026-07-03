"""
Database migration v4 — adds plain_text_instructions column to generation_jobs table.

This column stores optional user-provided formatting instructions that are
surfaced at the top of plain-text formatted documents:
  - None / NULL   → no formatting instructions (default behaviour)
  - '<text>'      → shown as "Format Instructions: <text>" at the document top

Only used when template_name == 'plain_text'.

Usage:
    DB_SECRET_ARN=<arn> AWS_REGION=us-east-1 python db_migration_v4.py
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
    "ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS plain_text_instructions TEXT;"
)
print("Migration v4: plain_text_instructions column added to generation_jobs")

cur.close()
conn.close()
print("Migration v4 complete")
