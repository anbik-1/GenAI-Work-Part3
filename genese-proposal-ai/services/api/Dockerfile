FROM python:3.12-slim

WORKDIR /app

# Set PYTHONPATH so 'shared' package is importable
ENV PYTHONPATH=/app

# Install dependencies
COPY api/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy shared package
COPY shared ./shared

# Copy application source
COPY api/src ./src

# Non-root user for security
RUN adduser --disabled-password --gecos "" appuser && chown -R appuser /app
USER appuser

EXPOSE 8000

CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000"]
