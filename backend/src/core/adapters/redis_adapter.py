"""
Redis Streams adapter implementing the MessageQueue protocol.
"""

import asyncio
import time
from typing import Any

from redis.asyncio import Redis

from core.ports.message_queue import Message, MessageHandler, MessageQueue
from libs import logger


class RedisStreamsAdapter:
    """Redis Streams implementation of the MessageQueue protocol."""

    def __init__(
        self,
        redis_url: str,
        max_connections: int = 10,
    ) -> None:
        self._redis_url = redis_url
        self._max_connections = max_connections
        self._redis: Redis | None = None
        self._running = False
        self._consumer_tasks: list[asyncio.Task[None]] = []

    async def connect(self) -> None:
        """Connect to Redis."""
        self._redis = Redis.from_url(
            self._redis_url,
            max_connections=self._max_connections,
            decode_responses=False,  # Keep as bytes for message data
        )
        # Verify connection
        await self._redis.ping()
        logger.info("redis_connected", url=self._redis_url)

    async def close(self) -> None:
        """Close Redis connection and stop consumers."""
        self._running = False

        # Cancel consumer tasks
        for task in self._consumer_tasks:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

        self._consumer_tasks.clear()

        if self._redis:
            await self._redis.aclose()
            self._redis = None
            logger.info("redis_disconnected")

    @property
    def redis(self) -> Redis:
        if not self._redis:
            raise RuntimeError("Redis not connected. Call connect() first.")
        return self._redis

    async def publish(
        self,
        topic: str,
        message: bytes,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        """Publish a message to a Redis Stream."""
        fields: dict[bytes, bytes] = {b"data": message}

        if metadata:
            for key, value in metadata.items():
                if isinstance(value, bytes):
                    fields[key.encode()] = value
                else:
                    fields[key.encode()] = str(value).encode()

        message_id = await self.redis.xadd(topic, fields)
        return message_id.decode() if isinstance(message_id, bytes) else str(message_id)

    async def subscribe(
        self,
        topic: str,
        handler: MessageHandler,
        group: str | None = None,
        consumer: str | None = None,
    ) -> None:
        """Subscribe to a Redis Stream and process messages."""
        # Create consumer group if specified
        if group:
            try:
                await self.redis.xgroup_create(topic, group, id="0", mkstream=True)
            except Exception as e:
                # Group might already exist
                if "BUSYGROUP" not in str(e):
                    raise

        self._running = True
        consumer_name = consumer or f"consumer-{time.time_ns()}"

        task = asyncio.create_task(
            self._consume_loop(topic, handler, group, consumer_name)
        )
        self._consumer_tasks.append(task)

    async def _consume_loop(
        self,
        topic: str,
        handler: MessageHandler,
        group: str | None,
        consumer: str,
    ) -> None:
        """Internal consume loop."""
        last_id = ">" if group else "$"

        while self._running:
            try:
                if group:
                    # Read from consumer group
                    messages = await self.redis.xreadgroup(
                        group,
                        consumer,
                        {topic: last_id},
                        count=10,
                        block=1000,
                    )
                else:
                    # Read directly from stream
                    messages = await self.redis.xread(
                        {topic: last_id},
                        count=10,
                        block=1000,
                    )

                if not messages:
                    continue

                for stream_name, stream_messages in messages:
                    for msg_id, fields in stream_messages:
                        msg_id_str = (
                            msg_id.decode()
                            if isinstance(msg_id, bytes)
                            else str(msg_id)
                        )

                        # Extract data and metadata
                        data = fields.get(b"data", b"")
                        metadata = {
                            k.decode(): v.decode()
                            for k, v in fields.items()
                            if k != b"data"
                        }

                        message = Message(
                            id=msg_id_str,
                            topic=(
                                stream_name.decode()
                                if isinstance(stream_name, bytes)
                                else str(stream_name)
                            ),
                            data=data,
                            metadata=metadata,
                            timestamp=float(msg_id_str.split("-")[0]) / 1000,
                        )

                        try:
                            await handler(message)
                        except Exception as e:
                            logger.error(
                                "message_handler_error",
                                topic=topic,
                                message_id=msg_id_str,
                                error=str(e),
                            )

                    # Update last_id for non-group reads
                    if not group and stream_messages:
                        last_id = stream_messages[-1][0]

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("consume_loop_error", topic=topic, error=str(e))
                await asyncio.sleep(1)

    async def ack(self, topic: str, message_id: str, group: str | None = None) -> None:
        """Acknowledge a message."""
        if group:
            await self.redis.xack(topic, group, message_id)

    async def get_pending(
        self, topic: str, group: str, count: int = 10
    ) -> list[Message]:
        """Get pending messages for a consumer group."""
        pending_info = await self.redis.xpending_range(
            topic, group, min="-", max="+", count=count
        )

        if not pending_info:
            return []

        # Fetch the actual messages
        message_ids = [info["message_id"] for info in pending_info]
        messages = []

        for msg_id in message_ids:
            result = await self.redis.xrange(topic, min=msg_id, max=msg_id)
            if result:
                _, fields = result[0]
                data = fields.get(b"data", b"")
                metadata = {
                    k.decode(): v.decode() for k, v in fields.items() if k != b"data"
                }
                msg_id_str = (
                    msg_id.decode() if isinstance(msg_id, bytes) else str(msg_id)
                )
                messages.append(
                    Message(
                        id=msg_id_str,
                        topic=topic,
                        data=data,
                        metadata=metadata,
                    )
                )

        return messages

    async def create_topic(self, topic: str) -> None:
        """Create a stream (it's created automatically on first write)."""
        # Redis streams are created automatically, but we can ensure it exists
        try:
            await self.redis.xinfo_stream(topic)
        except Exception:
            # Stream doesn't exist, create with a dummy entry and delete it
            msg_id = await self.redis.xadd(topic, {b"init": b"1"})
            await self.redis.xdel(topic, msg_id)

    async def health_check(self) -> bool:
        """Check if Redis is healthy."""
        try:
            await self.redis.ping()
            return True
        except Exception as e:
            logger.error("redis_health_check_failed", error=str(e))
            return False


# Type assertion to verify protocol compliance
def _check_protocol() -> None:
    adapter: MessageQueue = RedisStreamsAdapter("")
    assert isinstance(adapter, MessageQueue)
