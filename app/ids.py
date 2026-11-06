"""Идентификаторы нового формата — компактные 16-hex (64 бита)."""
import re

ID_RE = re.compile(r"^[0-9a-f]{16}$")


def is_id(value) -> bool:
    return bool(value) and isinstance(value, str) and bool(ID_RE.match(value))
