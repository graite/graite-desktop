"""The sync engine on two vaults handed each other's changes directly (no network): what a
device does with a version another one made (graite/sync/engine.py, state.py, merge.py)."""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path

import pytest

from graite.events import EventBus
from graite.index import db
from graite.review.proposals import Proposals
from graite.sync import merge
from graite.sync.engine import Engine
from graite.sync.state import Entry, compare, entry_from_wire, syncable
from graite.vault.fileops import FileOps, StaleFile
from graite.vault.watcher import Watcher

NAMES = {"replica-a": "Laptop", "replica-b": "Desk", "replica-c": "Phone"}


@dataclass
class Device:
    name: str
    vault: Path
    ops: FileOps
    queue: Proposals
    engine: Engine

    def text(self, path: str) -> str:
        return (self.vault / path).read_text(encoding="utf-8")

    def write(self, path: str, text: str) -> None:
        target = self.vault / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")

    def files(self) -> dict[str, str]:
        return dict(self.engine.state.live())

    def pending(self) -> list[dict[str, object]]:
        return self.queue.find(status="pending")


def device(tmp_path: Path, replica: str) -> Device:
    vault = tmp_path / replica
    vault.mkdir()
    conn = db.connect(vault / ".graite" / "index.sqlite")
    events = EventBus()
    ops = FileOps(vault, conn, events)
    queue = Proposals(conn, ops, events)
    engine = Engine(
        vault=vault,
        db=conn,
        fileops=ops,
        watcher=Watcher(vault, ops, events),
        proposals=queue,
        space_id="space-1",
        replica_id=replica,
        device_name=lambda r: NAMES.get(r, "another device"),
    )
    return Device(replica, vault, ops, queue, engine)


async def send(source: Device, target: Device, entries: list[Entry]) -> list[str]:
    """Hand versions from one device to another, the bytes copied as a peer would send them."""
    outcomes = []
    for entry in entries:

        async def fetch(entry: Entry = entry) -> Path | None:
            held = source.engine.content(entry)
            if held is None:
                return None
            copy = target.engine.temp()
            shutil.copyfile(held, copy)
            return copy

        outcomes.append(await target.engine.receive(entry, fetch))
    return outcomes


async def settle(*devices: Device) -> None:
    """Scan and pass changes around until nobody has anything new to say."""
    for _ in range(10):
        quiet = True
        for source in devices:
            await source.engine.scan()
            changes = source.engine.drain()
            quiet = quiet and not changes
            for target in devices:
                if target is not source:
                    await send(source, target, changes)
        if quiet:
            return
    raise AssertionError("the devices never settled")


@pytest.fixture
def pair(tmp_path: Path) -> tuple[Device, Device]:
    return device(tmp_path, "replica-a"), device(tmp_path, "replica-b")


async def page(dev: Device, title: str, body: str) -> str:
    doc = await dev.ops.create_page(None, title, None, "ui")
    await dev.ops.write_body(doc.path, body, None, "ui")
    return f"{doc.path}/page.md"


async def test_new_pages_edits_and_assets_reach_the_other_device(
    pair: tuple[Device, Device],
) -> None:
    a, b = pair
    path = await page(a, "Plan", "First line.\n")
    a.write("Plan/_assets/photo.bin", "\x00binary")
    a.write("AGENTS.md", "Be brief.\n")
    await settle(a, b)
    assert b.text(path) == a.text(path)
    assert b.text("Plan/_assets/photo.bin") == "\x00binary"
    assert b.files() == a.files() and len(a.files()) == 3
    # The index on the receiving device knows the page, as after any outside change.
    assert (await b.ops.read_page("Plan")).body == "First line.\n"
    await b.ops.write_body("Plan", "First line.\n\nSecond, from the desk.\n", None, "ui")
    await settle(a, b)
    assert "from the desk" in a.text(path)
    assert a.files() == b.files()


async def test_device_state_and_generated_files_stay_put(pair: tuple[Device, Device]) -> None:
    a, b = pair
    await page(a, "Plan", "Text.\n")
    a.write("NAVIGATION.md", "generated")
    a.write(".graite/skills/review/SKILL.md", "A vault skill.\n")
    a.write(".obsidian/app.json", "{}")
    a.write("Plan/.hidden", "x")
    await settle(a, b)
    assert set(b.files()) == {"Plan/page.md", ".graite/skills/review/SKILL.md"}
    assert not (b.vault / "NAVIGATION.md").exists()


async def test_a_deletion_travels_and_the_file_is_kept_for_a_while(
    pair: tuple[Device, Device],
) -> None:
    a, b = pair
    path = await page(a, "Old", "To go.\n")
    await settle(a, b)
    await a.ops.trash_page("Old", "ui")
    await settle(a, b)
    assert not (b.vault / path).exists() and not (b.vault / "Old").exists()
    kept = list((b.vault / ".graite" / "sync" / "deleted").rglob("page.md"))
    assert len(kept) == 1 and "To go." in kept[0].read_text(encoding="utf-8")
    assert a.files() == b.files() == {}
    with pytest.raises(FileNotFoundError):
        await b.ops.read_page("Old")


async def test_a_moved_file_is_copied_locally_not_fetched(pair: tuple[Device, Device]) -> None:
    a, b = pair
    a.write("Plan/page.md", "---\ntitle: Plan\n---\n\nText.\n")
    a.write("Plan/_assets/big.bin", "x" * 5000)
    await settle(a, b)
    (a.vault / "Plan").rename(a.vault / "Roadmap")
    await a.engine.scan()
    changes = a.engine.drain()

    async def never() -> Path | None:
        raise AssertionError("the bytes are already on this device")

    for entry in sorted(changes, key=lambda e: e.deleted):  # creations first, as scanned
        await b.engine.receive(entry, never)
    assert b.text("Roadmap/_assets/big.bin") == "x" * 5000
    assert not (b.vault / "Plan").exists()
    assert a.files() == b.files()


async def test_edits_to_different_parts_are_merged(pair: tuple[Device, Device]) -> None:
    a, b = pair
    path = await page(a, "Notes", "Intro.\n\nMiddle.\n\nEnd.\n")
    await settle(a, b)
    a.engine.mark_agreed()
    b.engine.mark_agreed()
    await a.ops.write_body("Notes", "Intro, from the laptop.\n\nMiddle.\n\nEnd.\n", None, "ui")
    await b.ops.write_body("Notes", "Intro.\n\nMiddle.\n\nEnd, from the desk.\n", None, "ui")
    await settle(a, b)
    assert a.text(path) == b.text(path)
    assert "from the laptop" in a.text(path) and "from the desk" in a.text(path)
    assert a.pending() == [] and b.pending() == []
    assert compare(a.engine.state.get(path).vector, b.engine.state.get(path).vector) == "equal"  # type: ignore[union-attr]


async def test_overlapping_edits_converge_and_one_becomes_a_proposal(
    pair: tuple[Device, Device],
) -> None:
    a, b = pair
    path = await page(a, "Price", "Twenty euro per seat.\n")
    await settle(a, b)
    a.engine.mark_agreed()
    b.engine.mark_agreed()
    await a.ops.write_body("Price", "Thirty euro per seat.\n", None, "ui")
    await b.ops.write_body("Price", "Twenty-five euro per seat.\n", None, "ui")
    await settle(a, b)
    # Both devices show the same version at once; nobody is left behind.
    assert a.text(path) == b.text(path)
    assert a.files() == b.files()
    proposals = a.pending() + b.pending()
    assert len(proposals) == 1
    proposal = proposals[0]
    loser, winner = (a, b) if a.pending() else (b, a)
    assert str(proposal["conversation_id"]) == f"sync:{NAMES[winner.name]}"
    kept_text = "Thirty" if winner is a else "Twenty-five"
    lost_text = "Twenty-five" if winner is a else "Thirty"
    assert kept_text in a.text(path) and lost_text in str(proposal["new_text"])
    # What was replaced is also a version of the page on the device that wrote it.
    versions = list((loser.vault / ".graite" / "versions").rglob("*.md"))
    assert any(lost_text in v.read_text(encoding="utf-8") for v in versions)
    # Accepting puts the other wording back, and that travels like any edit.
    await loser.queue.accept(str(proposal["id"]))
    await settle(a, b)
    assert lost_text in a.text(path) and a.text(path) == b.text(path)
    assert a.pending() == [] and b.pending() == []


async def test_three_devices_agree_on_side_by_side_edits(tmp_path: Path) -> None:
    a, b, c = (device(tmp_path, r) for r in ("replica-a", "replica-b", "replica-c"))
    path = await page(a, "Price", "Twenty.\n")
    await settle(a, b, c)
    await a.ops.write_body("Price", "Thirty.\n", None, "ui")
    await b.ops.write_body("Price", "Forty.\n", None, "ui")
    await a.engine.scan()
    await b.engine.scan()
    from_a, from_b = a.engine.drain(), b.engine.drain()
    # The phone hears of both in one order, the laptop and desk of each other's.
    await send(a, c, from_a)
    await send(b, c, from_b)
    await send(b, a, from_b)
    await send(a, b, from_a)
    assert a.text(path) == b.text(path) == c.text(path)
    assert c.pending() == []  # the phone wrote neither: nothing of its own to put back
    assert len(a.pending() + b.pending()) == 1
    await settle(a, b, c)
    assert a.files() == b.files() == c.files()


async def test_an_edit_against_a_deletion(pair: tuple[Device, Device]) -> None:
    a, b = pair
    path = await page(a, "Draft", "Text.\n")
    await settle(a, b)
    await a.ops.write_body("Draft", "Text, improved.\n", None, "ui")
    await a.engine.scan()
    edit = a.engine.drain()
    await b.ops.trash_page("Draft", "ui")  # later than the edit: the deletion is kept
    await b.engine.scan()
    deletion = b.engine.drain()
    assert await send(a, b, edit) == ["kept"]
    assert await send(b, a, deletion) == ["replaced"]
    assert not (a.vault / path).exists() and a.files() == b.files() == {}
    # The edit that lost to the deletion is still on the device that made it.
    kept = list((a.vault / ".graite" / "sync" / "deleted").rglob("page.md"))
    assert any("improved" in k.read_text(encoding="utf-8") for k in kept)


async def test_a_change_made_while_applying_is_not_overwritten(
    pair: tuple[Device, Device],
) -> None:
    a, b = pair
    path = await page(a, "Notes", "One.\n")
    await settle(a, b)
    await a.ops.write_body("Notes", "Two.\n", None, "ui")
    await a.engine.scan()
    (entry,) = a.engine.drain()
    source = b.engine.temp()
    source.write_text("anything", encoding="utf-8")
    with pytest.raises(StaleFile):
        await b.ops.sync_write(path, source, "0" * 64, "device:Laptop")
    assert "One." in b.text(path)


def test_paths_from_another_device_are_checked() -> None:
    for bad in (
        "../outside.md",
        "/etc/passwd",
        "Plan/../../x",
        ".graite/index.sqlite",
        ".graite/config.toml",
        ".git/config",
        "Plan\\page.md",
        "C:/x",
        "",
        "Plan//page.md",
        "NAVIGATION.md",
    ):
        with pytest.raises(ValueError):
            syncable(bad)
    assert syncable("Plan/_data/costs.csv") == "Plan/_data/costs.csv"
    assert syncable(".graite/skills/review/SKILL.md")
    with pytest.raises(ValueError):
        entry_from_wire({"path": "Plan/page.md", "hash": "short", "vector": {}})
    with pytest.raises(ValueError):
        entry_from_wire({"path": "Plan/page.md", "hash": "a" * 64, "vector": {"r": -1}})


async def test_the_writer_refuses_to_leave_the_vault(pair: tuple[Device, Device]) -> None:
    a, _ = pair
    source = a.engine.temp()
    source.write_text("x", encoding="utf-8")
    with pytest.raises(ValueError):
        await a.ops.sync_write("../escape.md", source, "", "device:Desk")
    assert not (a.vault.parent / "escape.md").exists()


def test_page_merge_ignores_the_updated_stamp_and_keeps_both_changes() -> None:
    base = "---\nid: p1\ntitle: Plan\nupdated: '2026-01-01T00:00:00Z'\n---\n\nA.\n\nB.\n"
    kept = "---\nid: p1\ntitle: Plan\nupdated: '2026-01-03T00:00:00Z'\n---\n\nA2.\n\nB.\n"
    other = (
        "---\nid: p1\ntitle: Plan\nicon: 📌\nupdated: '2026-01-02T00:00:00Z'\n---\n\nA.\n\nB2.\n"
    )
    result = merge.three_way("Plan/page.md", base, kept, other)
    assert result is not None
    assert "A2." in result and "B2." in result and "icon: 📌" in result
    assert "2026-01-03" in result and "2026-01-02" not in result
    overlap = other.replace("A.\n", "A3.\n")
    assert merge.three_way("Plan/page.md", base, kept, overlap) is None
    assert merge.three_way("Plan/page.md", None, kept, other) is None
    # Rows merge by line; changes to neighbouring lines count as an overlap.
    rows = merge.three_way(
        "Plan/_data/t.csv",
        "id,n\n1,a\n2,b\n3,c\n",
        "id,n\n1,x\n2,b\n3,c\n",
        "id,n\n1,a\n2,b\n3,y\n",
    )
    assert rows == "id,n\n1,x\n2,b\n3,y\n"
