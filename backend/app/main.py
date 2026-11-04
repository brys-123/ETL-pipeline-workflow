from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import auth, dashboard, workflows, workspaces
from app.core.config import settings
from app.db.base import Base
from app.db.session import engine

Base.metadata.create_all(bind=engine)

app = FastAPI(title=settings.app_name, version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in settings.cors_origins.split(",") if origin.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api/auth")
app.include_router(workspaces.router, prefix="/api/workspaces")
app.include_router(workflows.router, prefix="/api/workflows")
app.include_router(dashboard.router, prefix="/api")


@app.get("/api/health")
def health_check() -> dict[str, str]:
    return {"status": "ok", "service": settings.app_name}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
