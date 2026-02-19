"""
Message Queue protocol for Redis Streams/Kafka/SQS abstraction.
"""

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Protocol, runtime_checkable


@dataclass
class Message:
    """Represents a message from the queue."""

    id: str
    topic: str
    data: bytes
    metadata: dict[str, Any] = field(default_factory=dict)
    timestamp: float | None = None


MessageHandler = Callable[[Message], Awaitable[None]]


@runtime_checkable
class MessageQueue(Protocol):
    """
    Protocol for message queue operations.
    Implementations: RedisStreamsAdapter, KafkaAdapter (future), SQSAdapter (future)
    """

    async def connect(self) -> None:
        """Establish connection to the message queue."""
        ...

    async def close(self) -> None:
        """Close the connection."""
        ...

    async def publish(
        self,
        topic: str,
        message: bytes,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        """
        Publish a message to a topic/stream.

        Args:
            topic: Topic/stream name
            message: Message payload as bytes
            metadata: Optional metadata to attach

        Returns:
            Message ID
        """
        ...

    async def subscribe(
        self,
        topic: str,
        handler: MessageHandler,
        group: str | None = None,
        consumer: str | None = None,
    ) -> None:
        """
        Subscribe to a topic and process messages.

        Args:
            topic: Topic/stream name
            handler: Async callback for processing messages
            group: Consumer group name (for competing consumers)
            consumer: Consumer name within the group
        """
        ...

    async def ack(self, topic: str, message_id: str, group: str | None = None) -> None:
        """
        Acknowledge a message has been processed.

        Args:
            topic: Topic/stream name
            message_id: Message ID to acknowledge
            group: Consumer group name
        """
        ...

    async def get_pending(
        self, topic: str, group: str, count: int = 10
    ) -> list[Message]:
        """
        Get pending (unacknowledged) messages for a consumer group.

        Args:
            topic: Topic/stream name
            group: Consumer group name
            count: Maximum number of messages

        Returns:
            List of pending messages
        """
        ...

    async def create_topic(self, topic: str) -> None:
        """
        Create a topic/stream if it doesn't exist.

        Args:
            topic: Topic/stream name
        """
        ...

    async def health_check(self) -> bool:
        """
        Check if the queue connection is healthy.

        Returns:
            True if healthy, False otherwise
        """
        ...
