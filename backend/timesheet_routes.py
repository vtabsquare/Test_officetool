"""
Timesheet/Time Tracker API Routes
Handles task time logging and timesheet data retrieval
"""
from flask import request, jsonify
import requests
from datetime import datetime, timedelta

def register_timesheet_routes(app, get_access_token, RESOURCE, TIMESHEET_ENTITY, _apply_timesheet_rpt, create_record):
    """Register timesheet-related routes"""
    
    @app.route("/api/time-tracker/task-log", methods=["POST"])
    def save_task_log():
        """
        Save or update task time log entry.
        Called when user pauses/stops a task timer in My Tasks page.
        """
        try:
            data = request.get_json(force=True) or {}
            
            employee_id = (data.get("employee_id") or "").strip()
            project_id = (data.get("project_id") or "").strip()
            task_guid = (data.get("task_guid") or "").strip()
            task_id = (data.get("task_id") or "").strip()
            task_name = (data.get("task_name") or "").strip()
            seconds = int(data.get("seconds", 0))
            work_date = (data.get("work_date") or datetime.now().strftime("%Y-%m-%d")).strip()
            description = (data.get("description") or "").strip()
            
            if not employee_id:
                return jsonify({"success": False, "error": "employee_id is required"}), 400
            if not task_guid:
                return jsonify({"success": False, "error": "task_guid is required"}), 400
            if seconds <= 0:
                return jsonify({"success": False, "error": "seconds must be positive"}), 400
            
            print(f"[TIMESHEET] Saving task log: {employee_id} | {task_id} | {seconds}s on {work_date}")
            
            token = get_access_token()
            headers = {
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "OData-MaxVersion": "4.0",
                "OData-Version": "4.0",
            }
            
            # Check if a log entry already exists for this employee/task/date
            safe_emp = employee_id.replace("'", "''")
            safe_guid = task_guid.replace("'", "''")
            safe_date = work_date.replace("'", "''")
            
            filter_query = f"crc6f_employeeid eq '{safe_emp}' and crc6f_taskguid eq '{safe_guid}' and crc6f_workdate eq '{safe_date}'"
            check_url = f"{RESOURCE}/api/data/v9.2/{TIMESHEET_ENTITY}?$filter={filter_query}&$top=1"
            
            check_resp = requests.get(check_url, headers=headers)
            existing_records = []
            if check_resp.status_code == 200:
                existing_records = check_resp.json().get("value", [])
            
            if existing_records:
                # Update existing record
                record_id = existing_records[0].get("crc6f_hr_timesheetid")
                if record_id:
                    update_payload = {
                        "crc6f_seconds": str(seconds),
                        "crc6f_hours": str(round(seconds / 3600, 2))
                    }
                    if description:
                        update_payload["crc6f_description"] = description
                    
                    _apply_timesheet_rpt(update_payload)
                    
                    update_url = f"{RESOURCE}/api/data/v9.2/{TIMESHEET_ENTITY}({record_id})"
                    update_resp = requests.patch(update_url, headers=headers, json=update_payload)
                    
                    if update_resp.status_code in [200, 204]:
                        print(f"[TIMESHEET] Updated existing log: {record_id}")
                        return jsonify({"success": True, "action": "updated", "record_id": record_id}), 200
                    else:
                        print(f"[TIMESHEET] Update failed: {update_resp.status_code} - {update_resp.text}")
                        return jsonify({"success": False, "error": f"Update failed: {update_resp.text}"}), update_resp.status_code
            
            # Create new record
            payload = {
                "crc6f_employeeid": employee_id,
                "crc6f_projectid": project_id,
                "crc6f_taskguid": task_guid,
                "crc6f_taskid": task_id,
                "crc6f_taskname": task_name,
                "crc6f_seconds": str(seconds),
                "crc6f_hours": str(round(seconds / 3600, 2)),
                "crc6f_workdate": work_date,
                "crc6f_description": description,
                "crc6f_billing": "Non-billable"
            }
            
            _apply_timesheet_rpt(payload)
            
            created = create_record(TIMESHEET_ENTITY, payload)
            print(f"[TIMESHEET] Created new log entry")
            
            return jsonify({"success": True, "action": "created", "log": created}), 201
            
        except Exception as e:
            print(f"[TIMESHEET] Error saving task log: {e}")
            import traceback
            traceback.print_exc()
            return jsonify({"success": False, "error": str(e)}), 500
    
    
    @app.route("/api/time-tracker/logs", methods=["GET"])
    def get_timesheet_logs():
        """
        Retrieve timesheet logs for an employee within a date range.
        Query params: employee_id, start_date, end_date
        """
        try:
            employee_id = (request.args.get("employee_id") or "").strip()
            start_date = (request.args.get("start_date") or "").strip()
            end_date = (request.args.get("end_date") or "").strip()
            
            if not employee_id:
                return jsonify({"success": False, "error": "employee_id is required"}), 400
            
            # Default to current week if dates not provided
            if not start_date or not end_date:
                today = datetime.now()
                start_of_week = today - timedelta(days=today.weekday())
                end_of_week = start_of_week + timedelta(days=6)
                start_date = start_of_week.strftime("%Y-%m-%d")
                end_date = end_of_week.strftime("%Y-%m-%d")
            
            print(f"[TIMESHEET] Fetching logs: {employee_id} from {start_date} to {end_date}")
            
            token = get_access_token()
            headers = {
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "OData-MaxVersion": "4.0",
                "OData-Version": "4.0",
            }
            
            # Handle special case for fetching all employees' logs (for team timesheet)
            if employee_id.upper() == "ALL":
                filter_query = f"crc6f_workdate ge '{start_date}' and crc6f_workdate le '{end_date}'"
            else:
                safe_emp = employee_id.replace("'", "''")
                filter_query = f"crc6f_employeeid eq '{safe_emp}' and crc6f_workdate ge '{start_date}' and crc6f_workdate le '{end_date}'"
            
            select_fields = "$select=crc6f_employeeid,crc6f_projectid,crc6f_taskguid,crc6f_taskid,crc6f_taskname,crc6f_seconds,crc6f_hours,crc6f_workdate,crc6f_description,crc6f_billing,crc6f_hr_timesheetid"
            url = f"{RESOURCE}/api/data/v9.2/{TIMESHEET_ENTITY}?$filter={filter_query}&{select_fields}&$top=5000&$orderby=crc6f_workdate desc"
            
            resp = requests.get(url, headers=headers)
            
            if resp.status_code != 200:
                print(f"[TIMESHEET] Fetch failed: {resp.status_code} - {resp.text}")
                return jsonify({"success": False, "error": resp.text}), resp.status_code
            
            records = resp.json().get("value", [])
            
            # Format logs for frontend
            logs = []
            for r in records:
                logs.append({
                    "employee_id": r.get("crc6f_employeeid"),
                    "project_id": r.get("crc6f_projectid"),
                    "task_guid": r.get("crc6f_taskguid"),
                    "task_id": r.get("crc6f_taskid"),
                    "task_name": r.get("crc6f_taskname"),
                    "seconds": int(r.get("crc6f_seconds", 0)),
                    "hours": float(r.get("crc6f_hours", 0)),
                    "work_date": r.get("crc6f_workdate"),
                    "description": r.get("crc6f_description"),
                    "billing": r.get("crc6f_billing"),
                    "record_id": r.get("crc6f_hr_timesheetid")
                })
            
            print(f"[TIMESHEET] Found {len(logs)} log entries")
            return jsonify({"success": True, "logs": logs}), 200
            
        except Exception as e:
            print(f"[TIMESHEET] Error fetching logs: {e}")
            import traceback
            traceback.print_exc()
            return jsonify({"success": False, "error": str(e)}), 500
