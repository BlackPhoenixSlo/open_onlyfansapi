# The upstream: OF REST + event stream for the gateway. One uvicorn worker only:
# the per-account pumps and the /ws hub live in this process.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    UPSTREAM_STATE_DIR=/data \
    PORT=8000

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin upstream \
 && mkdir -p /data \
 && chown upstream:upstream /data \
 && chmod 700 /data
COPY . .

USER upstream
VOLUME ["/data"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import os, urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\") or 8000}/healthz', timeout=4)"

# umask 077: session and proxy files (cookies, proxy passwords) are written 0600.
CMD ["sh", "-c", "umask 077; exec uvicorn app:app --host 0.0.0.0 --port \"${PORT:-8000}\" --workers 1 --ws websockets-sansio"]
