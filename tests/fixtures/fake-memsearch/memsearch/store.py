import os

from .events import record


class MilvusStore:
    def __init__(self, uri, *, token=None, collection, dimension=None, description=""):
        if os.environ.get("FAKE_MILVUS_FAIL"):
            raise RuntimeError("Open local milvus failed")
        record(f"open_store:{collection}")
        self.collection = collection

    def query(self, filter_expr=""):
        source = os.environ.get("FAKE_MEMSEARCH_CHUNK_SOURCE")
        if source and '"fixture-chunk"' in filter_expr:
            return [{"source": source, "start_line": 1, "end_line": 4, "heading_level": 1, "heading": "Fixture memory"}]
        return []

    def count(self):
        return 0 if self.collection.startswith("empty") else 1

    def drop(self):
        record(f"drop:{self.collection}")

    def close(self):
        pass
