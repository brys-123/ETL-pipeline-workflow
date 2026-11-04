from typing import Any

from pydantic import BaseModel, Field


class WorkflowCreate(BaseModel):
    name: str
    description: str | None = None
    graph: dict[str, Any] = Field(default_factory=lambda: {"nodes": [], "edges": []})
    status: str = "draft"


class WorkflowResponse(BaseModel):
    id: int
    workspace_id: int
    name: str
    description: str | None = None
    status: str
    graph: dict[str, Any] = Field(default_factory=lambda: {"nodes": [], "edges": []})
    created_by: int

    model_config = {"from_attributes": True}
