"""Settings, release forms and notifications (plan-v6, `settings.py`)."""
from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix="/of", tags=["of-api"])
