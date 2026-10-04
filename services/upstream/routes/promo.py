"""Tracking links, trial links, promotions and bundles (plan-v6, `promo.py`)."""
from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix="/of", tags=["of-api"])
