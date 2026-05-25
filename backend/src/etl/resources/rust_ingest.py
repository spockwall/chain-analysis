"""Resource that invokes the Rust ``ingest`` binary as a subprocess.

Uses Dagster Pipes (``PipesSubprocessClient``) so stdout/stderr stream into
the Dagster run log. The same contract works with ``PipesK8sClient`` when
we move to Kubernetes.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import TYPE_CHECKING

from dagster import ConfigurableResource, PipesSubprocessClient
from pydantic import Field

if TYPE_CHECKING:
    from dagster import OpExecutionContext, PipesClientCompletedInvocation


DEFAULT_BINARY = os.getenv(
    "RUST_INGEST_BINARY",
    "/usr/local/bin/ingest",
)


class RustIngestResource(ConfigurableResource):
    """Run the Rust ``ingest`` binary and stream its output into Dagster."""

    binary_path: str = Field(
        default=DEFAULT_BINARY,
        description="Absolute path to the compiled `ingest` binary.",
    )

    def run(
        self,
        context: OpExecutionContext,
        args: list[str],
        *,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
    ) -> PipesClientCompletedInvocation:
        """Invoke `ingest <args...>` with Pipes subprocess streaming.

        Raises ``DagsterPipesExecutionError`` on non-zero exit.
        """
        path = Path(self.binary_path)
        if not path.exists():
            raise FileNotFoundError(
                f"Rust ingest binary not found at {path}. "
                "Build with `cargo build --release -p ingest` or set RUST_INGEST_BINARY."
            )

        command = [str(path), *args]
        context.log.info(f"Running: {' '.join(command)}")

        client = PipesSubprocessClient()
        return client.run(
            context=context,
            command=command,
            env=env,
            cwd=cwd,
        )
