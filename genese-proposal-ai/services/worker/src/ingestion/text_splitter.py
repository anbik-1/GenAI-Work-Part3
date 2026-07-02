"""Text chunking using LangChain's RecursiveCharacterTextSplitter."""
from langchain.text_splitter import RecursiveCharacterTextSplitter
from shared import CHUNK_SIZE, CHUNK_OVERLAP


def split_text(text: str) -> list[str]:
    """
    Split document text into overlapping chunks for embedding.
    Uses RecursiveCharacterTextSplitter for semantic-aware splitting.
    """
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=CHUNK_SIZE,
        chunk_overlap=CHUNK_OVERLAP,
        separators=["\n\n", "\n", ". ", " ", ""],
        length_function=len,
    )
    chunks = splitter.split_text(text)
    # Filter empty/very short chunks
    return [c.strip() for c in chunks if len(c.strip()) > 50]
