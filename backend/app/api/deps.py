from collections.abc import Generator

from fastapi import Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.security import get_current_user_token
from app.db.session import SessionLocal
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_current_user(db: Session = Depends(get_db), subject: str = Depends(get_current_user_token)) -> User:
    user = db.query(User).filter(User.email == subject).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user


def get_workspace_access(workspace_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Workspace:
    workspace = db.query(Workspace).filter(Workspace.id == workspace_id).first()
    if not workspace:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found")
    membership = db.query(WorkspaceMember).filter(
        WorkspaceMember.workspace_id == workspace.id,
        WorkspaceMember.user_id == user.id,
    ).first()
    if not membership and workspace.created_by != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    return workspace
