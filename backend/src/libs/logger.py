"""
Centralized logging configuration using loguru.

Usage:
    from libs import logger

    logger.info("message", key="value")
    logger.error("error occurred", error=str(e))
"""

import sys
from typing import Any

from loguru import logger as _logger

# Remove default handler
_logger.remove()

# Add custom handler with JSON format for production, pretty format for dev
_logger.add(
    sys.stderr,
    format="<green>{time:YYYY-MM-DD HH:mm:ss}</green> | <level>{level: <8}</level> | <cyan>{name}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> - <level>{message}</level> | {extra}",
    level="DEBUG",
    colorize=True,
    serialize=False,  # Set to True for JSON output in production
)


def configure_logger(
    level: str = "INFO",
    json_format: bool = False,
    log_file: str | None = None,
) -> None:
    """
    Configure the logger with custom settings.

    Args:
        level: Log level (DEBUG, INFO, WARNING, ERROR, CRITICAL)
        json_format: If True, output logs as JSON
        log_file: Optional file path to write logs to
    """
    _logger.remove()

    # Console handler
    _logger.add(
        sys.stderr,
        format=(
            "{message}"
            if json_format
            else "<green>{time:YYYY-MM-DD HH:mm:ss}</green> | <level>{level: <8}</level> | <cyan>{name}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> - <level>{message}</level> | {extra}"
        ),
        level=level.upper(),
        colorize=not json_format,
        serialize=json_format,
    )

    # File handler (optional)
    if log_file:
        _logger.add(
            log_file,
            rotation="10 MB",
            retention="7 days",
            compression="gz",
            level=level.upper(),
            serialize=True,
        )


# Export configured logger
logger = _logger
