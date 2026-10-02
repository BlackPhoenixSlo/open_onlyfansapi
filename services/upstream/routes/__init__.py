"""Upstream `/of/*` route modules (plan-v5 §1.10). `app.py` includes every router in `ROUTERS`."""
from routes import chats, content, fans, money, passthrough

ROUTERS = [chats.router, fans.router, content.router, money.router, passthrough.router]
