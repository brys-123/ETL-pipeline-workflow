from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db, get_workspace_access
from app.models.user import User
from app.models.workflow import Workflow
from app.schemas.workflow import WorkflowCreate, WorkflowResponse

router = APIRouter()


def _transform_rows(rows: list[dict], node_type: str | None, config: dict | None = None) -> list[dict]:
    if not rows:
        return []
    if node_type and "duplicate" in node_type.lower():
        seen: set[str] = set()
        unique_rows: list[dict] = []
        for row in rows:
            key = str(row)
            if key not in seen:
                seen.add(key)
                unique_rows.append(row)
        return unique_rows
    if node_type and "filter" in node_type.lower():
        column = (config or {}).get("column")
        op = (config or {}).get("operator")
        value = (config or {}).get("value")
        if not column or not op:
            return rows
        if op == "equals":
            return [row for row in rows if row.get(column) == value]
        if op == "gt":
            return [row for row in rows if row.get(column, 0) > value]
        return rows
    if node_type and "group" in node_type.lower():
        groups: dict[str, dict] = {}
        for row in rows:
            key = row.get("region", "unknown")
            groups.setdefault(key, {"region": key, "count": 0})
            groups[key]["count"] += 1
        return list(groups.values())
    return rows


@router.get("", response_model=list[WorkflowResponse])
def list_workflows(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[Workflow]:
    return db.query(Workflow).filter(Workflow.created_by == user.id).all()


@router.post("", response_model=WorkflowResponse)
def create_workflow(payload: WorkflowCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user), workspace_id: int = 1) -> Workflow:
    workflow = Workflow(
        workspace_id=workspace_id,
        name=payload.name,
        description=payload.description,
        status=payload.status,
        graph=payload.graph,
        created_by=user.id,
    )
    db.add(workflow)
    db.commit()
    db.refresh(workflow)
    return workflow


@router.get("/{workflow_id}", response_model=WorkflowResponse)
def get_workflow(workflow_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Workflow:
    workflow = db.query(Workflow).filter(Workflow.id == workflow_id, Workflow.created_by == user.id).first()
    if not workflow:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workflow not found")
    return workflow


@router.put("/{workflow_id}", response_model=WorkflowResponse)
def update_workflow(workflow_id: int, payload: WorkflowCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Workflow:
    workflow = db.query(Workflow).filter(Workflow.id == workflow_id, Workflow.created_by == user.id).first()
    if not workflow:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workflow not found")
    workflow.name = payload.name
    workflow.description = payload.description
    workflow.graph = payload.graph
    workflow.status = payload.status
    db.commit()
    db.refresh(workflow)
    return workflow


@router.post("/{workflow_id}/execute")
def execute_workflow(workflow_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    workflow = db.query(Workflow).filter(Workflow.id == workflow_id, Workflow.created_by == user.id).first()
    if not workflow:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workflow not found")

    rows = [{"id": 1, "region": "North", "sales": 1000}, {"id": 2, "region": "North", "sales": 1100}, {"id": 3, "region": "South", "sales": 900}, {"id": 2, "region": "North", "sales": 1100}]
    result = rows
    for node in workflow.graph.get("nodes", []):
        node_type = node.get("type", "")
        config = node.get("data", {}).get("config", {})
        result = _transform_rows(result, node_type, config)

    workflow.status = "completed"
    db.commit()
    return {
        "workflow_id": workflow.id,
        "status": "completed",
        "records_extracted": len(rows),
        "records_transformed": len(result),
        "records_loaded": len(result),
        "output": result[:5],
    }
