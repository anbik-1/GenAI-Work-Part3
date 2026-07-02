FROM python:3.12-slim

# System dependencies for PDF/DOCX processing
RUN apt-get update && apt-get install -y --no-install-recommends \
    libmagic1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Set PYTHONPATH so 'shared' package is importable
ENV PYTHONPATH=/app

COPY worker/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy shared package
COPY shared ./shared

# Copy worker source
COPY worker/src ./src

RUN adduser --disabled-password --gecos "" appuser && chown -R appuser /app
USER appuser

CMD ["python", "-m", "src.main"]
