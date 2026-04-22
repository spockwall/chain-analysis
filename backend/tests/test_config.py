"""Tests for configuration module."""

import os

import pytest

from src.core.config import Settings, get_settings


class TestSettings:
    """Tests for Settings class."""

    def test_default_settings(self):
        """Test default settings values."""
        settings = Settings()

        assert settings.environment == "local"
        assert settings.graph_db_provider == "neo4j"
        assert settings.queue_provider == "redis"

    def test_database_url_property(self):
        """Test database URL generation."""
        settings = Settings(
            postgres_user="testuser",
            postgres_password="testpass",
            postgres_host="testhost",
            postgres_port=5433,
            postgres_db="testdb",
        )

        assert settings.database_url == (
            "postgresql+asyncpg://testuser:testpass@testhost:5433/testdb"
        )
        assert settings.database_url_sync == (
            "postgresql://testuser:testpass@testhost:5433/testdb"
        )

    def test_cors_origins_default(self):
        """Test CORS origins default value."""
        settings = Settings()

        assert "http://localhost:3000" in settings.cors_origins
        assert "http://localhost:5173" in settings.cors_origins

    def test_get_settings_cached(self):
        """Test that get_settings returns cached instance."""
        settings1 = get_settings()
        settings2 = get_settings()

        assert settings1 is settings2


class TestEnvironmentOverrides:
    """Tests for environment variable overrides."""

    def test_environment_override(self, monkeypatch):
        """Test that environment variables override defaults."""
        monkeypatch.setenv("ENVIRONMENT", "aws")
        monkeypatch.setenv("NEO4J_URI", "bolt://neo4j-aura:7687")

        # Clear the cached settings
        get_settings.cache_clear()

        settings = Settings()
        assert settings.environment == "aws"
        assert settings.neo4j_uri == "bolt://neo4j-aura:7687"

        # Restore
        get_settings.cache_clear()
