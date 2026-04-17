# scripts/__tests__/test_retry.py
import pytest
import time
from unittest.mock import MagicMock, patch
from scripts.lib.retry import retry_with_backoff, RetryExhaustedError, retry_call

def test_retry_success_first_try():
    """Test successful call on first try."""
    mock_func = MagicMock(return_value="success")

    @retry_with_backoff(max_retries=3, delays=[0.01, 0.01, 0.01])
    def func():
        return mock_func()

    result = func()
    assert result == "success"
    assert mock_func.call_count == 1

def test_retry_success_after_failure():
    """Test successful call after one failure."""
    mock_func = MagicMock(side_effect=[Exception("error"), "success"])

    @retry_with_backoff(max_retries=3, delays=[0.01, 0.01, 0.01])
    def func():
        return mock_func()

    result = func()
    assert result == "success"
    assert mock_func.call_count == 2

def test_retry_exhausted():
    """Test that RetryExhaustedError is raised after all retries."""
    mock_func = MagicMock(side_effect=[Exception("error1"), Exception("error2"), Exception("error3"), Exception("error4")])

    @retry_with_backoff(max_retries=3, delays=[0.01, 0.01, 0.01])
    def func():
        return mock_func()

    with pytest.raises(RetryExhaustedError) as exc_info:
        func()

    assert mock_func.call_count == 4  # 1 initial + 3 retries
    assert "error4" in str(exc_info.value)

def test_retry_preserves_return_value():
    """Test that return value is preserved across retries."""
    mock_func = MagicMock(side_effect=[Exception("error1"), Exception("error2"), {"data": "value"}])

    @retry_with_backoff(max_retries=3, delays=[0.01, 0.01, 0.01])
    def func():
        return mock_func()

    result = func()
    assert result == {"data": "value"}

def test_retry_call_functional():
    """Test retry_call functional interface."""
    mock_func = MagicMock(side_effect=[Exception("error"), "success"])

    result = retry_call(
        mock_func,
        delays=[0.01, 0.01, 0.01],
    )

    assert result == "success"
    assert mock_func.call_count == 2

def test_retry_call_exhausted():
    """Test retry_call raises RetryExhaustedError."""
    mock_func = MagicMock(side_effect=[Exception("error1"), Exception("error2"), Exception("error3"), Exception("error4")])

    with pytest.raises(RetryExhaustedError) as exc_info:
        retry_call(
            mock_func,
            max_retries=3,
            delays=[0.01, 0.01, 0.01],
        )

    assert mock_func.call_count == 4  # 1 initial + 3 retries

def test_retry_specific_exceptions():
    """Test retry only catches specified exceptions."""
    mock_func = MagicMock(side_effect=[ValueError("test"), "success"])

    @retry_with_backoff(max_retries=3, delays=[0.01, 0.01, 0.01], exceptions=(ValueError,))
    def func():
        return mock_func()

    result = func()
    assert result == "success"
    assert mock_func.call_count == 2
