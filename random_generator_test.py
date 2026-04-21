"""Tests for random_generator.py"""

import random_generator
import pytest


def test_generate_random_int_default_range():
    """Test default range (1-100)."""
    result = random_generator.generate_random_int()
    assert 1 <= result <= 100


def test_generate_random_int_custom_range():
    """Test custom range."""
    result = random_generator.generate_random_int(10, 20)
    assert 10 <= result <= 20


def test_generate_random_int_negative_range():
    """Test negative number range."""
    result = random_generator.generate_random_int(-50, -10)
    assert -50 <= result <= -10


def test_generate_random_int_same_min_max():
    """Test when min equals max."""
    result = random_generator.generate_random_int(42, 42)
    assert result == 42


def test_generate_random_int_result_type():
    """Test that result is an integer."""
    result = random_generator.generate_random_int()
    assert isinstance(result, int)