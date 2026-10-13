import os


def record(event: str) -> None:
    with open(os.environ["FAKE_MEMSEARCH_EVENTS"], "a") as f:
        f.write(event + "\n")
