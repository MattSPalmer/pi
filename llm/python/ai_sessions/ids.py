import re

_VALID = re.compile(r"^[A-Za-z0-9:_-]+$")


def validate_id(value: str, label: str = "id") -> str:
    if not _VALID.fullmatch(value):
        raise ValueError(f"invalid {label}: {value}")
    return value
