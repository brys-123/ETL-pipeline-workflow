class PostgreSQLStorageError(RuntimeError):
    pass


class StorageUnavailableError(PostgreSQLStorageError):
    pass
