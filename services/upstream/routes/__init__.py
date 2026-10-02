"""Upstream `/of/*` route modules (plan-v5 §1.10). `app.py` includes every router in `ROUTERS`.

Route modules import `ApiError` and `Client` from `app`, which imports this package at the end of its `/of`
section, so the entry point is always `app` (uvicorn `app:app`, the tests, the OpenAPI dump), never `routes`.
"""
from routes import passthrough

ROUTERS = [passthrough.router]
