"""Tests for group membership metadata."""

import pytest

from api.models.entity import GroupMemberRequest
from api.routes.entities import add_group_member
from core.ports.graph_db import Node


class FakeGraphDB:
    def __init__(self) -> None:
        self.group_address = "0x" + "1" * 40
        self.added: tuple[str, str, str | None] | None = None
        self.members: list[Node] = []

    async def get_node(self, address: str) -> Node | None:
        if address != self.group_address:
            return None
        return Node(
            address=address,
            labels=["Contract"],
            properties={
                "entity_type": "Contract",
                "risk_level": "unknown",
                "name": "Investigation group",
            },
        )

    async def get_group_parent(self, member_address: str) -> None:
        return None

    async def add_group_member(
        self,
        group_address: str,
        member_address: str,
        note: str | None = None,
    ) -> None:
        self.added = (group_address, member_address, note)
        self.members = [
            Node(
                address=member_address,
                labels=["EOA"],
                properties={
                    "entity_type": "EOA",
                    "risk_level": "high",
                    "membership_note": note,
                    "membership_added_at": "2026-05-27T00:00:00+00:00",
                },
            )
        ]

    async def get_group_members(self, group_address: str) -> list[Node]:
        return self.members


@pytest.mark.asyncio
async def test_add_group_member_stores_and_returns_note() -> None:
    graph_db = FakeGraphDB()
    member_address = "0x" + "2" * 40

    response = await add_group_member(
        graph_db.group_address,
        GroupMemberRequest(member_address=member_address, note="Seed address cluster"),
        graph_db,
    )

    assert graph_db.added == (
        graph_db.group_address,
        member_address,
        "Seed address cluster",
    )
    assert response.members[0].membership_note == "Seed address cluster"
    assert response.members[0].membership_added_at == "2026-05-27T00:00:00+00:00"
    assert "membership_note" not in response.members[0].properties
