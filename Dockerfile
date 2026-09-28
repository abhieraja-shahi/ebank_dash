# ── Stage 1: Build React frontend ─────────────────────────────────────────────
FROM node:20-alpine AS frontend-build

WORKDIR /build
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build

# ── Stage 2: Final image — Python + nginx + supervisord ───────────────────────
FROM python:3.12-slim

# Install nginx and supervisor
RUN apt-get update \
    && apt-get install -y --no-install-recommends nginx supervisor \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/nginx/sites-enabled/default

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# Install Python dependencies
WORKDIR /app
COPY backend/pyproject.toml backend/uv.lock* ./
RUN uv sync --no-dev --no-cache

# Copy backend source
COPY backend/main.py .

# Copy built frontend into nginx web root
COPY --from=frontend-build /build/dist /usr/share/nginx/html

# nginx and supervisor config
COPY nginx.conf       /etc/nginx/conf.d/default.conf
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1/api/health', timeout=4)" || exit 1

CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
