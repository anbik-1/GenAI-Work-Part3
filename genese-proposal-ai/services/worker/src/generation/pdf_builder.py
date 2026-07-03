"""PDF builder — converts a .docx bytes object to a PDF using ReportLab."""
import io
from io import BytesIO


def build_pdf_from_docx(docx_bytes: bytes, client_name: str, document_type: str) -> bytes:
    """
    Convert docx bytes to PDF using ReportLab.

    Extracts paragraph text from the .docx, then lays it out in an A4 PDF.
    Falls back to a minimal document if docx parsing fails.
    """
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
    from reportlab.lib.units import cm

    # Extract text paragraphs from the .docx
    try:
        from docx import Document
        doc = Document(io.BytesIO(docx_bytes))
        paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
    except Exception:
        paragraphs = [
            f"{client_name} - {document_type}",
            "Document content unavailable",
        ]

    buffer = BytesIO()
    pdf = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=2 * cm,
        rightMargin=2 * cm,
        topMargin=2 * cm,
        bottomMargin=2 * cm,
    )
    styles = getSampleStyleSheet()
    story = []

    for text in paragraphs:
        # Treat short ALL-CAPS lines or lines ending with ':' as headings
        if (len(text) < 80 and text.upper() == text) or text.endswith(":"):
            story.append(Paragraph(text, styles["Heading2"]))
        else:
            story.append(Paragraph(text, styles["Normal"]))
        story.append(Spacer(1, 6))

    pdf.build(story)
    return buffer.getvalue()
