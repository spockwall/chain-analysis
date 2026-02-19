"""
Object Storage protocol for S3/MinIO/GCS/Local abstraction.
"""

from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Protocol, runtime_checkable


@dataclass
class StorageObject:
    """Represents a storage object metadata."""

    key: str
    size: int
    last_modified: float | None = None
    content_type: str | None = None
    metadata: dict[str, str] = field(default_factory=dict)


@runtime_checkable
class ObjectStorage(Protocol):
    """
    Protocol for object storage operations.
    Implementations: MinioAdapter, S3Adapter (future), GCSAdapter (future), LocalFSAdapter
    """

    async def connect(self) -> None:
        """Initialize the storage client."""
        ...

    async def close(self) -> None:
        """Close any connections."""
        ...

    async def put(
        self,
        key: str,
        data: bytes,
        content_type: str | None = None,
        metadata: dict[str, str] | None = None,
    ) -> None:
        """
        Store an object.

        Args:
            key: Object key/path
            data: Object data as bytes
            content_type: MIME type
            metadata: Custom metadata
        """
        ...

    async def get(self, key: str) -> bytes:
        """
        Retrieve an object.

        Args:
            key: Object key/path

        Returns:
            Object data as bytes

        Raises:
            KeyError: If object doesn't exist
        """
        ...

    async def get_stream(self, key: str) -> AsyncIterator[bytes]:
        """
        Retrieve an object as a stream (for large files).

        Args:
            key: Object key/path

        Yields:
            Chunks of object data

        Raises:
            KeyError: If object doesn't exist
        """
        ...

    async def delete(self, key: str) -> None:
        """
        Delete an object.

        Args:
            key: Object key/path
        """
        ...

    async def exists(self, key: str) -> bool:
        """
        Check if an object exists.

        Args:
            key: Object key/path

        Returns:
            True if exists, False otherwise
        """
        ...

    async def list_objects(
        self,
        prefix: str = "",
        max_keys: int = 1000,
        continuation_token: str | None = None,
    ) -> tuple[list[StorageObject], str | None]:
        """
        List objects with optional prefix.

        Args:
            prefix: Key prefix filter
            max_keys: Maximum number of keys to return
            continuation_token: Token for pagination

        Returns:
            Tuple of (list of objects, next continuation token or None)
        """
        ...

    async def get_presigned_url(
        self, key: str, expires_in: int = 3600, method: str = "GET"
    ) -> str:
        """
        Generate a presigned URL for direct access.

        Args:
            key: Object key/path
            expires_in: URL expiration time in seconds
            method: HTTP method (GET or PUT)

        Returns:
            Presigned URL
        """
        ...

    async def health_check(self) -> bool:
        """
        Check if the storage is accessible.

        Returns:
            True if healthy, False otherwise
        """
        ...
