"""Connect an OF account: POST a DevTools curl (stdin) to this upstream's /session/bootstrap.

    docker compose exec -T upstream python connect.py --nickname Main --proxy-url socks5://u:p@host:port < curl.txt
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
ap.add_argument("--nickname")
ap.add_argument("--static-param", dest="static_param")
ap.add_argument("--proxy-url", dest="proxy_url")
args = ap.parse_args()

body = {"curl": sys.stdin.read(), **{k: v for k, v in vars(args).items() if v}}
req = urllib.request.Request(
    f"http://127.0.0.1:{os.environ.get('PORT') or 8000}/session/bootstrap",
    data=json.dumps(body).encode(),
    headers={"Authorization": f"Bearer {os.environ.get('UPSTREAM_TOKEN', '')}",
             "Content-Type": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=120) as r:
        print(r.read().decode())
except urllib.error.HTTPError as e:
    sys.exit(f"bootstrap failed ({e.code}): {e.read().decode()}")
