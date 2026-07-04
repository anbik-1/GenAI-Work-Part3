"""
Seed script — ingests synthetic Genese proposal documents into the knowledge base.
Run AFTER deployment:
  python scripts/seed_data.py --api-url https://<alb-url>
"""
import os
import sys
import time
import argparse
import requests
from pathlib import Path

SEED_DOCS_DIR = Path(__file__).parent / "seed_documents"

DOCUMENT_METADATA = {
    "proposal_aws_migration_horizon.txt":      {"type": "proposal", "engagement": "aws_migration", "client": "Horizon Financial Group"},
    "proposal_data_platform_retailmax.txt":    {"type": "proposal", "engagement": "data_platform", "client": "RetailMax Nepal"},
    "proposal_managed_services_medicare.txt":  {"type": "proposal", "engagement": "managed_services", "client": "MediCare Plus Hospital Group"},
    "proposal_security_audit_bankcorp.txt":    {"type": "proposal", "engagement": "security_audit", "client": "BankCorp Nepal"},
    "sow_cloud_infrastructure_techventure.txt":{"type": "sow", "engagement": "cloud_native_development", "client": "TechVenture Innovations"},
    "sow_devops_softglobal.txt":               {"type": "sow", "engagement": "devops_transformation", "client": "SoftGlobal Nepal"},
    "sow_data_engineering_neptelco.txt":       {"type": "sow", "engagement": "data_platform", "client": "NepTelco Communications"},
    "case_study_fintech_neppay.txt":           {"type": "case_study", "engagement": "aws_migration", "client": "NepPay Digital Finance"},
    "case_study_retail_shopnepal.txt":         {"type": "case_study", "engagement": "cloud_native_development", "client": "ShopNepal Online"},
    "case_study_healthcare_nphi.txt":          {"type": "case_study", "engagement": "data_platform", "client": "National Public Health Institute"},
}


def get_auth_token(api_url: str, email: str, password: str) -> str:
    """Get authentication token from the API."""
    # For the seed script, use admin credentials set during deployment
    response = requests.post(
        f"{api_url}/auth/token",
        json={"email": email, "password": password},
        timeout=30,
    )
    if not response.ok:
        raise RuntimeError(f"Auth failed: {response.text}")
    return response.json()["id_token"]


def upload_document(api_url: str, token: str, filepath: Path, metadata: dict) -> str:
    """Upload a document to the knowledge base. Returns document_id."""
    with open(filepath, "rb") as f:
        response = requests.post(
            f"{api_url}/documents/upload",
            files={"file": (filepath.name, f, "text/plain")},
            data={
                "document_type": metadata["type"],
                "engagement_type": metadata["engagement"],
                "client_name": metadata["client"],
            },
            headers={"Authorization": f"Bearer {token}"},
            timeout=60,
        )
    if not response.ok:
        raise RuntimeError(f"Upload failed for {filepath.name}: {response.text}")
    result = response.json()
    return result["document_id"]


def main():
    parser = argparse.ArgumentParser(description="Seed Genese Proposal AI knowledge base")
    parser.add_argument("--api-url", required=True, help="API base URL (e.g. http://alb-url)")
    parser.add_argument("--email", default=os.environ.get("SEED_EMAIL", "admin@genesesolution.com"))
    parser.add_argument("--password", default=os.environ.get("SEED_PASSWORD", ""))
    args = parser.parse_args()

    if not args.password:
        print("Error: Provide password via --password or SEED_PASSWORD env var")
        sys.exit(1)

    api_url = args.api_url.rstrip("/")
    print(f"Seeding {len(DOCUMENT_METADATA)} documents into {api_url}...")

    # Authenticate
    print("Authenticating...")
    token = get_auth_token(api_url, args.email, args.password)
    print("✓ Authenticated")

    # Upload each document
    for filename, metadata in DOCUMENT_METADATA.items():
        filepath = SEED_DOCS_DIR / filename
        if not filepath.exists():
            print(f"  ⚠ Skipping {filename} — file not found")
            continue

        try:
            doc_id = upload_document(api_url, token, filepath, metadata)
            print(f"  ✓ {filename} → document_id={doc_id}")
            time.sleep(1)  # Brief pause to avoid rate limiting
        except Exception as e:
            print(f"  ✗ {filename} — {e}")

    print(f"\n✓ Seeding complete! {len(DOCUMENT_METADATA)} documents submitted for ingestion.")
    print("Note: Ingestion runs asynchronously. Wait ~2 minutes before testing RAG search.")


if __name__ == "__main__":
    main()
