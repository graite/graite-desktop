import re

from graite.models.downloader import catalog


def test_starter_models_are_pinned_plain_language_q4_chat_models() -> None:
    starters = [m for m in catalog() if m.tier == "starter"]
    assert [m.level for m in starters] == ["Light", "Everyday", "Powerful", "Maximum"]
    for model in starters:
        assert model.role == "chat" and not model.hidden
        assert re.search(r"Q4_K_M\.gguf$", model.filename)
        assert re.fullmatch(r"[a-f0-9]{40}", model.revision)
        assert re.fullmatch(r"[a-f0-9]{64}", model.sha256)
        assert model.summary and model.needs and model.min_ram_gb > 0
    # Sorted from light to heavy, so the picker can recommend the largest one that fits.
    assert [m.min_ram_gb for m in starters] == sorted(m.min_ram_gb for m in starters)
