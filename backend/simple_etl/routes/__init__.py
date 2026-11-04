from flask import Flask

from .dashboard import dashboard_blueprint
from .files import files_blueprint
from .health import health_blueprint
from .workflows import workflows_blueprint


def register_routes(app: Flask) -> None:
    app.register_blueprint(health_blueprint, url_prefix="/api")
    app.register_blueprint(dashboard_blueprint, url_prefix="/api")
    app.register_blueprint(files_blueprint, url_prefix="/api")
    app.register_blueprint(workflows_blueprint, url_prefix="/api")