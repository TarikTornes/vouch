# Vouch — production image. Code is root-owned and read-only for the app user; only /data is writable.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .
RUN useradd --create-home --uid 10001 vouch && mkdir -p /data && chown vouch:vouch /data
USER vouch

ENV VOUCH_DB_PATH=/data/vouch.db \
    VOUCH_ALLOW_REGISTRATION=true \
    VOUCH_DEMO_MODE=false \
    OLLAMA_HOST=http://ollama:11434

EXPOSE 8501
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8501/_stcore/health', timeout=4)"
CMD ["streamlit", "run", "app.py", "--server.address=0.0.0.0", "--server.port=8501"]
