import socket

import pytest

from simple_etl.services.connection_security import (
    ConnectionSecurityError,
    validate_api_url,
    validate_host,
    validate_select_query,
)


def _resolved_address(address):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 0))]


def test_host_resolution_rejects_private_addresses_unless_trusted(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: _resolved_address("10.0.0.12"))

    with pytest.raises(ConnectionSecurityError, match="explicitly trusted"):
        validate_host("warehouse.internal")

    assert validate_host("warehouse.internal", allow_private=True) == "warehouse.internal"


def test_api_url_rejects_credentials_and_local_destinations(monkeypatch):
    with pytest.raises(ConnectionSecurityError, match="embedded credentials"):
        validate_api_url("https://user:secret@example.com/data")

    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: _resolved_address("127.0.0.1"))
    with pytest.raises(ConnectionSecurityError, match="explicitly trusted"):
        validate_api_url("http://localhost/data")


@pytest.mark.parametrize("query", [
    "DELETE FROM customers",
    "SELECT * FROM customers; DROP TABLE customers",
    "SELECT * FROM customers FOR UPDATE",
    "SELECT * FROM customers INTO OUTFILE '/tmp/export.csv'",
])
def test_select_query_rejects_mutation_and_side_effects(query):
    with pytest.raises(ConnectionSecurityError):
        validate_select_query(query)


def test_select_query_accepts_read_only_select():
    assert validate_select_query("SELECT id, name FROM customers;") == "SELECT id, name FROM customers"