"""Triagem local inicial de lore; nao substitui interpretacao humana."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass


STOPWORDS = frozenset("""a ao aos as o os um uma uns umas de da do das dos e em na no nas nos
por para com sem que se eu ele ela meu minha seu sua seus suas era foi ser ter tinha
ha havia muito mais menos depois antes quando onde porque como sobre tambem ate
esse essa isso este esta isto eles elas num numa pelo pela pelos pelas entre
durante ainda ja nao sim ou mas so sua seu nossa nosso minha meu""".split())


def normalize_tokens(text: str) -> set[str]:
    normalized = unicodedata.normalize("NFKD", text.casefold())
    normalized = "".join(char for char in normalized if not unicodedata.combining(char))
    return {token for token in re.findall(r"[a-z0-9]{4,}", normalized) if token not in STOPWORDS}


@dataclass(frozen=True)
class LoreResult:
    approved: bool
    score: float
    common_terms: tuple[str, ...]
    reason: str


def evaluate_lore(reference: str, submission: str, minimum_score: float = 0.28) -> LoreResult:
    if len(submission.strip()) < 120:
        return LoreResult(False, 0.0, (), "A história precisa ter pelo menos 120 caracteres.")
    reference_tokens = normalize_tokens(reference)
    submission_tokens = normalize_tokens(submission)
    if len(reference_tokens) < 8:
        return LoreResult(False, 0.0, (), "A lore base ainda precisa de mais detalhes para a triagem automática.")
    if len(submission_tokens) < 12:
        return LoreResult(False, 0.0, (), "Descreva melhor a história do personagem.")
    common = reference_tokens & submission_tokens
    # Cobertura de termos da lore base e uma medida verificavel, mas lexical.
    score = len(common) / len(reference_tokens)
    approved = len(common) >= 3 and score >= minimum_score
    reason = "A lore passou na triagem de consistência." if approved else "A história não traz referências suficientes à lore base."
    return LoreResult(approved, round(score, 3), tuple(sorted(common)), reason)
