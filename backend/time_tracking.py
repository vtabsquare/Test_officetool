from flask import Blueprint, request, jsonify
from datetime import datetime, timezone, timedelta
import os, json
from dataverse_helper import get_access_token
import requests
import urllib.parse

bp_time = Blueprint("time_tracking", __name__, url_prefix="/api")

# Dataverse config
RESOURCE = os.getenv("RESOURCE")
DV_API = os.getenv("DATAVERSE_API", "/api/data/v9.2")
ENTITY_SET_TASKS = "crc6f_hr_taskdetailses"

# Dataverse entity set for project headers
ENTITY_SET_PROJECTS = "crc6f_hr_projectheaders"


def _dv_formatted(rec: dict, field: str):
    try:
        return rec.get(f"{field}@OData.Community.Display.V1.FormattedValue")
    except Exception:
        return None


def _normalize_status(val: str) -> str:
    s = (val or "").strip()
    if not s:
        return s
    low = s.lower()
    if low in ("canceled", "cancelled"):
        return "Cancelled"
    if low == "inactive":
        return "Inactive"
    return s


def _fetch_projects_index(project_ids, headers):
    """Return (existing_ids_set, status_by_id, inactive_ids_set)."""
    pids = [str(x).strip() for x in (project_ids or []) if str(x).strip()]
    if not pids:
        return set(), {}, set()

    # Dataverse has URL/query length limits; chunk the filter.
    existing = set()
    status_by_id = {}
    inactive = set()

    chunk_size = 25
    for i in range(0, len(pids), chunk_size):
        chunk = pids[i : i + chunk_size]
        # Build OR filter: (crc6f_projectid eq 'P1' or crc6f_projectid eq 'P2' ...)
        ors = []
        for pid in chunk:
            safe = pid.replace("'", "''")
            ors.append(f"crc6f_projectid eq '{safe}'")
        filter_expr = " or ".join(ors)
        filter_q = urllib.parse.quote(filter_expr, safe="()'= $")
        select = "crc6f_projectid,crc6f_projectstatus,statecode,statuscode"
        url = f"{RESOURCE}{DV_API}/{ENTITY_SET_PROJECTS}?$select={select}&$filter={filter_q}"
        resp = requests.get(url, headers=headers, timeout=30)
        if not resp.ok:
            # If project lookup fails, do not hide tasks (safer). Caller will treat as unknown.
            continue
        vals = resp.json().get("value", [])
        for p in vals:
            pid = (p.get("crc6f_projectid") or "").strip()
            if not pid:
                continue
            existing.add(pid)
            # Prefer formatted labels if present
            proj_status = _dv_formatted(p, "crc6f_projectstatus") or p.get("crc6f_projectstatus")
            if proj_status is not None:
                status_by_id[pid] = _normalize_status(str(proj_status))
            try:
                if int(p.get("statecode") or 0) != 0:
                    inactive.add(pid)
            except Exception:
                pass
    return existing, status_by_id, inactive

TIMESHEET_RPT_MAP = {
    "createdon": "crc6f_RPT_createdon",
    "modifiedon": "crc6f_RPT_modifiedon",
    "statecode": "crc6f_RPT_statecode",
    "statuscode": "crc6f_RPT_statuscode",
    "importsequencenumber": "crc6f_RPT_importsequencenumber",
    "overriddencreatedon": "crc6f_RPT_overriddencreatedon",
    "timezoneruleversionnumber": "crc6f_RPT_timezoneruleversionnumber",
    "utcconversiontimezonecode": "crc6f_RPT_utcconversiontimezonecode",
    "crc6f_workdate": "crc6f_RPT_workdate",
}

# Simple file-based store for time entries to persist across restarts
DATA_DIR = os.path.join(os.path.dirname(__file__), "_data")
ENTRIES_FILE = os.path.join(DATA_DIR, "time_entries.json")
LOGS_FILE = os.path.join(DATA_DIR, "timesheet_logs.json")
TS_ENTRIES_FILE = os.path.join(DATA_DIR, "timesheet_entries.json")

os.makedirs(DATA_DIR, exist_ok=True)


def _read_entries():
    try:
        with open(ENTRIES_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def _write_entries(entries):
    tmp = ENTRIES_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(entries, f)
    os.replace(tmp, ENTRIES_FILE)


def _read_logs():
    try:
        with open(LOGS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def _write_logs(logs):
    tmp = LOGS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(logs, f)
    os.replace(tmp, LOGS_FILE)


def _read_ts_entries():
    """Read high-level timesheet submissions (for approval workflow)."""
    try:
        with open(TS_ENTRIES_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def _write_ts_entries(entries):
    tmp = TS_ENTRIES_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(entries, f)
    os.replace(tmp, TS_ENTRIES_FILE)


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _sum_seconds_for_task(entries, task_guid, user_id=None):
    total = 0
    now = datetime.now(timezone.utc)
    for e in entries:
        if e.get("task_guid") != task_guid:
            continue
        if user_id and e.get("user_id") != user_id:
            continue
        start = datetime.fromisoformat(e["start"]) if e.get("start") else None
        if not start:
            continue
        if e.get("end"):
            end = datetime.fromisoformat(e["end"])
        else:
            end = now
        total += int((end - start).total_seconds())
    return total


def _format_hms(seconds: int) -> str:
    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    return f"{h}h {m:02d}m {s:02d}s"


def _split_session_by_day(start_ms: int, end_ms: int, tz_offset_minutes: int = 0):
    """
    Split a session (ms timestamps) into per-day segments in the client's local timezone.
    Returns list of (work_date_str, seconds) tuples.
    """
    if start_ms is None or end_ms is None:
        return []
    if end_ms < start_ms:
        start_ms, end_ms = end_ms, start_ms

    # Convert ms to datetime in UTC, then adjust to client local by offset minutes
    def to_local(ms):
        dt_utc = datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
        return dt_utc - timedelta(minutes=tz_offset_minutes)

    start_local = to_local(start_ms)
    end_local = to_local(end_ms)

    segments = []
    cursor = start_local
    while cursor < end_local:
        end_of_day = (cursor.replace(hour=23, minute=59, second=59, microsecond=999999))
        segment_end = min(end_local, end_of_day)
        seconds = int((segment_end - cursor).total_seconds())
        if seconds > 0:
            work_date = cursor.date().isoformat()
            segments.append((work_date, seconds))
        cursor = segment_end + timedelta(microseconds=1)
    return segments


# ---------- Tasks proxy for My Tasks (Dataverse) ----------
@bp_time.route("/tasks", methods=["GET"])
def proxy_tasks():
    """
    GET /api/tasks
    Optional filters:
      - assigned_to: substring match against crc6f_assignedto
      - project_id: exact match against crc6f_projectid
    """
    try:
        assigned_to = (request.args.get("assigned_to") or "").strip().lower()
        project_id = (request.args.get("project_id") or "").strip()

        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-Version": "4.0",
            "Content-Type": "application/json",
            "Prefer": 'odata.include-annotations="*"',
        }
        url = f"{RESOURCE}{DV_API}/{ENTITY_SET_TASKS}?$select=crc6f_hr_taskdetailsid,crc6f_taskid,crc6f_taskname,crc6f_taskdescription,crc6f_taskpriority,crc6f_taskstatus,crc6f_assignedto,crc6f_assigneddate,crc6f_duedate,crc6f_projectid,crc6f_boardid,statecode,statuscode"
        resp = requests.get(url, headers=headers, timeout=30)
        if not resp.ok:
            return jsonify({"success": False, "error": resp.text}), resp.status_code
        values = resp.json().get("value", [])

        items = []
        for t in values:
            guid = t.get("crc6f_hr_taskdetailsid")
            if not guid:
                continue
            rec = {
                "guid": guid,
                "task_id": t.get("crc6f_taskid"),
                "task_name": t.get("crc6f_taskname"),
                "task_description": t.get("crc6f_taskdescription"),
                "task_priority": t.get("crc6f_taskpriority"),
                "task_status": _normalize_status(str(_dv_formatted(t, "crc6f_taskstatus") or t.get("crc6f_taskstatus") or "")),
                "assigned_to": t.get("crc6f_assignedto"),
                "assigned_date": t.get("crc6f_assigneddate"),
                "due_date": t.get("crc6f_duedate"),
                "project_id": t.get("crc6f_projectid"),
                "board_id": t.get("crc6f_boardid"),
                "_task_statecode": t.get("statecode"),
                "_task_statuscode": t.get("statuscode"),
            }
            if assigned_to:
                ass = (rec.get("assigned_to") or "").lower()
                if assigned_to not in ass:
                    continue
            if project_id and str(rec.get("project_id") or "").strip() != project_id:
                continue
            items.append(rec)
        return jsonify({"success": True, "tasks": items}), 200
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@bp_time.route("/time-tracker/logs/exact", methods=["PUT"])
def set_exact_log():
    try:
        b = request.get_json(force=True) or {}
        employee_id = (b.get("employee_id") or "").strip()
        project_id = (b.get("project_id") or "").strip()
        task_guid = (b.get("task_guid") or "").strip()
        task_id = (b.get("task_id") or "").strip()
        work_date = (b.get("work_date") or "").strip()
        seconds = int(b.get("seconds") or 0)
        description = (b.get("description") or "").strip()
        role = (b.get("role") or "l1").lower()
        editor_id = (b.get("editor_id") or "").strip()

        if not employee_id or not work_date or seconds < 0:
            return jsonify({"success": False, "error": "employee_id, work_date required; seconds>=0"}), 400
        # Only L2/L3 allowed to perform manual edits
        if role == "l1":
            return jsonify({"success": False, "error": "forbidden"}), 403

        logs = _read_logs()
        idx = None
        for i, r in enumerate(logs):
            if (
                r.get("employee_id") == employee_id
                and (r.get("task_guid") or r.get("task_id")) == (task_guid or task_id)
                and r.get("work_date") == work_date
            ):
                idx = i
                break

        dv_id = None
        if idx is not None:
            prev = logs[idx]
            dv_id = prev.get("dv_id")
            logs[idx] = {
                **prev,
                "seconds": int(seconds),
                "description": description or prev.get("description") or "",
                "manual": role != "l1",
                "editor_id": editor_id or prev.get("editor_id"),
            }
            rec = logs[idx]
        else:
            rec = {
                "id": f"LOG-{int(datetime.now().timestamp()*1000)}",
                "employee_id": employee_id,
                "project_id": project_id,
                "task_guid": task_guid or None,
                "task_id": task_id or None,
                "task_name": b.get("task_name") or "",
                "seconds": int(seconds),
                "work_date": work_date,
                "description": description,
                "manual": role != "l1",
                "editor_id": editor_id or None,
                "created_at": _now_iso(),
            }
            logs.append(rec)

        # Collapse duplicates for same employee+task+date to avoid double counting
        try:
            base_key = (employee_id, (task_guid or task_id), work_date)
            keep_index = None
            for i, r in enumerate(list(logs)):
                rk = (r.get("employee_id"), (r.get("task_guid") or r.get("task_id")), r.get("work_date"))
                if rk == base_key:
                    if keep_index is None:
                        keep_index = i
                        # ensure kept record matches rec
                        logs[i] = rec
                    elif i != keep_index:
                        # remove duplicate
                        logs.pop(i)
            # rec reference may shift; safe
        except Exception:
            pass

        try:
            token = get_access_token()
            headers = {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "OData-Version": "4.0",
            }
            hours_worked = round(seconds / 3600, 2)
            if dv_id:
                url = f"{RESOURCE}{DV_API}/crc6f_hr_timesheetlogs({dv_id})"
                payload = {"crc6f_hoursworked": hours_worked, "crc6f_workdescription": description}
                dv_resp = requests.patch(url, headers=headers, json=payload, timeout=30)
                if dv_resp.status_code in (200, 204):
                    rec["dv_id"] = dv_id
                else:
                    pass
            else:
                url = f"{RESOURCE}{DV_API}/crc6f_hr_timesheetlogs"
                payload = {
                    "crc6f_employeeid": employee_id,
                    "crc6f_projectid": project_id,
                    "crc6f_taskid": task_id,
                    "crc6f_hoursworked": hours_worked,
                    "crc6f_workdescription": description,
                    "crc6f_approvalstatus": "Pending",
                }
                dv_resp = requests.post(url, headers=headers, json=payload, timeout=30)
                if dv_resp.status_code in (200, 201, 204):
                    try:
                        ent = dv_resp.headers.get('OData-EntityId') or dv_resp.headers.get('odata-entityid')
                        if ent and ent.endswith(')') and '(' in ent:
                            rec["dv_id"] = ent.split('(')[-1].strip(')')
                    except Exception:
                        pass
        except Exception:
            pass

        _write_logs(logs)
        return jsonify({"success": True, "log": rec}), 200
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ---------- My Tasks listing (RBAC filtering) ----------
@bp_time.route("/my-tasks", methods=["GET"])
def list_my_tasks():
    """
    Query params:
      - user_id: EMP0001
      - user_name: display name (optional, used for matching assigned_to if needed)
      - role: l1|l2|l3
    Returns tasks from Dataverse with computed timeSpent for the given user.
    L1: only tasks assigned to the user (by name or id substring match)
    L2/L3: all tasks
    """
    try:
        user_id = (request.args.get("user_id") or "").strip()
        user_name = (request.args.get("user_name") or "").strip()
        user_email = (request.args.get("user_email") or "").strip()
        role = (request.args.get("role") or "l1").lower()

        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-Version": "4.0",
            "Content-Type": "application/json",
        }

        # Fetch all tasks (could be optimized with paging if needed)
        url = f"{RESOURCE}{DV_API}/{ENTITY_SET_TASKS}?$select=crc6f_hr_taskdetailsid,crc6f_taskid,crc6f_taskname,crc6f_taskdescription,crc6f_taskpriority,crc6f_taskstatus,crc6f_assignedto,crc6f_assigneddate,crc6f_duedate,crc6f_projectid,crc6f_boardid"
        resp = requests.get(url, headers=headers, timeout=30)
        if not resp.ok:
            return jsonify({"success": False, "error": resp.text}), resp.status_code
        values = resp.json().get("value", [])

        # Filter tasks so that all roles only see tasks assigned to them
        out = []
        uid_lc = (user_id or "").lower()
        uname_lc = (user_name or "").lower()
        uemail_lc = (user_email or "").lower()

        for t in values:
            rec = {
                "guid": t.get("crc6f_hr_taskdetailsid"),
                "task_id": t.get("crc6f_taskid"),
                "task_name": t.get("crc6f_taskname"),
                "task_description": t.get("crc6f_taskdescription"),
                "task_priority": t.get("crc6f_taskpriority"),
                "task_status": t.get("crc6f_taskstatus"),
                "assigned_to": t.get("crc6f_assignedto"),
                "assigned_date": t.get("crc6f_assigneddate"),
                "due_date": t.get("crc6f_duedate"),
                "project_id": t.get("crc6f_projectid"),
                "board_id": t.get("crc6f_boardid"),
            }

            # Require at least one identifier; otherwise we can't safely match
            if not (uid_lc or uname_lc or uemail_lc):
                continue

            ass = (rec.get("assigned_to") or "").lower()
            if not ass:
                continue

            if (
                (uid_lc and uid_lc in ass)
                or (uname_lc and uname_lc in ass)
                or (uemail_lc and uemail_lc in ass)
            ):
                out.append(rec)

        # Resolve project availability/status. If a project record is missing (deleted),
        # remove its tasks from My Tasks.
        project_ids = list({str(r.get("project_id") or "").strip() for r in out if str(r.get("project_id") or "").strip()})
        existing_projects, project_status_by_id, inactive_projects = _fetch_projects_index(project_ids, headers)

        filtered = []
        for rec in out:
            pid = str(rec.get("project_id") or "").strip()
            if pid:
                # If we were able to fetch projects and this pid isn't present, treat as deleted.
                if existing_projects and pid not in existing_projects:
                    continue

                proj_status = project_status_by_id.get(pid)
                if proj_status:
                    # If project is inactive/cancelled, show the exact projectstatus value.
                    if pid in inactive_projects or proj_status.lower() in ("cancelled", "canceled", "inactive"):
                        rec["task_status"] = proj_status

            # If task record is inactive, reflect it in task_status (but do not remove).
            try:
                if int(rec.get("_task_statecode") or 0) != 0:
                    rec["task_status"] = _normalize_status(rec.get("task_status") or "Inactive") or "Inactive"
            except Exception:
                pass

            # Remove internal fields
            rec.pop("_task_statecode", None)
            rec.pop("_task_statuscode", None)
            filtered.append(rec)

        out = filtered

        # Attach time totals for the requesting user
        entries = _read_entries()
        for rec in out:
            secs = _sum_seconds_for_task(entries, rec.get("guid"), user_id=user_id)
            rec["time_spent_seconds"] = secs
            rec["time_spent_text"] = _format_hms(secs)
        return jsonify({"success": True, "tasks": out}), 200
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ---------- Timer controls ----------
@bp_time.route("/time-entries/status", methods=["GET"])
def timer_status():
    user_id = (request.args.get("user_id") or "").strip()
    if not user_id:
        return jsonify({"success": False, "error": "user_id required"}), 400
    entries = _read_entries()
    now = datetime.now(timezone.utc)
    for e in entries:
        if e.get("user_id") == user_id and not e.get("end"):
            start = datetime.fromisoformat(e["start"]) if e.get("start") else now
            elapsed = int((now - start).total_seconds())
            return jsonify({
                "success": True,
                "active": True,
                "task_guid": e.get("task_guid"),
                "start": e.get("start"),
                "elapsed_seconds": elapsed,
            })
    return jsonify({"success": True, "active": False})


@bp_time.route("/time-entries/start", methods=["POST"])
def start_timer():
    data = request.get_json(force=True) or {}
    task_guid = (data.get("task_guid") or "").strip()
    user_id = (data.get("user_id") or "").strip()
    if not task_guid or not user_id:
        return jsonify({"success": False, "error": "task_guid and user_id required"}), 400

    entries = _read_entries()
    # stop any other active entries for this user (single active guard)
    changed = False
    now_iso = _now_iso()
    for e in entries:
        if e.get("user_id") == user_id and not e.get("end"):
            e["end"] = now_iso
            changed = True
    new_entry = {
        "id": f"TE-{int(datetime.now().timestamp()*1000)}",
        "task_guid": task_guid,
        "user_id": user_id,
        "start": now_iso,
        "end": None,
    }
    entries.append(new_entry)
    _write_entries(entries)
    return jsonify({"success": True, "entry": new_entry})


@bp_time.route("/time-entries/stop", methods=["POST"])
def stop_timer():
    data = request.get_json(force=True) or {}
    task_guid = (data.get("task_guid") or "").strip()
    user_id = (data.get("user_id") or "").strip()
    if not task_guid or not user_id:
        return jsonify({"success": False, "error": "task_guid and user_id required"}), 400

    entries = _read_entries()
    now_iso = _now_iso()
    stopped = None
    for e in entries:
        if e.get("user_id") == user_id and e.get("task_guid") == task_guid and not e.get("end"):
            e["end"] = now_iso
            stopped = e
            break
    if not stopped:
        return jsonify({"success": False, "error": "No active timer for this task"}), 400
    _write_entries(entries)
    return jsonify({"success": True, "entry": stopped})


# ---------- Timesheet logs (create/read/delete) - Dataverse Integration ----------
@bp_time.route("/time-tracker/task-log", methods=["POST"])
def create_task_log():
    """
    Body: { employee_id, project_id, task_guid, task_id, task_name, seconds, work_date, description }
    Optional: session_start_ms, session_end_ms, tz_offset_minutes to split across days
    Stores in Dataverse table: crc6f_hr_timesheetlog
    """
    try:
        b = request.get_json(force=True) or {}
        employee_id = (b.get("employee_id") or "").strip()
        seconds = int(b.get("seconds") or 0)
        work_date = (b.get("work_date") or "").strip()  # YYYY-MM-DD (fallback)
        project_id = (b.get("project_id") or "").strip()
        task_id = (b.get("task_id") or "").strip()
        task_guid = (b.get("task_guid") or "").strip()
        session_start_ms = b.get("session_start_ms")
        session_end_ms = b.get("session_end_ms")
        tz_offset_minutes = int(b.get("tz_offset_minutes") or 0)
        
        print(f"[TIME_TRACKER] POST /time-tracker/task-log - employee_id={employee_id}, task_id={task_id}, seconds={seconds}, work_date={work_date}")
        
        if not employee_id or seconds <= 0:
            print(f"[TIME_TRACKER] Validation failed: employee_id={employee_id}, seconds={seconds}")
            return jsonify({"success": False, "error": "employee_id and seconds>0 required"}), 400

        # Build per-day segments
        segments = []
        if session_start_ms is not None and session_end_ms is not None:
            segments = _split_session_by_day(int(session_start_ms), int(session_end_ms), tz_offset_minutes)
        # Fallback to provided work_date
        if not segments:
            if not work_date:
                work_date = datetime.utcnow().date().isoformat()
            segments = [(work_date, seconds)]

        if not segments:
            return jsonify({"success": False, "error": "No time segments to log"}), 400
        
        def upsert_segment(seg_work_date: str, seg_seconds: int):
            # Convert seconds to hours (decimal)
            hours_worked = round(seg_seconds / 3600, 2)

            payload = {
                "crc6f_employeeid": employee_id,
                "crc6f_projectid": project_id,
                "crc6f_taskid": task_id,
                "crc6f_hoursworked": str(hours_worked),
                "crc6f_workdescription": b.get("description") or b.get("task_name") or "",
                "crc6f_approvalstatus": "Pending",
                # Dataverse work date field (Date Only)
                "crc6f_workdate": seg_work_date if seg_work_date else None
            }
            # Remove None values
            payload = {k: v for k, v in payload.items() if v is not None}

            token = get_access_token()
            headers = {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "OData-Version": "4.0",
            }

            url = f"{RESOURCE}{DV_API}/crc6f_hr_timesheetlogs"
            print(f"[TIME_TRACKER] Posting to Dataverse: {url}")
            print(f"[TIME_TRACKER] Payload: {payload}")
            resp = requests.post(url, headers=headers, json=payload, timeout=30)
            print(f"[TIME_TRACKER] Dataverse response status: {resp.status_code}")
            if resp.status_code not in (200, 201, 204):
                print(f"[TIME_TRACKER] Dataverse error ({resp.status_code}): {resp.text}")
            else:
                print(f"[TIME_TRACKER] Dataverse save successful")

            logs = _read_logs()
            dv_id = None
            try:
                ent = resp.headers.get('OData-EntityId') or resp.headers.get('odata-entityid')
                if ent and ent.endswith(')') and '(' in ent:
                    dv_id = ent.split('(')[-1].strip(')')
            except Exception:
                dv_id = None

            # UPSERT local log by employee + task + work_date
            idx = None
            for i, r in enumerate(logs):
                if (
                    r.get("employee_id") == employee_id
                    and (r.get("task_guid") or r.get("task_id")) == (task_guid or task_id)
                    and r.get("work_date") == seg_work_date
                ):
                    idx = i
                    break
            if idx is not None:
                prev = logs[idx]
                new_secs = (int(prev.get("seconds") or 0) + int(seg_seconds))
                logs[idx] = {
                    **prev,
                    "seconds": new_secs,
                    "description": b.get("description") or prev.get("description") or "",
                    "dv_id": prev.get("dv_id") or dv_id
                }
                rec_local = logs[idx]
                print(f"[TIME_TRACKER] Upserted local log (aggregate): {employee_id} {task_id} {seg_work_date} -> {new_secs}s")
            else:
                rec_local = {
                    "id": f"LOG-{int(datetime.now().timestamp()*1000)}",
                    "employee_id": employee_id,
                    "project_id": project_id,
                    "task_guid": task_guid or None,
                    "task_id": task_id or None,
                    "task_name": b.get("task_name"),
                    "seconds": seg_seconds,
                    "work_date": seg_work_date,
                    "description": b.get("description") or "",
                    "dv_id": dv_id,
                    "created_at": _now_iso(),
                }
                logs.append(rec_local)
                print(f"[TIME_TRACKER] Inserted new local log: {employee_id} {task_id} {seg_work_date} -> {seg_seconds}s")
            _write_logs(logs)
            # Also save to timesheet logs for My Timesheet page
            try:
                logs = _read_logs()
                
                # Check if entry already exists for this employee/task/date
                existing_idx = None
                for i, r in enumerate(logs):
                    if (
                        r.get("employee_id") == employee_id
                        and (r.get("task_guid") or r.get("task_id")) == (task_guid or task_id)
                        and r.get("work_date") == seg_work_date
                    ):
                        existing_idx = i
                        break
                
                log_entry = {
                    "id": f"LOG-{int(datetime.now().timestamp()*1000)}",
                    "employee_id": employee_id,
                    "project_id": project_id,
                    "task_guid": task_guid or None,
                    "task_id": task_id or None,
                    "task_name": b.get("task_name"),
                    "seconds": seg_seconds,
                    "work_date": seg_work_date,
                    "description": b.get("description") or "",
                    "dv_id": dv_id,
                    "created_at": _now_iso(),
                }
                
                if existing_idx is not None:
                    # Update existing entry - add to existing seconds
                    prev = logs[existing_idx]
                    log_entry["seconds"] = int(prev.get("seconds", 0)) + seg_seconds
                    logs[existing_idx] = log_entry
                    print(f"[TIME_TRACKER] Updated existing timesheet log: {employee_id} {task_id} {seg_work_date} -> {log_entry['seconds']}s")
                else:
                    logs.append(log_entry)
                    print(f"[TIME_TRACKER] Added new timesheet log: {employee_id} {task_id} {seg_work_date} -> {seg_seconds}s")
                
                _write_logs(logs)
            except Exception as e:
                print(f"[TIME_TRACKER] Warning: Failed to save to timesheet logs: {e}")
            
            return rec_local

        recs = []
        for seg_date, seg_seconds in segments:
            recs.append(upsert_segment(seg_date, seg_seconds))

        return jsonify({"success": True, "logs": recs, "dataverse_saved": True}), 201
            
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@bp_time.route("/time-tracker/logs", methods=["GET"])
def list_logs():
    """
    Fetch timesheet logs from Dataverse with fallback to local JSON
    Query params: employee_id (required), start_date, end_date
    """
    employee_id = (request.args.get("employee_id") or "").strip()
    start_date = (request.args.get("start_date") or "").strip()  # YYYY-MM-DD
    end_date = (request.args.get("end_date") or "").strip()
    
    print(f"[TIME_TRACKER] GET /time-tracker/logs - employee_id={employee_id}, start_date={start_date}, end_date={end_date}")
    
    if not employee_id:
        return jsonify({"success": False, "error": "employee_id required"}), 400
    
    # Try fetching from Dataverse first
    try:
        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-Version": "4.0",
        }
        
        # Build OData filter
        if employee_id.upper() == "ALL":
            # For team timesheet, fetch all employees within date range
            filter_parts = []
            if start_date:
                filter_parts.append(f"crc6f_workdate ge '{start_date}'")
            if end_date:
                filter_parts.append(f"crc6f_workdate le '{end_date}'")
        else:
            # For individual timesheet
            safe_emp = employee_id.replace("'", "''")
            filter_parts = [f"crc6f_employeeid eq '{safe_emp}'"]
            if start_date:
                filter_parts.append(f"crc6f_workdate ge '{start_date}'")
            if end_date:
                filter_parts.append(f"crc6f_workdate le '{end_date}'")
        
        filter_query = " and ".join(filter_parts) if filter_parts else ""
        url = f"{RESOURCE}{DV_API}/crc6f_hr_timesheetlogs"
        if filter_query:
            url += f"?$filter={filter_query}"
        url += "&$top=5000&$orderby=crc6f_workdate desc"
        
        print(f"[TIME_TRACKER] Fetching from Dataverse URL: {url}")
        print(f"[TIME_TRACKER] Filter query: {filter_query}")
        
        resp = requests.get(url, headers=headers, timeout=30)
        print(f"[TIME_TRACKER] Dataverse response status: {resp.status_code}")
        
        if resp.status_code == 200:
            data = resp.json()
            records = data.get("value", [])
            
            # Transform Dataverse records to frontend format
            out = []
            for r in records:
                # Skip if work_date is in the future
                work_date = r.get("crc6f_workdate", "")
                if work_date:
                    try:
                        # Parse date and check if it's not in the future
                        work_dt = datetime.strptime(work_date[:10], '%Y-%m-%d').date()
                        today = datetime.now().date()
                        if work_dt > today:
                            continue
                    except:
                        pass
                
                log_entry = {
                    "id": r.get("crc6f_hr_timesheetlogid"),
                    "employee_id": r.get("crc6f_employeeid"),
                    "project_id": r.get("crc6f_projectid"),
                    "task_guid": r.get("crc6f_taskguid"),
                    "task_id": r.get("crc6f_taskid"),
                    "task_name": r.get("crc6f_taskname") or r.get("crc6f_workdescription", "").split(" - ")[0] if r.get("crc6f_workdescription") else "",
                    "seconds": int(float(r.get("crc6f_hoursworked", 0)) * 3600),  # Convert hours back to seconds
                    "work_date": work_date[:10] if work_date else "",  # Ensure YYYY-MM-DD format
                    "description": r.get("crc6f_workdescription", ""),
                    "approval_status": r.get("crc6f_approvalstatus", "Pending"),
                    "created_at": r.get("createdon", ""),
                    "manual": False,  # Default to false, can be enhanced later
                }
                
                # Apply additional date filtering in case Dataverse filtering didn't work
                if start_date and log_entry.get("work_date", "") < start_date:
                    continue
                if end_date and log_entry.get("work_date", "") > end_date:
                    continue
                    
                out.append(log_entry)
            
            print(f"[TIME_TRACKER] Successfully fetched {len(out)} logs from Dataverse")
            return jsonify({"success": True, "logs": out, "source": "dataverse"}), 200
        else:
            print(f"[TIME_TRACKER] Dataverse returned {resp.status_code}: {resp.text}")
            raise Exception(f"Dataverse returned {resp.status_code}")
            
    except Exception as e:
        # Fallback to local JSON storage only if Dataverse fails
        print(f"[TIME_TRACKER] Dataverse fetch failed, using local fallback: {e}")
        try:
            logs = _read_logs()
            print(f"[TIME_TRACKER] Read {len(logs)} logs from local storage")
            out = []
            for r in logs:
                # Support "ALL" to fetch all employees' logs (for team timesheet)
                if employee_id != "ALL" and r.get("employee_id") != employee_id:
                    continue
                if start_date and r.get("work_date", "") < start_date:
                    continue
                if end_date and r.get("work_date", "") > end_date:
                    continue
                out.append(r)
            
            if employee_id == "ALL":
                print(f"[TIME_TRACKER] Filtered to {len(out)} logs for ALL employees")
            else:
                print(f"[TIME_TRACKER] Filtered to {len(out)} logs for employee {employee_id}")
            
            return jsonify({"success": True, "logs": out, "source": "local"}), 200
        except Exception as e2:
            print(f"[TIME_TRACKER] Error reading logs: {e2}")
            return jsonify({"success": False, "error": str(e2)}), 500


@bp_time.route("/time-tracker/logs", methods=["DELETE"])
def delete_logs():
    """
    Delete timesheet log from Dataverse
    Body: { log_id } or { employee_id, work_date, project_id/task_id }
    """
    b = request.get_json(force=True) or {}
    log_id = (b.get("log_id") or "").strip()
    
    try:
        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-Version": "4.0",
        }
        
        if log_id:
            # Direct delete by ID
            url = f"{RESOURCE}{DV_API}/crc6f_hr_timesheetlogs({log_id})"
            resp = requests.delete(url, headers=headers, timeout=30)
            
            if resp.status_code in (200, 204):
                # Also delete from local cache
                logs = _read_logs()
                logs = [r for r in logs if r.get("id") != log_id]
                _write_logs(logs)
                return jsonify({"success": True, "deleted": 1, "source": "dataverse"}), 200
            else:
                return jsonify({"success": False, "error": f"Dataverse delete failed: {resp.status_code}"}), 400
        else:
            # Fallback to local deletion if no log_id
            employee_id = (b.get("employee_id") or "").strip()
            project_id = (b.get("project_id") or "").strip()
            task_guid = (b.get("task_guid") or "").strip()
            work_date = (b.get("work_date") or "").strip()
            
            if not employee_id or not work_date:
                return jsonify({"success": False, "error": "log_id or (employee_id and work_date) required"}), 400
            
            logs = _read_logs()
            before = len(logs)
            logs = [r for r in logs if not (
                r.get("employee_id") == employee_id and r.get("work_date") == work_date and
                ((project_id and r.get("project_id") == project_id) or (task_guid and r.get("task_guid") == task_guid))
            )]
            _write_logs(logs)
            return jsonify({"success": True, "deleted": before - len(logs), "source": "local"}), 200
            
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


def _update_timesheet_status(entry_id, new_status, comment=None, decided_by=None):
    """Helper to update status of a timesheet submission in TS_ENTRIES_FILE."""
    entries = _read_ts_entries()
    updated = None
    for rec in entries:
        if str(rec.get("id")) == str(entry_id):
            rec["status"] = new_status
            rec["decided_at"] = _now_iso()
            if decided_by:
                rec["decided_by"] = decided_by
            if comment is not None:
                rec["reject_comment"] = comment
            updated = rec
            break
    if not updated:
        return None, entries
    _write_ts_entries(entries)
    return updated, entries


@bp_time.route("/time-tracker/timesheet/submit", methods=["POST"])
def submit_timesheet():
    """Create Pending timesheet submissions from the My Timesheet page.

    Body: {
      "employee_id": "EMP001",
      "employee_name": "John Doe",  # optional
      "entries": [
        {
          "date": "2025-11-17",
          "project_id": "VTAB004",
          "project_name": "Amber - Fidelity",
          "task_id": "TASK003",
          "task_guid": "...",
          "task_name": "Backend work",
          "seconds": 3600,
          "hours_worked": 1.0,
          "description": ""
        },
        ...
      ]
    }
    """
    try:
        body = request.get_json(force=True) or {}
        employee_id = (body.get("employee_id") or "").strip()
        employee_name = (body.get("employee_name") or "").strip()
        raw_entries = body.get("entries") or []

        if not employee_id or not raw_entries:
            return jsonify({"success": False, "error": "employee_id and entries required"}), 400

        entries = _read_ts_entries()
        created = []
        base_ts = int(datetime.now().timestamp() * 1000)

        for idx, item in enumerate(raw_entries):
            date = (item.get("date") or "").strip()
            if not date:
                continue
            seconds = int(item.get("seconds") or 0)
            if seconds <= 0:
                continue
            hours = item.get("hours_worked")
            try:
                hours_val = float(hours) if hours is not None else round(seconds / 3600, 2)
            except Exception:
                hours_val = round(seconds / 3600, 2)

            rec = {
                "id": f"TS-{base_ts + idx}",
                "employee_id": employee_id,
                "employee_name": employee_name,
                "date": date,
                "project_id": (item.get("project_id") or "").strip(),
                "project_name": item.get("project_name") or "",
                "task_id": (item.get("task_id") or "").strip(),
                "task_guid": (item.get("task_guid") or "").strip(),
                "task_name": item.get("task_name") or "",
                "seconds": seconds,
                "hours_worked": hours_val,
                "description": item.get("description") or "",
                "status": "Pending",
                "submitted_at": _now_iso(),
                "decided_at": None,
                "decided_by": None,
                "reject_comment": "",
            }
            entries.append(rec)
            created.append(rec)

        if not created:
            return jsonify({"success": False, "error": "No valid entries to submit"}), 400

        _write_ts_entries(entries)
        return jsonify({"success": True, "items": created, "count": len(created)}), 201
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@bp_time.route("/time-tracker/timesheet/submissions", methods=["GET"])
def list_timesheet_submissions():
    """List timesheet submissions for admin or employee inbox.

    Query params:
      - employee_id: filter by employee (optional)
      - status: pending|accepted|rejected|all (optional, default all)
    """
    try:
        employee_id = (request.args.get("employee_id") or "").strip()
        status = (request.args.get("status") or "").strip().lower()

        entries = _read_ts_entries()
        out = []
        for rec in entries:
            if employee_id and str(rec.get("employee_id") or "").strip().upper() != employee_id.upper():
                continue
            if status and status != "all":
                s = str(rec.get("status") or "").strip().lower()
                if status == "pending" and s != "pending":
                    continue
                if status == "accepted" and s != "accepted":
                    continue
                if status == "rejected" and s != "rejected":
                    continue
            out.append(rec)

        try:
            out.sort(key=lambda r: r.get("submitted_at") or "", reverse=True)
        except Exception:
            pass

        return jsonify({"success": True, "items": out}), 200
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@bp_time.route("/time-tracker/timesheet/<entry_id>/approve", methods=["POST"])
def approve_timesheet(entry_id):
    """Approve a pending timesheet submission."""
    try:
        body = request.get_json(force=True) or {}
        decided_by = (body.get("decided_by") or "").strip()
        updated, _entries = _update_timesheet_status(entry_id, "Accepted", comment=None, decided_by=decided_by)
        if not updated:
            return jsonify({"success": False, "error": "Entry not found"}), 404
        return jsonify({"success": True, "item": updated}), 200
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@bp_time.route("/time-tracker/timesheet/<entry_id>/reject", methods=["POST"])
def reject_timesheet(entry_id):
    """Reject a pending timesheet submission with optional comment."""
    try:
        body = request.get_json(force=True) or {}
        decided_by = (body.get("decided_by") or "").strip()
        comment = body.get("comment")
        updated, _entries = _update_timesheet_status(entry_id, "Rejected", comment=comment, decided_by=decided_by)
        if not updated:
            return jsonify({"success": False, "error": "Entry not found"}), 404
        return jsonify({"success": True, "item": updated}), 200
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500
