# scripts/lib/retry.py
"""Gradient retry utility with exponential backoff."""

import time
from functools import wraps
from typing import Callable, TypeVar, Any

T = TypeVar("T")

class RetryExhaustedError(Exception):
    """Raised when all retry attempts are exhausted."""

    def __init__(self, message: str, last_error: Exception = None):
        super().__init__(message)
        self.last_error = last_error

def retry_with_backoff(
    max_retries: int = 3,
    delays: list[float] = None,
    exceptions: tuple = (Exception,),
):
    """
    Decorator that retries a function with gradient backoff.

    Args:
        max_retries: Maximum number of retry attempts
        delays: List of delay seconds between retries (default: [1, 5, 30])
        exceptions: Tuple of exceptions to catch and retry
    """
    if delays is None:
        delays = [1, 5, 30]

    def decorator(func: Callable[..., T]) -> Callable[..., T]:
        @wraps(func)
        def wrapper(*args, **kwargs) -> T:
            last_error = None
            for attempt in range(max_retries + 1):
                try:
                    return func(*args, **kwargs)
                except exceptions as e:
                    last_error = e
                    if attempt < max_retries:
                        delay = delays[attempt] if attempt < len(delays) else delays[-1]
                        time.sleep(delay)
                    else:
                        raise RetryExhaustedError(
                            f"Retry exhausted after {max_retries} attempts. Last error: {e}",
                            last_error=e,
                        )
            # Should not reach here
            raise RetryExhaustedError(
                f"Retry exhausted after {max_retries} attempts",
                last_error=last_error,
            )
        return wrapper
    return decorator

def retry_call(
    func: Callable[..., T],
    args: tuple = (),
    kwargs: dict = None,
    max_retries: int = 3,
    delays: list[float] = None,
    exceptions: tuple = (Exception,),
) -> T:
    """
    Functional version of retry_with_backoff.
    Calls func(*args, **kwargs) with retry logic.
    """
    if kwargs is None:
        kwargs = {}

    if delays is None:
        delays = [1, 5, 30]

    last_error = None
    for attempt in range(max_retries + 1):
        try:
            return func(*args, **kwargs)
        except exceptions as e:
            last_error = e
            if attempt < max_retries:
                delay = delays[attempt] if attempt < len(delays) else delays[-1]
                time.sleep(delay)
            else:
                raise RetryExhaustedError(
                    f"Retry exhausted after {max_retries} attempts. Last error: {e}",
                    last_error=e,
                )

    raise RetryExhaustedError(
        f"Retry exhausted after {max_retries} attempts",
        last_error=last_error,
    )
