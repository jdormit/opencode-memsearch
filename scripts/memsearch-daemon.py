#!/usr/bin/env python3
"""
memsearch-daemon — long-running process that keeps the embedding model loaded.

Serves search/index/expand requests over a Unix domain socket, avoiding the
~8-11s Python+PyTorch cold-start penalty on every CLI invocation.

Protocol:
  Client sends a JSON object (terminated by EOF/shutdown), daemon replies
  with a JSON object.

Commands:
  {"cmd": "search", "query": "...", "top_k": 5, "source_prefix": null}
  {"cmd": "index", "paths": ["..."], "force": false}
  {"cmd": "expand", "chunk_hash": "..."}
  {"cmd": "ping"}
  {"cmd": "shutdown"}

Started by the opencode-memsearch plugin on session creation.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import signal
import sys
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [memsearch-daemon] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("memsearch-daemon")


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


async def handle_search(ms, params: dict) -> dict:
    query = params.get("query", "")
    top_k = params.get("top_k", 5)
    source_prefix = params.get("source_prefix")
    results = await ms.search(query, top_k=top_k, source_prefix=source_prefix)
    return {"ok": True, "results": results}


async def handle_index(ms, params: dict) -> dict:
    paths = params.get("paths", [])
    force = params.get("force", False)
    if paths:
        ms._paths = [str(p) for p in paths]
    count = await ms.index(force=force)
    return {"ok": True, "indexed": count}


async def handle_expand(ms, params: dict) -> dict:
    """Expand a chunk — mirrors the CLI expand command's --json-output."""
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
        # Fall back to just returning the stored content
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


async def handle_client(reader, writer, ms, shutdown_event):
    try:
        data = await reader.read(1_048_576)  # 1MB max request
        if not data:
            return

        request = json.loads(data.decode("utf-8"))
        cmd = request.get("cmd")

        if cmd == "search":
            response = await handle_search(ms, request)
        elif cmd == "index":
            response = await handle_index(ms, request)
        elif cmd == "expand":
            response = await handle_expand(ms, request)
        elif cmd == "ping":
            response = {"ok": True, "msg": "pong"}
        elif cmd == "shutdown":
            response = {"ok": True, "msg": "shutting down"}
            shutdown_event.set()
        else:
            response = {"ok": False, "error": f"Unknown command: {cmd}"}

        writer.write(json.dumps(response, default=str).encode("utf-8"))
        await writer.drain()
    except Exception as e:
        try:
            writer.write(json.dumps({"ok": False, "error": str(e)}).encode("utf-8"))
            await writer.drain()
        except Exception:
            pass
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
    parser.add_argument("--collection", default=None, help="Milvus collection name")
    parser.add_argument("--paths", nargs="*", default=[], help="Paths to index")
    parser.add_argument("--pid-file", default=None, help="Write PID to this file")
    args = parser.parse_args()

    socket_path = args.socket

    # Import memsearch (this is the slow part — loads PyTorch + model)
    from memsearch.config import resolve_config
    from memsearch.core import MemSearch

    cfg = resolve_config()

    kwargs: dict = {
        "embedding_provider": cfg.embedding.provider,
        "embedding_model": cfg.embedding.model or None,
        "embedding_batch_size": cfg.embedding.batch_size,
        "embedding_base_url": cfg.embedding.base_url or None,
        "embedding_api_key": cfg.embedding.api_key or None,
        "milvus_uri": cfg.milvus.uri,
        "milvus_token": cfg.milvus.token or None,
        "collection": args.collection or cfg.milvus.collection,
        "max_chunk_size": cfg.chunking.max_chunk_size,
        "overlap_lines": cfg.chunking.overlap_lines,
        "reranker_model": cfg.reranker.model,
    }

    logger.info("Loading embedding model...")
    ms = MemSearch(args.paths or None, **kwargs)
    logger.info("Model loaded.")

    # Clean up stale socket
    if os.path.exists(socket_path):
        os.unlink(socket_path)

    # Ensure parent directory exists
    Path(socket_path).parent.mkdir(parents=True, exist_ok=True)

    shutdown_event = asyncio.Event()

    server = await asyncio.start_unix_server(
        lambda r, w: handle_client(r, w, ms, shutdown_event),
        path=socket_path,
    )

    # Write PID file
    if args.pid_file:
        Path(args.pid_file).parent.mkdir(parents=True, exist_ok=True)
        Path(args.pid_file).write_text(str(os.getpid()))

    logger.info("Listening on %s (PID %d)", socket_path, os.getpid())

    # Handle SIGTERM gracefully
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, shutdown_event.set)

    # Wait for shutdown signal
    await shutdown_event.wait()
    logger.info("Shutting down...")

    server.close()
    await server.wait_closed()
    ms.close()

    # Cleanup
    if os.path.exists(socket_path):
        os.unlink(socket_path)
    if args.pid_file and os.path.exists(args.pid_file):
        os.unlink(args.pid_file)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
