"""In-memory request rate limiting middleware."""

from __future__ import annotations

import asyncio
import math
import time
from collections import deque
from dataclasses import dataclass

from fastapi import Request, status
from fastapi.responses import JSONResponse


@dataclass(frozen=True)
class RateLimitPolicy:
    window_seconds: int
    general_limit: int
    write_limit: int
    auth_limit: int


class SlidingWindowLimiter:
    """Simple in-process sliding-window limiter."""

    def __init__(self) -> None:
        self._events: dict[str, deque[float]] = {}
        self._lock = asyncio.Lock()

    async def allow(self, *, key: str, limit: int, window_seconds: int) -> tuple[bool, int]:
        now = time.monotonic()
        window = float(max(1, window_seconds))
        allowed_limit = max(1, limit)
        retry_after = 1

        async with self._lock:
            q = self._events.setdefault(key, deque())
            threshold = now - window
            while q and q[0] <= threshold:
                q.popleft()

            if len(q) >= allowed_limit:
                retry_after = int(math.ceil(window - (now - q[0])))
                return False, max(1, retry_after)

            q.append(now)

            # Periodic cleanup of empty buckets keeps memory bounded.
            if len(self._events) > 2000:
                stale = [event_key for event_key, values in self._events.items() if not values]
                for event_key in stale:
                    self._events.pop(event_key, None)

            return True, retry_after


def _client_key(request: Request) -> str:
    forwarded_for = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    if forwarded_for:
        return forwarded_for
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


def _bucket_for_request(*, path: str, method: str, api_base_path: str) -> str:
    normalized_method = method.upper()
    normalized_path = str(path or "")
    if normalized_path == f"{api_base_path}/auth/telegram" and normalized_method == "POST":
        return "auth"
    if normalized_path.startswith(api_base_path) and normalized_method in {"POST", "PUT", "PATCH", "DELETE"}:
        return "write"
    return "general"


def _limit_for_bucket(*, bucket: str, policy: RateLimitPolicy) -> int:
    if bucket == "auth":
        return policy.auth_limit
    if bucket == "write":
        return policy.write_limit
    return policy.general_limit


def build_rate_limit_middleware(*, policy: RateLimitPolicy, api_base_path: str):
    limiter = SlidingWindowLimiter()

    async def _middleware(request: Request, call_next):
        bucket = _bucket_for_request(path=request.url.path, method=request.method, api_base_path=api_base_path)
        client = _client_key(request)
        limit = _limit_for_bucket(bucket=bucket, policy=policy)

        allowed, retry_after = await limiter.allow(
            key=f"{client}:{bucket}",
            limit=limit,
            window_seconds=policy.window_seconds,
        )
        if not allowed:
            return JSONResponse(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                content={"detail": "Too many requests"},
                headers={"Retry-After": str(retry_after)},
            )

        return await call_next(request)

    return _middleware
