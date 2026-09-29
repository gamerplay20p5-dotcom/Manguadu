"""Carregamento da configuracao local da instalacao."""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import dotenv_values


PROJECT_ENV_PATH = Path(__file__).resolve().parent.parent / ".env"


def load_project_environment(path: str | Path = PROJECT_ENV_PATH) -> Path:
    """Use valores preenchidos no .env, mesmo com variaveis antigas no PM2.

    Campos vazios no arquivo nao apagam valores fornecidos diretamente pelo
    ambiente do processo. A localizacao e fixa no projeto, independente do cwd.
    """
    env_path = Path(path)
    for name, value in dotenv_values(env_path, encoding="utf-8-sig").items():
        if value is not None and (value or name not in os.environ):
            os.environ[name] = value
    return env_path
