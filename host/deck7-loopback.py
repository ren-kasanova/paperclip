"""Run DECK·7 on macOS loopback only."""

from http.server import ThreadingHTTPServer
from pathlib import Path

from deck7d.server import (
    CredentialConfigError,
    build_runtime,
    expected_agent_tokens,
    expected_token,
    make_handler,
)


def main() -> None:
    if expected_token() is None:
        raise CredentialConfigError("device credential unavailable")
    if not expected_agent_tokens():
        raise CredentialConfigError("source-bound agent credentials are unavailable")

    root = Path(__file__).resolve().parent
    runtime = build_runtime(
        root=root,
        config_path=Path.home() / ".deck7/surface.json",
        prompt_path=root / "prompts.json",
    )
    print(f"[deck7d] 127.0.0.1:8765 surface={runtime.schema}", flush=True)
    ThreadingHTTPServer(
        ("127.0.0.1", 8765),
        make_handler(runtime.service),
    ).serve_forever()


if __name__ == "__main__":
    main()
