"""Upstream `/of/*` route modules (plan-v5 §1.10). `app.py` includes every router in `ROUTERS`."""
from routes import passthrough

ROUTERS = [passthrough.router]
