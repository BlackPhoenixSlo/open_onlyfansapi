"""Fans, users, lists and the account itself (plan-v5 Phase 3, `fans.py`)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from deps import Client

router = APIRouter(prefix="/of", tags=["of-api"])


@router.get("/me", operation_id="me.get")
def me(client: Client) -> Any:
    return client.me()
