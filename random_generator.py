#!/usr/bin/env python3
"""Random number generator utility."""

import argparse
import random


def generate_random_int(min_val: int = 1, max_val: int = 100) -> int:
    """Generate a random integer between min_val and max_val (inclusive).

    Args:
        min_val: Minimum value (default 1)
        max_val: Maximum value (default 100)

    Returns:
        Random integer in [min_val, max_val]
    """
    return random.randint(min_val, max_val)


def main():
    parser = argparse.ArgumentParser(description="Generate a random number")
    parser.add_argument("--min", type=int, default=1, help="Minimum value (default: 1)")
    parser.add_argument("--max", type=int, default=100, help="Maximum value (default: 100)")
    args = parser.parse_args()

    result = generate_random_int(args.min, args.max)
    print(result)


if __name__ == "__main__":
    main()