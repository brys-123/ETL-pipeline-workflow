from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db
from app.core.security import create_access_token, create_refresh_token, hash_password, verify_password
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember
from app.schemas.auth import LoginRequest, RegisterRequest, TokenResponse, UserResponse

router = APIRouter()


@router.post("/register", response_model=TokenResponse)
def register(payload: RegisterRequest, db: Session = Depends(get_db)) -> TokenResponse:
    email = payload.email.lower()
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="User already exists")

    user = User(
        email=email,
        full_name=payload.full_name,
        hashed_password=hash_password(payload.password),
        role="workspace_owner",
    )
    db.add(user)
    db.flush()

    workspace = Workspace(name=f"{payload.full_name}'s workspace", description="Primary workspace", created_by=user.id)
    db.add(workspace)
    db.flush()

    membership = WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role="workspace_owner")
    db.add(membership)
    db.commit()
    db.refresh(user)

    access_token = create_access_token(user.email)
    refresh_token = create_refresh_token(user.email)
    return TokenResponse(access_token=access_token, refresh_token=refresh_token)


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)) -> TokenResponse:
    user = db.query(User).filter(User.email == payload.email.lower()).first()
    if not user or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    access_token = create_access_token(user.email)
    refresh_token = create_refresh_token(user.email)
    return TokenResponse(access_token=access_token, refresh_token=refresh_token)


@router.get("/me", response_model=UserResponse)
def me(current_user: User = Depends(get_current_user)) -> User:
    return current_user


@router.post("/refresh", response_model=TokenResponse)
def refresh_token(token: str, db: Session = Depends(get_db)) -> TokenResponse:
    from app.core.security import decode_token

    email = decode_token(token)
    user = db.query(User).filter(User.email == email).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return TokenResponse(
        access_token=create_access_token(user.email),
        refresh_token=create_refresh_token(user.email),
    )
