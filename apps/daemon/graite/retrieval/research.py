"""Decide when the fixed pipeline's evidence is too thin and a bounded research loop should run."""

from __future__ import annotations

from graite.retrieval.search import Candidate
from graite.retrieval.strategy import Plan

WEAK_SCORE = 1.0 / 60 + 1.0 / 90  # roughly: top hit is rank 1 in one signal and ~30 in another


def weak(candidates: list[Candidate], plan: Plan, *, semantic_available: bool = True) -> bool:
    if not candidates:
        return True
    top = candidates[0]
    pages = {c.page_path for c in candidates[:6]}
    if (
        semantic_available
        and top.score < WEAK_SCORE
        and (top.fts_rank is None or top.vec_rank is None)
    ):
        return True  # only one signal found it, and not convincingly
    return plan.research and len(pages) < 2


def rounds(candidates: list[Candidate], plan: Plan, *, semantic_available: bool = True) -> int:
    """How many model rounds the loop may take: 2 for a direct answer, more for research."""
    if weak(candidates, plan, semantic_available=semantic_available) or plan.research:
        return max(plan.max_rounds, 4)
    return plan.max_rounds
