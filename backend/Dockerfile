FROM python:3.12-slim

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app

# Copy dependency manifest (and lockfile if present)
COPY pyproject.toml uv.lock* ./

# Install dependencies — creates/uses lockfile, skips dev deps
RUN uv sync --no-dev --no-cache

# Copy application source
COPY main.py .

EXPOSE 8000

CMD ["uv", "run", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
