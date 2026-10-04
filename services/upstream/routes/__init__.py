"""Upstream `/of/*` route modules (plan-v5 §1.10). `app.py` includes every router in `ROUTERS`."""
from routes import chats, content, fans, money, passthrough, promo, settings

ROUTERS = [chats.router, fans.router, content.router, money.router, promo.router, settings.router, passthrough.router]
