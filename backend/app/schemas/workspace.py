from pydantic import BaseModel


class WorkspaceCreate(BaseModel):
    name: str
    description: str | None = None


class WorkspaceResponse(BaseModel):
    id: int
    name: str
    description: str | None = None
    created_by: int

    model_config = {"from_attributes": True}
