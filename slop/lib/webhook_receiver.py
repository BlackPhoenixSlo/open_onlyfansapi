"""A fake webhook receiver on loopback (never a real one): the URL each workspace registers through the real
`POST /v1/webhooks`. Every POST to `/hook/<tag>` is answered 200 and recorded (tag, idempotency key, signature,
event, account, raw body) in `deliveries` and `webhook-deliveries.jsonl`; `verified(rec, secret)` checks the
`Signature` header the way a receiver must (hex HMAC-SHA256 of the raw body).

Bypass, declared: the API runs with ALLOW_HTTP_WEBHOOKS=true, since this receiver is plain http on 127.0.0.1
(production refuses http and private addresses)."""
from __future__ import annotations

import hashlib
import hmac
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 256


class Receiver:
    def __init__(self, out: Path):
        self.deliveries: list[dict] = []
        self._lock = threading.Lock()
        self._file = open(Path(out) / "webhook-deliveries.jsonl", "a", buffering=1)  # noqa: SIM115 — closed in __exit__
        self._server: _Server | None = None

    def url(self, tag: str) -> str:
        return f"http://127.0.0.1:{self.port}/hook/{tag}"

    def __enter__(self) -> Receiver:  # noqa: PYI034
        rx = self

        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_a):
                pass

            def do_POST(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                try:
                    body = json.loads(raw)
                except ValueError:
                    body = None
                rec = {"t": time.time(), "path": self.path, "tag": self.path.removeprefix("/hook/"),
                       "key": self.headers.get("X-OFAPI-Idempotency-Key"), "signature": self.headers.get("Signature"),
                       "event": (body or {}).get("event"), "account_id": (body or {}).get("account_id"),
                       "raw": raw.decode(errors="replace")}
                with rx._lock:
                    rx.deliveries.append(rec)
                    rx._file.write(json.dumps(rec) + "\n")
                self.send_response(200)
                self.send_header("Content-Length", "0")
                self.end_headers()

        self._server = _Server(("127.0.0.1", 0), H)
        self.port = self._server.server_address[1]
        threading.Thread(target=self._server.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *_a) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
        self._file.close()

    def of_type(self, event: str) -> list[dict]:
        with self._lock:
            return [d for d in self.deliveries if d["event"] == event]

    @staticmethod
    def verified(rec: dict, secret: str) -> bool:
        want = hmac.new(secret.encode(), rec["raw"].encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(want, rec.get("signature") or "")
