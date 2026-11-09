from __future__ import annotations

import ipaddress
import re
import socket
from urllib.parse import parse_qsl, urlsplit


class ConnectionSecurityError(ValueError):
    pass


def validate_host(host: object, allow_private: bool = False) -> str:
    if not isinstance(host, str) or not host.strip() or len(host) > 253:
        raise ConnectionSecurityError("Enter a valid server host.")
    normalized = host.strip().rstrip(".")
    if any(character.isspace() for character in normalized) or any(character in normalized for character in "/\\@%"):
        raise ConnectionSecurityError("Enter a valid server host.")
    try:
        addresses = {ipaddress.ip_address(normalized)}
    except ValueError:
        try:
            addresses = {
                ipaddress.ip_address(item[4][0].split("%", 1)[0])
                for item in socket.getaddrinfo(normalized, None, type=socket.SOCK_STREAM)
            }
        except (OSError, ValueError) as exc:
            raise ConnectionSecurityError("The configured server host could not be resolved.") from exc
    if not addresses:
        raise ConnectionSecurityError("The configured server host could not be resolved.")
    if not allow_private and any(not address.is_global for address in addresses):
        raise ConnectionSecurityError("Private or local network hosts require an explicitly trusted connection.")
    return normalized


def validate_api_url(value: object, allow_private: bool = False, allow_query: bool = False) -> str:
    if not isinstance(value, str) or len(value) > 2048:
        raise ConnectionSecurityError("Enter a valid API URL.")
    try:
        parsed = urlsplit(value.strip())
        port = parsed.port
    except ValueError as exc:
        raise ConnectionSecurityError("Enter a valid API URL.") from exc
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or (parsed.query and not allow_query)
    ):
        raise ConnectionSecurityError("API URLs must use HTTP or HTTPS without embedded credentials or fragments.")
    if allow_query and any(re.search(r"password|token|secret|api.?key|authorization", key, re.IGNORECASE) for key, _value in parse_qsl(parsed.query)):
        raise ConnectionSecurityError("API URLs cannot contain credential query parameters.")
    validate_host(parsed.hostname, allow_private=allow_private)
    if port is not None and not 1 <= port <= 65535:
        raise ConnectionSecurityError("API URL port must be between 1 and 65535.")
    return value.strip()


_SQL_COMMENT = re.compile(r"--|/\*|\*/|#")
_SQL_FORBIDDEN = re.compile(
    r"\b(insert|update|delete|drop|alter|truncate|create|replace|grant|revoke|call|execute|copy|vacuum|attach|detach)\b",
    re.IGNORECASE,
)
_SQL_SIDE_EFFECT = re.compile(
    r"\b(into|for\s+update|lock\s+in\s+share\s+mode|sleep|benchmark|load_file|pg_sleep|pg_read_file|pg_notify|pg_advisory_lock|nextval|setval|lo_import|dblink_exec)\b",
    re.IGNORECASE,
)


def validate_select_query(query: object) -> str:
    if not isinstance(query, str) or not query.strip() or len(query) > 100_000:
        raise ConnectionSecurityError("Enter a SELECT query or choose a table.")
    if _SQL_COMMENT.search(query):
        raise ConnectionSecurityError("SQL comments are not allowed in custom queries.")
    candidate = query.strip()
    if candidate.endswith(";"):
        candidate = candidate[:-1].rstrip()
    if not candidate or ";" in candidate or not re.match(r"^select\b", candidate, re.IGNORECASE):
        raise ConnectionSecurityError("Only a single SELECT query is allowed.")
    if _SQL_FORBIDDEN.search(candidate) or _SQL_SIDE_EFFECT.search(candidate):
        raise ConnectionSecurityError("The query contains a disallowed operation.")
    return candidate