"""Load documents from S3 into text for chunking."""
import io
import boto3
from pypdf import PdfReader
from docx import Document as DocxDocument
from ..core.config import get_settings


def load_document_from_s3(s3_key: str) -> str:
    """Download a document from S3 and extract its text content."""
    settings = get_settings()
    s3 = boto3.client("s3", region_name=settings.aws_region)
    response = s3.get_object(Bucket=settings.documents_bucket, Key=s3_key)
    content = response["Body"].read()

    filename = s3_key.split("/")[-1].lower()

    if filename.endswith(".pdf"):
        return _extract_pdf_text(content)
    elif filename.endswith(".docx"):
        return _extract_docx_text(content)
    elif filename.endswith(".txt"):
        return content.decode("utf-8", errors="replace")
    else:
        # Attempt to decode as plain text
        return content.decode("utf-8", errors="replace")


def _extract_pdf_text(content: bytes) -> str:
    """Extract text from a PDF file."""
    reader = PdfReader(io.BytesIO(content))
    pages = [page.extract_text() or "" for page in reader.pages]
    return "\n\n".join(pages)


def _extract_docx_text(content: bytes) -> str:
    """Extract text from a Word document."""
    doc = DocxDocument(io.BytesIO(content))
    paragraphs = [para.text for para in doc.paragraphs if para.text.strip()]
    return "\n\n".join(paragraphs)
