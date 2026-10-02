"""Payouts, banking, statistics and transactions (plan-v5 Phase 4, `money.py`)."""
from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix="/of", tags=["of-api"])
