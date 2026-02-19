"""
MinIO/S3 adapter implementing the ObjectStorage protocol.
"""

import io
from typing import Any, AsyncIterator

from minio import Minio
from minio.error import S3Error

from core.ports.object_storage import ObjectStorage, StorageObject
from libs import logger


class MinioAdapter:
    """MinIO/S3-compatible implementation of the ObjectStorage protocol."""

    def __init__(
        self,
        endpoint: str,
        access_key: str,
        secret_key: str,
        bucket: str,
        secure: bool = False,
        region: str | None = None,
    ) -> None:
        self._endpoint = endpoint
        self._access_key = access_key
        self._secret_key = secret_key
        self._bucket = bucket
        self._secure = secure
        self._region = region
        self._client: Minio | None = None

    async def connect(self) -> None:
        """Initialize the MinIO client."""
        self._client = Minio(
            self._endpoint,
            access_key=self._access_key,
            secret_key=self._secret_key,
            secure=self._secure,
            region=self._region,
        )

        # Ensure bucket exists
        if not self._client.bucket_exists(self._bucket):
            self._client.make_bucket(self._bucket)
            logger.info("minio_bucket_created", bucket=self._bucket)

        logger.info("minio_connected", endpoint=self._endpoint, bucket=self._bucket)

    async def close(self) -> None:
        """Close any connections (MinIO client is stateless)."""
        self._client = None
        logger.info("minio_disconnected")

    @property
    def client(self) -> Minio:
        if not self._client:
            raise RuntimeError("MinIO not connected. Call connect() first.")
        return self._client

    async def put(
        self,
        key: str,
        data: bytes,
        content_type: str | None = None,
        metadata: dict[str, str] | None = None,
    ) -> None:
        """Store an object in MinIO."""
        data_stream = io.BytesIO(data)
        self.client.put_object(
            self._bucket,
            key,
            data_stream,
            length=len(data),
            content_type=content_type or "application/octet-stream",
            metadata=metadata,
        )
        logger.debug("minio_put", key=key, size=len(data))

    async def get(self, key: str) -> bytes:
        """Retrieve an object from MinIO."""
        try:
            response = self.client.get_object(self._bucket, key)
            try:
                return response.read()
            finally:
                response.close()
                response.release_conn()
        except S3Error as e:
            if e.code == "NoSuchKey":
                raise KeyError(f"Object not found: {key}") from e
            raise

    async def get_stream(self, key: str) -> AsyncIterator[bytes]:
        """Retrieve an object as a stream."""
        try:
            response = self.client.get_object(self._bucket, key)
            try:
                chunk_size = 64 * 1024  # 64KB chunks
                while True:
                    chunk = response.read(chunk_size)
                    if not chunk:
                        break
                    yield chunk
            finally:
                response.close()
                response.release_conn()
        except S3Error as e:
            if e.code == "NoSuchKey":
                raise KeyError(f"Object not found: {key}") from e
            raise

    async def delete(self, key: str) -> None:
        """Delete an object from MinIO."""
        self.client.remove_object(self._bucket, key)
        logger.debug("minio_delete", key=key)

    async def exists(self, key: str) -> bool:
        """Check if an object exists."""
        try:
            self.client.stat_object(self._bucket, key)
            return True
        except S3Error as e:
            if e.code == "NoSuchKey":
                return False
            raise

    async def list_objects(
        self,
        prefix: str = "",
        max_keys: int = 1000,
        continuation_token: str | None = None,
    ) -> tuple[list[StorageObject], str | None]:
        """List objects with optional prefix."""
        objects: list[StorageObject] = []
        count = 0

        # MinIO's list_objects returns an iterator
        for obj in self.client.list_objects(
            self._bucket,
            prefix=prefix,
            recursive=True,
        ):
            if count >= max_keys:
                # Return the last object name as continuation token
                return objects, obj.object_name

            objects.append(
                StorageObject(
                    key=obj.object_name,
                    size=obj.size,
                    last_modified=(
                        obj.last_modified.timestamp() if obj.last_modified else None
                    ),
                    content_type=obj.content_type,
                )
            )
            count += 1

        return objects, None

    async def get_presigned_url(
        self, key: str, expires_in: int = 3600, method: str = "GET"
    ) -> str:
        """Generate a presigned URL."""
        from datetime import timedelta

        if method.upper() == "PUT":
            return self.client.presigned_put_object(
                self._bucket,
                key,
                expires=timedelta(seconds=expires_in),
            )
        else:
            return self.client.presigned_get_object(
                self._bucket,
                key,
                expires=timedelta(seconds=expires_in),
            )

    async def health_check(self) -> bool:
        """Check if MinIO is accessible."""
        try:
            self.client.bucket_exists(self._bucket)
            return True
        except Exception as e:
            logger.error("minio_health_check_failed", error=str(e))
            return False


# Type assertion to verify protocol compliance
def _check_protocol() -> None:
    adapter: ObjectStorage = MinioAdapter("", "", "", "")
    assert isinstance(adapter, ObjectStorage)
