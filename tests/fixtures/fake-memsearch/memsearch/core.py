from .events import record
from .store import MilvusStore


def get_provider(name, **kwargs):
    record(f"load_provider:{name}")
    return object()


class MemSearch:
    def __init__(
        self,
        paths=None,
        *,
        embedding_provider,
        embedding_model=None,
        embedding_batch_size=0,
        embedding_base_url=None,
        embedding_api_key=None,
        milvus_uri,
        milvus_token=None,
        collection,
        **_,
    ):
        self._paths = [str(p) for p in (paths or [])]
        self._embedder = get_provider(
            embedding_provider,
            model=embedding_model,
            batch_size=embedding_batch_size,
            base_url=embedding_base_url,
            api_key=embedding_api_key,
        )
        self._store = MilvusStore(milvus_uri, token=milvus_token, collection=collection)

    @property
    def store(self):
        return self._store

    async def search(self, query, *, top_k=10, source_prefix=None):
        return [{"collection": self._store.collection, "query": query, "top_k": top_k}]

    async def index(self, *, force=False):
        record(f"index:{self._store.collection}:{','.join(self._paths)}")
        return len(self._paths)

    def close(self):
        self._store.close()
