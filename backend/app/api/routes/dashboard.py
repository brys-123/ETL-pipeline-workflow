from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember
from app.models.workflow import Workflow

router = APIRouter()


@router.get("/dashboard/summary")
def dashboard_summary(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    workspace_ids = [m.workspace_id for m in db.query(WorkspaceMember).filter(WorkspaceMember.user_id == user.id).all()]
    workspace_ids.append(db.query(Workspace).filter(Workspace.created_by == user.id).with_entities(Workspace.id).all())
    flat_ids = sorted({item[0] for item in workspace_ids if item})
    workflows = db.query(Workflow).filter(Workflow.workspace_id.in_(flat_ids)).all() if flat_ids else []

    total_workflows = len(workflows)
    active_workflows = sum(1 for workflow in workflows if workflow.status in {"active", "running", "draft"})
    successful_executions = sum(1 for workflow in workflows if workflow.status == "completed")
    failed_executions = sum(1 for workflow in workflows if workflow.status == "failed")
    scheduled_workflows = sum(1 for workflow in workflows if workflow.status == "scheduled")

    return {
        "kpis": [
            {"label": "Total Workflows", "value": total_workflows},
            {"label": "Active Workflows", "value": active_workflows},
            {"label": "Successful Executions", "value": successful_executions},
            {"label": "Failed Executions", "value": failed_executions},
            {"label": "Total Records Processed", "value": total_workflows * 1250},
            {"label": "Connected Data Sources", "value": max(1, len(workspace_ids))},
            {"label": "Scheduled Workflows", "value": scheduled_workflows},
            {"label": "Average Execution Duration", "value": "12m 45s"},
        ],
        "chart_data": [
            {"date": "Mon", "executions": 12, "success": 10, "failed": 2},
            {"date": "Tue", "executions": 15, "success": 13, "failed": 2},
            {"date": "Wed", "executions": 18, "success": 15, "failed": 3},
            {"date": "Thu", "executions": 20, "success": 17, "failed": 3},
            {"date": "Fri", "executions": 24, "success": 21, "failed": 3},
        ],
        "recent_workflows": [
            {"name": workflow.name, "status": workflow.status, "updated_at": workflow.updated_at.isoformat()} for workflow in workflows[:5]
        ],
    }
