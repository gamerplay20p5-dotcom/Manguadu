from __future__ import annotations

import pytest


def test_bot_shutdown_signal_is_not_reported_as_crash(monkeypatch: pytest.MonkeyPatch) -> None:
    from manguadu import __main__ as entrypoint

    monkeypatch.setattr("sys.argv", ["manguadu", "--bot"])
    monkeypatch.setenv("DISCORD_TOKEN", "test-token")

    def stop_requested(coroutine: object, *_args: object, **_kwargs: object) -> None:
        coroutine.close()  # type: ignore[attr-defined]
        raise KeyboardInterrupt

    monkeypatch.setattr(entrypoint.asyncio, "run", stop_requested)

    assert entrypoint.main() == 0
