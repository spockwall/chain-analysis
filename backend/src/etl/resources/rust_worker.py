"""Dagster resource for invoking Rust workers."""

import subprocess
import uuid
from pathlib import Path
from typing import Any

import structlog
from dagster import ConfigurableResource, InitResourceContext
from pydantic import Field

logger = structlog.get_logger()


class RustWorkerResource(ConfigurableResource):
    """Resource for invoking Rust ETL workers."""

    rust_binary_dir: str = Field(
        default="../../etl-rs/target/release",
        description="Directory containing compiled Rust binaries",
    )
    ingest_binary: str = Field(
        default="ingest",
        description="Name of the ingest binary",
    )
    dry_run: bool = Field(
        default=False,
        description="Run in dry-run mode (don't write to Redis)",
    )

    def setup_for_execution(self, context: InitResourceContext) -> None:
        """Verify the Rust binary exists."""
        binary_path = Path(self.rust_binary_dir) / self.ingest_binary
        if not binary_path.exists():
            logger.warning(
                "rust_binary_not_found",
                path=str(binary_path),
                msg="Will attempt to build on first run",
            )

    def run_ingestion(
        self,
        start_block: int,
        end_block: int,
        run_id: str | None = None,
    ) -> dict[str, Any]:
        """
        Run the Rust ingestion worker for a block range.

        Args:
            start_block: Starting block number
            end_block: Ending block number
            run_id: Optional run ID for tracking

        Returns:
            Dict with run status and metadata
        """
        run_id = run_id or str(uuid.uuid4())
        binary_path = Path(self.rust_binary_dir) / self.ingest_binary

        # Build command
        cmd = [
            str(binary_path),
            "--start-block",
            str(start_block),
            "--end-block",
            str(end_block),
            "--run-id",
            run_id,
        ]

        if self.dry_run:
            cmd.append("--dry-run")

        logger.info(
            "starting_rust_worker",
            cmd=" ".join(cmd),
            run_id=run_id,
        )

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=3600,  # 1 hour timeout
            )

            if result.returncode != 0:
                logger.error(
                    "rust_worker_failed",
                    run_id=run_id,
                    returncode=result.returncode,
                    stderr=result.stderr,
                )
                return {
                    "success": False,
                    "run_id": run_id,
                    "error": result.stderr,
                    "returncode": result.returncode,
                }

            logger.info(
                "rust_worker_completed",
                run_id=run_id,
            )

            return {
                "success": True,
                "run_id": run_id,
                "stdout": result.stdout,
            }

        except subprocess.TimeoutExpired:
            logger.error("rust_worker_timeout", run_id=run_id)
            return {
                "success": False,
                "run_id": run_id,
                "error": "Worker timed out",
            }
        except FileNotFoundError:
            logger.error(
                "rust_binary_not_found",
                path=str(binary_path),
            )
            return {
                "success": False,
                "run_id": run_id,
                "error": f"Binary not found: {binary_path}",
            }
