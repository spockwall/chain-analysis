"""
Configuration system with environment-based switching for cloud service substitutability.

Loads configuration from:
1. Environment variables (highest priority)
2. .env file (if exists)
3. Default values (fallback)
"""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


def _find_env_file() -> str | None:
    """Find .env file in current directory or parent directories."""
    current = Path.cwd()
    for directory in [current, *current.parents]:
        env_path = directory / ".env"
        if env_path.exists():
            return str(env_path)
    return None


class Settings(BaseSettings):
    """Application settings with support for local, cloud, and production environments."""

    model_config = SettingsConfigDict(
        env_file=_find_env_file(),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # Environment
    environment: Literal["local", "aws", "gcp", "production"] = "local"

    # =========================================================================
    # Graph Database
    # =========================================================================
    graph_db_provider: Literal["neo4j", "neptune"] = "neo4j"
    neo4j_uri: str = "bolt://localhost:7687"
    neo4j_user: str = "neo4j"
    neo4j_password: str = "password123"

    # =========================================================================
    # PostgreSQL
    # =========================================================================
    postgres_host: str = "localhost"
    postgres_port: int = 5432
    postgres_db: str = "chain_analysis"
    postgres_user: str = "postgres"
    postgres_password: str = "postgres123"

    # Computed connection strings
    @property
    def database_url(self) -> str:
        """Async database URL for asyncpg."""
        return (
            f"postgresql+asyncpg://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @property
    def database_url_sync(self) -> str:
        """Sync database URL for Alembic."""
        return (
            f"postgresql://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    # =========================================================================
    # Message Queue
    # =========================================================================
    queue_provider: Literal["redis", "kafka", "sqs"] = "redis"
    redis_url: str = "redis://localhost:6379"
    ingest_targeted_queue: str = "ingest:targeted_queue"

    # Kafka (alternative)
    kafka_bootstrap_servers: str = "localhost:9092"

    # SQS (AWS)
    aws_region: str = "us-east-1"
    sqs_queue_url: str | None = None

    # =========================================================================
    # Data Sources
    # =========================================================================
    allium_api_key: str | None = None
    allium_base_url: str = "https://api.allium.so"
    etherscan_api_key: str | None = None

    # =========================================================================
    # Auth / JWT
    # =========================================================================
    jwt_secret_key: str = "change-me-in-production-use-a-long-random-secret"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 24  # 24 hours

    # =========================================================================
    # API Configuration
    # =========================================================================
    api_host: str = "0.0.0.0"
    api_port: int = 8000
    api_reload: bool = True
    cors_origins: list[str] = Field(
        default=["http://localhost:3000", "http://localhost:5173"]
    )

    # Rate limiting (slowapi style strings, e.g. "5/minute", "100/hour")
    rate_limit_ingest: str = "5/minute"
    rate_limit_labels: str = "30/minute"

    # =========================================================================
    # Dagster
    # =========================================================================
    dagster_home: str = "/tmp/dagster"

    # =========================================================================
    # Rust Workers
    # =========================================================================
    rust_worker_log_level: str = "info"
    ingest_batch_size: int = 1000
    ingest_parallelism: int = 4


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
