"""Shared by `app.py` and `routes/*`: the API error and the per-account `OFClient` dependency.

A leaf module (it imports neither `app` nor `routes`), so the route modules load without an import cycle.
"""
from __future__ import annotations

import re
from typing import Annotated

from fastapi import Depends, Header, Request

import accounts
import client_pool
from of_client import OFClient
from of_ws import session_refused


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str | None = None) -> None:
        super().__init__(code)
        self.status, self.code, self.message = status, code, message


_ACCOUNT_ID = re.compile(r"[0-9]{1,19}")


def account_client(
    request: Request,
    x_of_proxy_account_id: Annotated[str | None, Header(include_in_schema=False)] = None,
) -> OFClient:
    """The pooled OFClient for `x-of-proxy-account-id`. Tests override this."""
    raw = (x_of_proxy_account_id or "").strip()
    if not _ACCOUNT_ID.fullmatch(raw):
        raise ApiError(400, "invalid_account_id", "x-of-proxy-account-id must be an integer")
    aid = str(int(raw))
    if not accounts.is_account(aid):
        raise ApiError(404, "unknown_account")
    supervisor = request.app.state.supervisor
    blocked = supervisor.blocker(aid)
    if blocked == "no_session":
        raise ApiError(409, "no_session")
    if blocked == "no_proxy":
        raise ApiError(409, "proxy_required")
    # session_expired is not blocked here: OF's own 401 passes through as of_error.
    try:
        client = client_pool.get(aid)
    except FileNotFoundError as e:
        raise ApiError(409, "no_session") from e
    if supervisor.require_proxy and not getattr(client, "proxy_url", None):
        raise ApiError(409, "proxy_required")  # never fall back to this host's IP
    return client


Client = Annotated[OFClient, Depends(account_client)]


def note_of_response(request: Request, resp: object) -> None:
    """OF answered this account's request with a dead-session reply (401, or 400 "Wrong
    user"): mark the account session_expired, which announces it once."""
    raw = (request.headers.get("x-of-proxy-account-id") or "").strip()
    if _ACCOUNT_ID.fullmatch(raw) and session_refused(resp):
        request.app.state.supervisor.mark_expired(str(int(raw)))
