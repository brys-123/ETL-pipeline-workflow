from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db, get_workspace_access
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember
from app.schemas.workspace import WorkspaceCreate, WorkspaceResponse

router = APIRouter()


@router.get("", response_model=list[WorkspaceResponse])
def list_workspaces(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[Workspace]:
    workspace_ids = [m.workspace_id for m in db.query(WorkspaceMember).filter(WorkspaceMember.user_id == user.id).all()]
    return db.query(Workspace).filter(Workspace.id.in_(workspace_ids) | (Workspace.created_by == user.id)).all()


@router.post("", response_model=WorkspaceResponse)
def create_workspace(payload: WorkspaceCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Workspace:
    workspace = Workspace(name=payload.name, description=payload.description, created_by=user.id)
    db.add(workspace)
    db.flush()
    db.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role="workspace_owner"))
    db.commit()
    db.refresh(workspace)
    return workspace


@router.get("/{workspace_id}", response_model=WorkspaceResponse)
def get_workspace(workspace: Workspace = Depends(get_workspace_access)) -> Workspace:
    return workspace
