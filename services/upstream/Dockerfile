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

# Remote-browser login launches Chromium headed (headless=False), so the image carries Playwright's
# Chromium (+ its system deps) and Xvfb for a virtual display. Browsers live outside $HOME so the
# non-root user can run them. tini is PID 1: xvfb-run hangs forever waiting for Xvfb's ready signal
# when it is PID 1 itself, and -g forwards SIGTERM to uvicorn through the xvfb-run shell.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN python -m playwright install --with-deps chromium \
 && apt-get update && apt-get install -y --no-install-recommends xvfb xauth tini \
 && rm -rf /var/lib/apt/lists/* \
 && chmod -R a+rX /ms-playwright

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
# xvfb-run: a virtual display for the headed remote-browser login.
ENTRYPOINT ["tini", "-g", "--"]
CMD ["sh", "-c", "umask 077; exec xvfb-run -a --server-args='-screen 0 1440x900x24' uvicorn app:app --host 0.0.0.0 --port \"${PORT:-8000}\" --workers 1 --ws websockets-sansio"]
