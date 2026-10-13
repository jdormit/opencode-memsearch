#!/usr/bin/env python3
"""
memsearch-daemon — one long-running process shared by every OpenCode project.

It is the only process that opens the Milvus database, and it keeps the
embedding model loaded so requests don't pay Python's cold-start cost.

Protocol: the client sends one JSON object terminated by a newline (or EOF);
the daemon replies with one JSON object and closes the connection.

Commands:
  {"cmd": "search", "collection": "...", "query": "...", "top_k": 5}
  {"cmd": "index", "collection": "...", "paths": ["..."], "force": false}
  {"cmd": "expand", "collection": "...", "chunk_hash": "..."}
  {"cmd": "reset", "collection": "..."}
  {"cmd": "ping"}
  {"cmd": "shutdown"}

Started by the opencode-memsearch plugin when no daemon is answering.
"""

from __future__ import annotations

import asyncio
import fcntl
import json
import logging
import os
import re
import signal
import sys
import time
from pathlib import Path
from typing import IO

# Must match DAEMON_PROTOCOL in src/daemon-client.ts.
PROTOCOL = 2
MAX_REQUEST_BYTES = 1_048_576
LOCK_WAIT_SECONDS = 10
# Must match EXIT_LOCKED in src/daemon-client.ts.
EXIT_LOCKED = 3

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [memsearch-daemon] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("memsearch-daemon")


def acquire_singleton_lock(pid_file: str) -> IO[str] | None:
    """Hold an exclusive lock on the PID file for the daemon's lifetime.

    Waits briefly so a replacement can start while an old daemon shuts down.
    """
    Path(pid_file).parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    f = open(pid_file, "a+")
    deadline = time.monotonic() + LOCK_WAIT_SECONDS
    while True:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.monotonic() > deadline:
                f.close()
                return None
            time.sleep(0.2)
    f.seek(0)
    f.truncate()
    f.write(str(os.getpid()))
    f.flush()
    return f


def share_embedding_provider() -> None:
    """MemSearch builds its own embedder per instance. Reuse one per config so
    each collection doesn't load another copy of the model."""
    import memsearch.core as core

    providers: dict = {}
    load = core.get_provider

    def get_provider(name, **kwargs):
        key = (name, tuple(sorted(kwargs.items())))
        if key not in providers:
            providers[key] = load(name, **kwargs)
        return providers[key]

    core.get_provider = get_provider


class Collections:
    """One MemSearch instance per collection, created on first use.

    Instances must stay open until shutdown: closing any one of them stops the
    Milvus Lite server that all of them share.
    """

    def __init__(self, kwargs: dict, store_factory):
        self._kwargs = kwargs
        self._store_factory = store_factory
        self._instances: dict = {}
        self._index_locks: dict[str, asyncio.Lock] = {}

    def get(self, name: str | None):
        if not name:
            raise ValueError("collection is required")
        if name not in self._instances:
            from memsearch.core import MemSearch

            try:
                self._instances[name] = MemSearch(None, collection=name, **self._kwargs)
            except ValueError as e:
                if "dimension mismatch" not in str(e).lower():
                    raise
                raise ValueError(
                    f"Collection {name} was built with a different embedding model. "
                    "Rebuild it with: bunx opencode-memsearch reindex"
                ) from e
        return self._instances[name]

    def drop(self, name: str | None) -> None:
        if not name:
            raise ValueError("collection is required")
        ms = self._instances.pop(name, None)
        # A read-only store, because opening a MemSearch fails on the dimension
        # mismatch that resetting is meant to fix.
        store = ms.store if ms else self._store_factory(name)
        store.drop()

    def index_lock(self, name: str) -> asyncio.Lock:
        return self._index_locks.setdefault(name, asyncio.Lock())

    def close(self) -> None:
        for ms in self._instances.values():
            try:
                ms.close()
            except Exception:
                logger.exception("Failed to close collection")


def _extract_section(
    all_lines: list[str],
    start_line: int,
    heading_level: int,
) -> tuple[str, int, int]:
    """Extract the full section containing the chunk (mirrors CLI logic)."""
    section_start = start_line - 1
    if heading_level > 0:
        for i in range(start_line - 2, -1, -1):
            line = all_lines[i]
            if line.startswith("#"):
                level = len(line) - len(line.lstrip("#"))
                if level <= heading_level:
                    section_start = i
                    break

    section_end = len(all_lines)
    if heading_level > 0:
        for i in range(start_line, len(all_lines)):
            line = all_lines[i]
            if line.startswith("#"):
                level = len(line) - len(line.lstrip("#"))
                if level <= heading_level:
                    section_end = i
                    break

    content = "\n".join(all_lines[section_start:section_end])
    return content, section_start + 1, section_end


async def handle_search(collections: Collections, params: dict) -> dict:
    ms = collections.get(params.get("collection"))
    # Milvus rejects BM25 searches on an empty collection.
    if ms.store.count() == 0:
        return {"ok": True, "results": []}
    results = await ms.search(
        params.get("query", ""),
        top_k=params.get("top_k", 5),
        source_prefix=params.get("source_prefix"),
    )
    return {"ok": True, "results": results}


async def handle_index(collections: Collections, params: dict) -> dict:
    name = params.get("collection")
    async with collections.index_lock(name):
        ms = collections.get(name)
        paths = params.get("paths", [])
        if paths:
            ms._paths = [str(p) for p in paths]
        count = await ms.index(force=params.get("force", False))
    return {"ok": True, "indexed": count}


async def handle_expand(collections: Collections, params: dict) -> dict:
    """Expand a chunk — mirrors the CLI expand command's --json-output."""
    ms = collections.get(params.get("collection"))
    chunk_hash = params.get("chunk_hash", "")
    if not chunk_hash:
        return {"ok": False, "error": "chunk_hash is required"}

    escaped = chunk_hash.replace("\\", "\\\\").replace('"', '\\"')
    chunks = ms.store.query(filter_expr=f'chunk_hash == "{escaped}"')
    if not chunks:
        return {"ok": False, "error": f"Chunk not found: {chunk_hash}"}

    chunk = chunks[0]
    source = chunk["source"]
    start_line = chunk["start_line"]
    heading_level = chunk.get("heading_level", 0)
    heading = chunk.get("heading", "")

    source_path = Path(source)
    if not source_path.exists():
        return {
            "ok": True,
            "result": {
                "chunk_hash": chunk_hash,
                "source": source,
                "heading": heading,
                "start_line": start_line,
                "end_line": chunk["end_line"],
                "content": chunk.get("content", ""),
            },
        }

    all_lines = source_path.read_text(encoding="utf-8").splitlines()
    expanded, expanded_start, expanded_end = _extract_section(
        all_lines, start_line, heading_level
    )

    anchor_match = re.search(
        r"<!--\s*session:(\S+)\s+turn:(\S+)\s+transcript:(\S+)\s*-->",
        expanded,
    )
    result: dict = {
        "chunk_hash": chunk_hash,
        "source": source,
        "heading": heading,
        "start_line": expanded_start,
        "end_line": expanded_end,
        "content": expanded,
    }
    if anchor_match:
        result["anchor"] = {
            "session": anchor_match.group(1),
            "turn": anchor_match.group(2),
            "transcript": anchor_match.group(3),
        }

    return {"ok": True, "result": result}


async def handle_reset(collections: Collections, params: dict) -> dict:
    name = params.get("collection")
    async with collections.index_lock(name):
        collections.drop(name)
    return {"ok": True}


HANDLERS = {
    "search": handle_search,
    "index": handle_index,
    "expand": handle_expand,
    "reset": handle_reset,
}


async def respond(request: dict, collections, shutdown_event, version: str) -> dict:
    cmd = request.get("cmd")
    if cmd in HANDLERS:
        return await HANDLERS[cmd](collections, request)
    if cmd == "ping":
        return {"ok": True, "protocol": PROTOCOL, "version": version, "pid": os.getpid()}
    if cmd == "shutdown":
        shutdown_event.set()
        return {"ok": True}
    return {"ok": False, "error": f"Unknown command: {cmd}"}


async def handle_client(reader, writer, collections, shutdown_event, version):
    try:
        try:
            data = await reader.readline()
            if not data:
                return
            request = json.loads(data.decode("utf-8"))
            response = await respond(request, collections, shutdown_event, version)
        except Exception as e:
            logger.exception("Request failed")
            response = {"ok": False, "error": str(e)}

        writer.write(json.dumps(response, default=str).encode("utf-8"))
        await writer.drain()
    except Exception:
        logger.exception("Failed to send response")
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass


async def main():
    import argparse

    parser = argparse.ArgumentParser(description="memsearch daemon")
    parser.add_argument("--socket", required=True, help="Unix socket path")
    parser.add_argument("--pid-file", required=True, help="PID file, also used as the singleton lock")
    parser.add_argument("--version", default="0", help="Plugin version, reported by ping")
    args = parser.parse_args()

    lock = acquire_singleton_lock(args.pid_file)
    if lock is None:
        logger.info("Another daemon holds %s; exiting", args.pid_file)
        sys.exit(EXIT_LOCKED)

    from memsearch.config import resolve_config
    from memsearch.store import MilvusStore

    share_embedding_provider()
    import memsearch.core as core

    cfg = resolve_config()
    embedding = {
        "model": cfg.embedding.model or None,
        "batch_size": cfg.embedding.batch_size,
        "base_url": cfg.embedding.base_url or None,
        "api_key": cfg.embedding.api_key or None,
    }

    def read_only_store(collection: str):
        return MilvusStore(
            uri=cfg.milvus.uri,
            token=cfg.milvus.token or None,
            collection=collection,
            dimension=None,
        )

    # Open the database before the slow model load, so a locked or broken
    # database fails startup quickly instead of failing every later request.
    probe = read_only_store("memsearch_daemon_probe")

    logger.info("Loading embedding model...")
    core.get_provider(cfg.embedding.provider, **embedding)
    logger.info("Ready.")

    collections = Collections(
        {
            "embedding_provider": cfg.embedding.provider,
            "embedding_model": embedding["model"],
            "embedding_batch_size": embedding["batch_size"],
            "embedding_base_url": embedding["base_url"],
            "embedding_api_key": embedding["api_key"],
            "milvus_uri": cfg.milvus.uri,
            "milvus_token": cfg.milvus.token or None,
            "max_chunk_size": cfg.chunking.max_chunk_size,
            "overlap_lines": cfg.chunking.overlap_lines,
            "reranker_model": cfg.reranker.model,
        },
        read_only_store,
    )

    socket_path = args.socket
    Path(socket_path).parent.mkdir(parents=True, exist_ok=True)
    if os.path.exists(socket_path):
        os.unlink(socket_path)

    shutdown_event = asyncio.Event()
    server = await asyncio.start_unix_server(
        lambda r, w: handle_client(r, w, collections, shutdown_event, args.version),
        path=socket_path,
        limit=MAX_REQUEST_BYTES,
    )
    logger.info("Listening on %s (PID %d)", socket_path, os.getpid())

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, shutdown_event.set)

    await shutdown_event.wait()
    logger.info("Shutting down...")

    server.close()
    await server.wait_closed()
    collections.close()
    probe.close()
    # Safe while we still hold the lock: no other daemon can own this socket yet.
    Path(socket_path).unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    except Exception:
        logger.exception("Daemon failed")
        sys.exit(1)
