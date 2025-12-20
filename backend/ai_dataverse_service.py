# ai_dataverse_service.py - Dataverse data layer for AI assistant
import os
import requests
from datetime import datetime, timedelta
from typing import Optional, Dict, List, Any
from dataverse_helper import get_access_token

# Load from environment
RESOURCE = os.getenv("RESOURCE", "").rstrip("/")
BASE_URL = f"{RESOURCE}/api/data/v9.2" if RESOURCE else ""

# Entity configurations (from unified_server.py)
ENTITIES = {
    "employees": "crc6f_table12s",
    "attendance": "crc6f_table13s",
    "leave": "crc6f_table14s",
    "leave_balance": "crc6f_hr_leavemangements",
    "assets": "crc6f_hr_assetdetailses",
    "holidays": "crc6f_hr_holidayses",
    "clients": "crc6f_hr_clients",
    "projects": "crc6f_hr_projectheaders",
    "interns": "crc6f_hr_interndetailses",
    "login": "crc6f_hr_login_detailses",
    "inbox": "crc6f_hr_inboxes",
}


def _get_headers(token: str) -> dict:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0",
    }


def _fetch_entity(entity: str, token: str, select: str = "", filter_query: str = "", top: int = 100) -> List[dict]:
    """Generic fetch from Dataverse entity."""
    try:
        url = f"{BASE_URL}/{entity}"
        params = []
        if select:
            params.append(f"$select={select}")
        if filter_query:
            params.append(f"$filter={filter_query}")
        params.append(f"$top={top}")
        
        if params:
            url += "?" + "&".join(params)
        
        resp = requests.get(url, headers=_get_headers(token), timeout=30)
        if resp.status_code == 200:
            return resp.json().get("value", [])
        return []
    except Exception as e:
        print(f"[AI Service] Error fetching {entity}: {e}")
        return []


def get_employee_overview(token: str, emp_id: str) -> dict:
    """Get overview of a specific employee."""
    entity = ENTITIES["employees"]
    records = _fetch_entity(
        entity, token,
        select="crc6f_employeeid,crc6f_firstname,crc6f_lastname,crc6f_email,crc6f_department,crc6f_designation,crc6f_doj,crc6f_activeflag",
        filter_query=f"crc6f_employeeid eq '{emp_id}'",
        top=1
    )
    if records:
        r = records[0]
        return {
            "employee_id": r.get("crc6f_employeeid"),
            "name": f"{r.get('crc6f_firstname', '')} {r.get('crc6f_lastname', '')}".strip(),
            "email": r.get("crc6f_email"),
            "department": r.get("crc6f_department"),
            "designation": r.get("crc6f_designation"),
            "date_of_joining": r.get("crc6f_doj"),
            "active": r.get("crc6f_activeflag"),
        }
    return {}


def get_all_employees_summary(token: str) -> dict:
    """Get summary of all employees."""
    entity = ENTITIES["employees"]
    records = _fetch_entity(
        entity, token,
        select="crc6f_employeeid,crc6f_firstname,crc6f_lastname,crc6f_department,crc6f_designation,crc6f_activeflag",
        top=500
    )
    
    total = len(records)
    active = sum(1 for r in records if r.get("crc6f_activeflag") in [True, "Active", "active", 1, "1"])
    
    # Group by department
    departments = {}
    for r in records:
        dept = r.get("crc6f_department") or "Unknown"
        departments[dept] = departments.get(dept, 0) + 1
    
    return {
        "total_employees": total,
        "active_employees": active,
        "inactive_employees": total - active,
        "by_department": departments,
        "sample_employees": [
            {
                "id": r.get("crc6f_employeeid"),
                "name": f"{r.get('crc6f_firstname', '')} {r.get('crc6f_lastname', '')}".strip(),
                "department": r.get("crc6f_department"),
            }
            for r in records[:10]
        ]
    }


def get_attendance_summary(token: str, emp_id: Optional[str] = None, days: int = 30) -> dict:
    """Get attendance summary for employee or org."""
    entity = ENTITIES["attendance"]
    
    # Date filter for recent records
    start_date = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    filter_query = f"crc6f_date ge {start_date}"
    
    if emp_id:
        filter_query += f" and crc6f_employeeid eq '{emp_id}'"
    
    records = _fetch_entity(
        entity, token,
        select="crc6f_employeeid,crc6f_date,crc6f_checkin,crc6f_checkout,crc6f_duration",
        filter_query=filter_query,
        top=500
    )
    
    total_records = len(records)
    
    # Calculate stats
    total_hours = 0
    for r in records:
        duration = r.get("crc6f_duration")
        if duration:
            try:
                # Parse duration (could be in various formats)
                if isinstance(duration, (int, float)):
                    total_hours += float(duration)
                elif ":" in str(duration):
                    parts = str(duration).split(":")
                    total_hours += int(parts[0]) + int(parts[1]) / 60
            except:
                pass
    
    avg_hours = total_hours / total_records if total_records > 0 else 0
    
    return {
        "period_days": days,
        "total_attendance_records": total_records,
        "total_hours_logged": round(total_hours, 2),
        "average_hours_per_day": round(avg_hours, 2),
        "recent_entries": [
            {
                "employee_id": r.get("crc6f_employeeid"),
                "date": r.get("crc6f_date"),
                "check_in": r.get("crc6f_checkin"),
                "check_out": r.get("crc6f_checkout"),
                "duration": r.get("crc6f_duration"),
            }
            for r in records[:10]
        ]
    }


def get_leave_summary(token: str, emp_id: Optional[str] = None) -> dict:
    """Get leave requests summary."""
    entity = ENTITIES["leave"]
    
    filter_query = ""
    if emp_id:
        filter_query = f"crc6f_employeeid eq '{emp_id}'"
    
    records = _fetch_entity(
        entity, token,
        select="crc6f_employeeid,crc6f_leavetype,crc6f_startdate,crc6f_enddate,crc6f_status,crc6f_reason",
        filter_query=filter_query,
        top=200
    )
    
    # Count by status
    by_status = {}
    by_type = {}
    for r in records:
        status = r.get("crc6f_status") or "Unknown"
        leave_type = r.get("crc6f_leavetype") or "Unknown"
        by_status[status] = by_status.get(status, 0) + 1
        by_type[leave_type] = by_type.get(leave_type, 0) + 1
    
    return {
        "total_leave_requests": len(records),
        "by_status": by_status,
        "by_type": by_type,
        "recent_requests": [
            {
                "employee_id": r.get("crc6f_employeeid"),
                "type": r.get("crc6f_leavetype"),
                "start": r.get("crc6f_startdate"),
                "end": r.get("crc6f_enddate"),
                "status": r.get("crc6f_status"),
                "reason": r.get("crc6f_reason"),
            }
            for r in records[:10]
        ]
    }


def get_assets_summary(token: str) -> dict:
    """Get assets summary."""
    entity = ENTITIES["assets"]
    
    records = _fetch_entity(
        entity, token,
        top=200
    )
    
    return {
        "total_assets": len(records),
        "sample_assets": records[:5] if records else []
    }


def get_holidays_list(token: str) -> dict:
    """Get holidays list."""
    entity = ENTITIES["holidays"]
    
    records = _fetch_entity(
        entity, token,
        top=50
    )
    
    return {
        "total_holidays": len(records),
        "holidays": records[:20] if records else []
    }


def get_projects_summary(token: str) -> dict:
    """Get projects summary."""
    entity = ENTITIES["projects"]
    
    records = _fetch_entity(
        entity, token,
        top=100
    )
    
    return {
        "total_projects": len(records),
        "projects": records[:10] if records else []
    }


def get_interns_summary(token: str) -> dict:
    """Get interns summary."""
    entity = ENTITIES["interns"]
    
    records = _fetch_entity(
        entity, token,
        top=100
    )
    
    return {
        "total_interns": len(records),
        "interns": records[:10] if records else []
    }


def build_ai_context(token: str, user_meta: dict, scope: str = "general") -> dict:
    """
    Build comprehensive context for AI based on user role and scope.
    
    Args:
        token: Dataverse access token
        user_meta: User info (employee_id, is_admin, is_l3, etc.)
        scope: Query scope ('general', 'attendance', 'leave', 'employee', etc.)
    
    Returns:
        Dict with relevant data summaries
    """
    context = {
        "timestamp": datetime.now().isoformat(),
        "user_role": "Admin" if user_meta.get("is_admin") else "L3" if user_meta.get("is_l3") else "Employee",
    }
    
    emp_id = user_meta.get("employee_id")
    is_admin = user_meta.get("is_admin", False)
    is_l3 = user_meta.get("is_l3", False)
    
    try:
        # Always include basic employee info for the current user
        if emp_id:
            context["current_user_profile"] = get_employee_overview(token, emp_id)
        
        # Scope-based data fetching with L3 permissions
        if scope in ["general", "employee", "all"]:
            if is_admin or is_l3:  # L3 gets same access as admin
                context["employees_summary"] = get_all_employees_summary(token)
            elif emp_id:
                context["my_profile"] = get_employee_overview(token, emp_id)
        
        if scope in ["general", "attendance", "all"]:
            if is_admin or is_l3:  # L3 gets same access as admin
                context["attendance_summary"] = get_attendance_summary(token, days=30)
            elif emp_id:
                context["my_attendance"] = get_attendance_summary(token, emp_id=emp_id, days=30)
        
        if scope in ["general", "leave", "all"]:
            if is_admin or is_l3:  # L3 gets same access as admin
                context["leave_summary"] = get_leave_summary(token)
            elif emp_id:
                context["my_leaves"] = get_leave_summary(token, emp_id=emp_id)
        
        if scope in ["general", "assets", "all"]:
            if is_admin or is_l3:  # L3 gets same access as admin
                context["assets_summary"] = get_assets_summary(token)
        
        if scope in ["general", "holidays", "all"]:
            context["holidays"] = get_holidays_list(token)
        
        if scope in ["general", "projects", "all"]:
            if is_admin or is_l3:  # L3 gets same access as admin
                context["projects_summary"] = get_projects_summary(token)
        
        if scope in ["general", "interns", "all"]:
            if is_admin or is_l3:  # L3 gets same access as admin
                context["interns_summary"] = get_interns_summary(token)
            
    except Exception as e:
        context["error"] = f"Error fetching some data: {str(e)}"
    
    return context
