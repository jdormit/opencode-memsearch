from types import SimpleNamespace


def resolve_config():
    return SimpleNamespace(
        embedding=SimpleNamespace(
            provider="fake", model="fake-model", batch_size=0, base_url="", api_key=""
        ),
        milvus=SimpleNamespace(uri="fake.db", token="", collection="default"),
        chunking=SimpleNamespace(max_chunk_size=1500, overlap_lines=2),
        reranker=SimpleNamespace(model=""),
    )
