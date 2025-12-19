# ai_automation.py - Conversational automation for HR tasks
"""
This module handles multi-step conversational flows for automating HR tasks
like creating employees, applying for leave, etc.
"""
import json
import re
import os
from typing import Dict, Any, Optional, List, Tuple
from datetime import datetime

# Backend API base URLs
# - BACKEND_API_URL: public URL (used by frontend or external callers)
# - BACKEND_API_INTERNAL_URL: internal URL for server-to-server calls
BACKEND_API_URL = os.getenv("BACKEND_API_URL", "https://vtab-office-tool.onrender.com").rstrip("/")
BACKEND_API_INTERNAL_URL = os.getenv("BACKEND_API_INTERNAL_URL") or os.getenv("BACKEND_INTERNAL_URL")
if BACKEND_API_INTERNAL_URL:
    BACKEND_API_INTERNAL_URL = BACKEND_API_INTERNAL_URL.rstrip("/")
else:
    # Default to local loopback so the backend can call its own API without going over the public internet
    BACKEND_API_INTERNAL_URL = "http://127.0.0.1:5000"

# ================== AI DATAVERSE TABLE ACCESS ==================
# All Dataverse tables the AI has access to for querying and automation
AI_DATAVERSE_TABLES = {
    # Employee Management
    "employees": {
        "entity": "crc6f_table12s",
        "description": "Employee master table with all employee records",
        "key_fields": ["crc6f_employeeid", "crc6f_firstname", "crc6f_lastname", "crc6f_email", "crc6f_department", "crc6f_designation"]
    },
    # Attendance Tracking
    "attendance": {
        "entity": "crc6f_table13s",
        "description": "Daily attendance records with check-in/check-out times",
        "key_fields": ["crc6f_employeeid", "crc6f_date", "crc6f_checkin", "crc6f_checkout", "crc6f_duration"]
    },
    # Leave Management
    "leave_requests": {
        "entity": "crc6f_table14s",
        "description": "Leave requests submitted by employees",
        "key_fields": ["crc6f_employeeid", "crc6f_leavetype", "crc6f_startdate", "crc6f_enddate", "crc6f_status"]
    },
    "leave_balance": {
        "entity": "crc6f_hr_leavemangements",
        "description": "Leave balance/quota for each employee",
        "key_fields": ["crc6f_employeeid", "crc6f_leavetype", "crc6f_balance"]
    },
    # Project Management
    "projects": {
        "entity": "crc6f_hr_projectheaders",
        "description": "Project headers with project details",
        "key_fields": ["crc6f_projectid", "crc6f_projectname", "crc6f_client", "crc6f_manager", "crc6f_projectstatus", "crc6f_startdate", "crc6f_enddate"]
    },
    "project_contributors": {
        "entity": "crc6f_hr_projectcontributorses",
        "description": "Links employees to projects they contribute to",
        "key_fields": ["crc6f_employeeid", "crc6f_projectid", "crc6f_hourlyrate"]
    },
    "project_boards": {
        "entity": "crc6f_hr_projectboardses",
        "description": "Kanban boards for projects",
        "key_fields": ["crc6f_boardid", "crc6f_projectid", "crc6f_boardname"]
    },
    # Task Management
    "tasks": {
        "entity": "crc6f_hr_taskdetailses",
        "description": "Task details assigned to employees within projects",
        "key_fields": ["crc6f_taskid", "crc6f_taskname", "crc6f_assignedto", "crc6f_projectid", "crc6f_taskstatus", "crc6f_duedate"]
    },
    # Asset Management
    "assets": {
        "entity": "crc6f_hr_assetdetailses",
        "description": "Company assets assigned to employees",
        "key_fields": ["crc6f_assetid", "crc6f_assetname", "crc6f_assignedto", "crc6f_assetstatus"]
    },
    # Client Management
    "clients": {
        "entity": "crc6f_hr_clients",
        "description": "Client/customer records",
        "key_fields": ["crc6f_clientid", "crc6f_clientname", "crc6f_contactemail"]
    },
    # Holiday Calendar
    "holidays": {
        "entity": "crc6f_hr_holidayses",
        "description": "Company holiday calendar",
        "key_fields": ["crc6f_holidaydate", "crc6f_holidayname"]
    },
    # Login/Activity Tracking
    "login_activity": {
        "entity": "crc6f_hr_login_detailses",
        "description": "Login events with location and device info",
        "key_fields": ["crc6f_employeeid", "crc6f_eventtype", "crc6f_timestamp", "crc6f_location"]
    },
    # Hierarchy/Reporting
    "hierarchy": {
        "entity": "crc6f_hr_hierarchies",
        "description": "Employee reporting hierarchy (manager relationships)",
        "key_fields": ["crc6f_employeeid", "crc6f_managerid"]
    },
    # Intern Management
    "interns": {
        "entity": "crc6f_hr_interndetailses",
        "description": "Intern training and probation details",
        "key_fields": ["crc6f_internid", "crc6f_employeeid", "crc6f_paidtrainingstart", "crc6f_probationstart"]
    }
}

def get_ai_table_entity(table_name: str) -> str:
    """Get the Dataverse entity name for an AI-accessible table."""
    table_info = AI_DATAVERSE_TABLES.get(table_name.lower())
    if table_info:
        return table_info["entity"]
    return None

def list_ai_accessible_tables() -> List[str]:
    """List all tables the AI can access."""
    return list(AI_DATAVERSE_TABLES.keys())

# ================== EMPLOYEE CREATION FLOW ==================

EMPLOYEE_FIELDS = [
    {
        "key": "first_name",
        "label": "First Name",
        "prompt": "What is the employee's **first name**?",
        "required": True,
        "validate": lambda x: len(x.strip()) >= 2,
        "error": "First name must be at least 2 characters."
    },
    {
        "key": "last_name",
        "label": "Last Name",
        "prompt": "What is the employee's **last name**?",
        "required": True,
        "validate": lambda x: len(x.strip()) >= 1,
        "error": "Last name is required."
    },
    {
        "key": "email",
        "label": "Email",
        "prompt": "What is the employee's **email address**?",
        "required": True,
        "validate": lambda x: re.match(r'^[\w\.-]+@[\w\.-]+\.\w+$', x.strip()) is not None,
        "error": "Please provide a valid email address (e.g., john@company.com)."
    },
    {
        "key": "designation",
        "label": "Designation/Role",
        "prompt": "What is the employee's **designation/role**? (e.g., Software Engineer, HR Manager, Data Analyst)",
        "required": True,
        "validate": lambda x: len(x.strip()) >= 2,
        "error": "Designation must be at least 2 characters."
    },
    {
        "key": "contact_number",
        "label": "Contact Number",
        "prompt": "What is the employee's **contact/mobile number**? (You can type 'skip' to leave blank)",
        "required": False,
        "validate": lambda x: x.lower() == 'skip' or re.match(r'^[\d\s\-\+\(\)]{7,15}$', x.strip()) is not None,
        "error": "Please provide a valid phone number or type 'skip'."
    },
    {
        "key": "doj",
        "label": "Date of Joining",
        "prompt": "What is the **date of joining**? (Format: YYYY-MM-DD, e.g., 2025-01-15, or type 'today' for today's date)",
        "required": True,
        "validate": lambda x: _validate_date(x),
        "error": "Please provide a valid date in YYYY-MM-DD format or type 'today'."
    },
    {
        "key": "employee_flag",
        "label": "Employee Type",
        "prompt": "Is this an **Employee** or **Intern**? (Type 'employee' or 'intern')",
        "required": True,
        "validate": lambda x: x.strip().lower() in ['employee', 'intern'],
        "error": "Please type either 'employee' or 'intern'."
    }
]


def _validate_date(value: str) -> bool:
    """Validate date input."""
    value = value.strip().lower()
    if value == 'today':
        return True
    try:
        datetime.strptime(value, '%Y-%m-%d')
        return True
    except ValueError:
        return False


def _normalize_date(value: str) -> str:
    """Normalize date input to YYYY-MM-DD format."""
    value = value.strip().lower()
    if value == 'today':
        return datetime.now().strftime('%Y-%m-%d')
    return value.strip()


def _normalize_value(key: str, value: str) -> Any:
    """Normalize field values."""
    value = value.strip()
    
    if key == 'doj':
        return _normalize_date(value)
    elif key == 'contact_number':
        if value.lower() == 'skip':
            return ''
        return value
    elif key == 'employee_flag':
        return value.capitalize()  # 'Employee' or 'Intern'
    elif key == 'email':
        return value.lower()
    
    return value


# ================== LEAVE APPLICATION FLOW ==================

LEAVE_TYPE_OPTIONS = ["Casual Leave", "Sick Leave", "Comp Off"]
COMPENSATION_OPTIONS = ["Paid", "Unpaid"]

LEAVE_FIELDS = [
    {
        "key": "leave_type",
        "label": "Leave Type",
        "prompt": "Which **leave type** would you like to apply for?\n\n**1.** Casual Leave\n**2.** Sick Leave\n**3.** Comp Off\n\n_(Type the number or name)_",
        "required": True,
        "options": LEAVE_TYPE_OPTIONS,
        "validate": lambda x: _validate_leave_option(x, LEAVE_TYPE_OPTIONS),
        "error": "Please select a valid leave type: type **1**, **2**, **3** or the leave name (Casual Leave, Sick Leave, Comp Off)."
    },
    {
        "key": "compensation",
        "label": "Compensation Type",
        "prompt": "Should this leave be **Paid** or **Unpaid**?\n\n**1.** Paid\n**2.** Unpaid\n\n_(Type the number or name)_",
        "required": True,
        "options": COMPENSATION_OPTIONS,
        "validate": lambda x: _validate_leave_option(x, COMPENSATION_OPTIONS),
        "error": "Please select: type **1** for Paid or **2** for Unpaid."
    },
    {
        "key": "start_date",
        "label": "Start Date",
        "prompt": "What is the **start date** of your leave? (Format: YYYY-MM-DD, e.g., 2025-01-15, or type 'today' or 'tomorrow')",
        "required": True,
        "validate": lambda x: _validate_leave_date(x),
        "error": "Please provide a valid date in YYYY-MM-DD format, or type 'today' or 'tomorrow'."
    },
    {
        "key": "end_date",
        "label": "End Date",
        "prompt": "What is the **end date** of your leave? (Format: YYYY-MM-DD, or type 'same' for single day leave)",
        "required": True,
        "validate": lambda x: _validate_leave_date(x, allow_same=True),
        "error": "Please provide a valid date in YYYY-MM-DD format, or type 'same' for single day leave."
    },
    {
        "key": "reason",
        "label": "Reason",
        "prompt": "Please provide a brief **reason** for your leave request:",
        "required": True,
        "validate": lambda x: len(x.strip()) >= 3,
        "error": "Please provide a reason (at least 3 characters)."
    }
]


def _validate_leave_option(value: str, options: List[str]) -> bool:
    """Validate option selection by number or name."""
    value = value.strip().lower()
    # Check if it's a number
    if value.isdigit():
        idx = int(value) - 1
        return 0 <= idx < len(options)
    # Check if it matches an option name
    for opt in options:
        if value == opt.lower() or value in opt.lower():
            return True
    return False


def _normalize_leave_option(value: str, options: List[str]) -> str:
    """Normalize option selection to the canonical option name."""
    value = value.strip().lower()
    # Check if it's a number
    if value.isdigit():
        idx = int(value) - 1
        if 0 <= idx < len(options):
            return options[idx]
    # Check if it matches an option name
    for opt in options:
        if value == opt.lower() or value in opt.lower():
            return opt
    return value


def _validate_leave_date(value: str, allow_same: bool = False) -> bool:
    """Validate leave date input."""
    value = value.strip().lower()
    if value in ['today', 'tomorrow']:
        return True
    if allow_same and value == 'same':
        return True
    try:
        datetime.strptime(value, '%Y-%m-%d')
        return True
    except ValueError:
        return False


def _normalize_leave_date(value: str, reference_date: str = None) -> str:
    """Normalize leave date input to YYYY-MM-DD format."""
    from datetime import timedelta
    value = value.strip().lower()
    if value == 'today':
        return datetime.now().strftime('%Y-%m-%d')
    if value == 'tomorrow':
        return (datetime.now() + timedelta(days=1)).strftime('%Y-%m-%d')
    if value == 'same' and reference_date:
        return reference_date
    return value.strip()


def _normalize_leave_value(key: str, value: str, collected_data: Dict[str, Any] = None) -> Any:
    """Normalize leave field values."""
    value = value.strip()
    
    if key == 'leave_type':
        return _normalize_leave_option(value, LEAVE_TYPE_OPTIONS)
    elif key == 'compensation':
        return _normalize_leave_option(value, COMPENSATION_OPTIONS)
    elif key == 'start_date':
        return _normalize_leave_date(value)
    elif key == 'end_date':
        start_date = collected_data.get('start_date') if collected_data else None
        return _normalize_leave_date(value, start_date)
    
    return value


# ================== ASSET CREATION FLOW ==================

ASSET_CATEGORY_OPTIONS = ["Laptop", "Monitor", "Charger", "Keyboard", "Headset", "Accessory"]
ASSET_STATUS_OPTIONS = ["In Use", "Not Use", "Repair"]

ASSET_FIELDS = [
    {
        "key": "asset_name",
        "label": "Asset Name",
        "prompt": "What is the **asset name**? (e.g., Dell Laptop, HP Monitor)",
        "required": True,
        "validate": lambda x: len(x.strip()) >= 2,
        "error": "Asset name must be at least 2 characters."
    },
    {
        "key": "serial_number",
        "label": "Serial Number",
        "prompt": "What is the **serial number**? (e.g., SN123456789)",
        "required": True,
        "validate": lambda x: len(x.strip()) >= 3,
        "error": "Serial number must be at least 3 characters."
    },
    {
        "key": "category",
        "label": "Category",
        "prompt": "Please select the **asset category** from the options below:\n\n📱 **1.** Laptop\n🖥️ **2.** Monitor\n🔌 **3.** Charger\n⌨️ **4.** Keyboard\n🎧 **5.** Headset\n🔧 **6.** Accessory\n\n_(Just type the number 1-6 or the category name)_",
        "required": True,
        "options": ASSET_CATEGORY_OPTIONS,
        "validate": lambda x: _validate_asset_option(x, ASSET_CATEGORY_OPTIONS),
        "error": "❌ Invalid selection. Please type a number **1-6** or the category name (Laptop, Monitor, Charger, Keyboard, Headset, Accessory)."
    },
    {
        "key": "location",
        "label": "Location",
        "prompt": "What is the **location** of this asset? (e.g., Office Building A, Floor 2)",
        "required": True,
        "validate": lambda x: len(x.strip()) >= 2,
        "error": "Location must be at least 2 characters."
    },
    {
        "key": "status",
        "label": "Status",
        "prompt": "Please select the **asset status**:\n\n✅ **1.** In Use\n⏸️ **2.** Not Use\n🔧 **3.** Repair\n\n_(Just type the number 1-3 or the status name)_",
        "required": True,
        "options": ASSET_STATUS_OPTIONS,
        "validate": lambda x: _validate_asset_option(x, ASSET_STATUS_OPTIONS),
        "error": "❌ Invalid selection. Please type **1**, **2**, **3** or the status name (In Use, Not Use, Repair)."
    },
    {
        "key": "assigned_to",
        "label": "Assigned To",
        "prompt": "Who is this asset **assigned to**? (Employee name, or type 'skip' if not assigned)",
        "required": False,
        "validate": lambda x: True,  # Optional field
        "error": ""
    },
    {
        "key": "employee_id",
        "label": "Employee ID",
        "prompt": "What is the **Employee ID** of the person this is assigned to? (e.g., EMP001, or type 'skip' if not assigned)",
        "required": False,
        "validate": lambda x: True,  # Optional field
        "error": ""
    },
    {
        "key": "assigned_on",
        "label": "Assigned On",
        "prompt": "When was this asset **assigned**? (Format: YYYY-MM-DD, or type 'today' or 'skip')",
        "required": False,
        "validate": lambda x: _validate_asset_date(x),
        "error": "Please provide a valid date in YYYY-MM-DD format, or type 'today' or 'skip'."
    }
]


def _validate_asset_option(value: str, options: List[str]) -> bool:
    """Validate option selection by number or name for assets."""
    value = value.strip().lower()
    # Check if it's a number
    if value.isdigit():
        idx = int(value) - 1
        return 0 <= idx < len(options)
    # Check if it matches an option name
    for opt in options:
        if value == opt.lower() or value in opt.lower():
            return True
    return False


def _normalize_asset_option(value: str, options: List[str]) -> str:
    """Normalize option selection to the canonical option name for assets."""
    value = value.strip().lower()
    # Check if it's a number
    if value.isdigit():
        idx = int(value) - 1
        if 0 <= idx < len(options):
            return options[idx]
    # Check if it matches an option name
    for opt in options:
        if value == opt.lower() or value in opt.lower():
            return opt
    return value


def _validate_asset_date(value: str) -> bool:
    """Validate asset date input."""
    value = value.strip().lower()
    if value in ['today', 'skip', '']:
        return True
    try:
        datetime.strptime(value, '%Y-%m-%d')
        return True
    except ValueError:
        return False


def _normalize_asset_date(value: str) -> str:
    """Normalize asset date input to YYYY-MM-DD format."""
    value = value.strip().lower()
    if value == 'today':
        return datetime.now().strftime('%Y-%m-%d')
    if value in ['skip', '']:
        return ''
    return value.strip()


def _normalize_asset_value(key: str, value: str) -> Any:
    """Normalize asset field values."""
    value = value.strip()
    
    if key == 'category':
        return _normalize_asset_option(value, ASSET_CATEGORY_OPTIONS)
    elif key == 'status':
        return _normalize_asset_option(value, ASSET_STATUS_OPTIONS)
    elif key == 'assigned_on':
        return _normalize_asset_date(value)
    elif key in ['assigned_to', 'employee_id']:
        if value.lower() == 'skip':
            return ''
        return value
    
    return value


# ================== INTENT DETECTION ==================

AUTOMATION_INTENTS = {
    "create_employee": {
        "keywords": [
            "create employee", "add employee", "new employee", "hire employee",
            "create an employee", "add an employee", "add new employee",
            "onboard employee", "register employee", "employee creation",
            "create a new employee", "add a new employee"
        ],
        "flow": "employee_creation",
        "description": "Create a new employee record"
    },
    "create_asset": {
        "keywords": [
            "add new asset", "create asset", "new asset", "add asset",
            "create an asset", "add an asset", "register asset",
            "asset creation", "create a new asset", "add a new asset",
            "ass new asset"  # Handle typo from user request
        ],
        "flow": "asset_creation",
        "description": "Create a new asset record"
    },
    "edit_employee": {
        "keywords": [
            "edit employee", "update employee", "modify employee", "change employee",
            "edit an employee", "update an employee", "edit employee record",
            "update employee record", "modify employee record", "change employee details",
            "edit employee details", "update employee details"
        ],
        "flow": "employee_edit",
        "description": "Edit/update an existing employee record"
    },
    "delete_employee": {
        "keywords": [
            "delete employee", "remove employee", "delete an employee", "remove an employee",
            "delete employee record", "remove employee record", "terminate employee",
            "delete staff", "remove staff"
        ],
        "flow": "employee_delete",
        "description": "Delete an existing employee record"
    },
    "apply_leave": {
        "keywords": [
            "apply leave", "apply for leave", "request leave", "take leave",
            "apply leave for me", "i want to apply leave", "i need leave",
            "leave application", "apply for a leave", "submit leave",
            "book leave", "request time off", "apply for time off",
            "i want leave", "need to take leave", "want to take leave"
        ],
        "flow": "leave_application",
        "description": "Apply for leave"
    },
    "check_in": {
        "keywords": [
            "check in", "check-in", "checkin", "start my day",
            "punch in", "clock in", "check in for me", "start work"
        ],
        "flow": "check_in",
        "description": "Check in / start attendance timer"
    },
    "check_out": {
        "keywords": [
            "check out", "checkout", "check-out", "punch out",
            "clock out", "end my day", "check out for me",
            "stop work", "end shift"
        ],
        "flow": "check_out",
        "description": "Check out / stop attendance timer"
    },
    "start_task": {
        "keywords": [
            "start my task", "start task", "start a task", "begin task",
            "start working on task", "show my tasks", "list my tasks",
            "my tasks", "work on task", "resume task", "play task"
        ],
        "flow": "task_start",
        "description": "Start/resume a task timer"
    },
    "stop_task": {
        "keywords": [
            "stop my task", "stop task", "pause task", "end task",
            "stop working on task", "pause my task", "stop the task",
            "stop current task", "pause current task"
        ],
        "flow": "task_stop",
        "description": "Stop/pause the currently running task timer"
    },
}


def detect_automation_intent(message: str) -> Optional[Dict[str, Any]]:
    """
    Detect if the user message triggers an automation flow.
    Returns the intent config if matched, None otherwise.
    """
    message_lower = message.lower().strip()
    
    for intent_key, intent_config in AUTOMATION_INTENTS.items():
        for keyword in intent_config["keywords"]:
            if keyword in message_lower:
                return {
                    "intent": intent_key,
                    "flow": intent_config["flow"],
                    "description": intent_config["description"]
                }
    
    return None


# ================== CONVERSATION STATE MANAGEMENT ==================

class ConversationState:
    """Manages the state of a multi-step conversation flow."""
    
    def __init__(self):
        self.active_flow: Optional[str] = None
        self.current_step: int = 0
        self.collected_data: Dict[str, Any] = {}
        self.awaiting_confirmation: bool = False
        self.edit_target: Optional[Dict[str, Any]] = None  # For edit flows: stores the employee being edited
        self.edit_field: Optional[str] = None  # Current field being edited
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "active_flow": self.active_flow,
            "current_step": self.current_step,
            "collected_data": self.collected_data,
            "awaiting_confirmation": self.awaiting_confirmation,
            "edit_target": self.edit_target,
            "edit_field": self.edit_field
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'ConversationState':
        state = cls()
        state.active_flow = data.get("active_flow")
        state.current_step = data.get("current_step", 0)
        state.collected_data = data.get("collected_data", {})
        state.awaiting_confirmation = data.get("awaiting_confirmation", False)
        state.edit_target = data.get("edit_target")
        state.edit_field = data.get("edit_field")
        return state
    
    def reset(self):
        self.active_flow = None
        self.current_step = 0
        self.collected_data = {}
        self.awaiting_confirmation = False
        self.edit_target = None
        self.edit_field = None


# ================== EDITABLE FIELDS FOR UPDATE ==================

EDITABLE_FIELDS = [
    {"key": "first_name", "label": "First Name", "number": "1"},
    {"key": "last_name", "label": "Last Name", "number": "2"},
    {"key": "email", "label": "Email", "number": "3"},
    {"key": "designation", "label": "Designation", "number": "4"},
    {"key": "contact_number", "label": "Contact Number", "number": "5"},
    {"key": "doj", "label": "Date of Joining", "number": "6"},
    {"key": "employee_flag", "label": "Employee Type", "number": "7"},
]


# ================== FLOW HANDLERS ==================

def handle_employee_creation_flow(
    user_message: str,
    state: ConversationState
) -> Tuple[str, ConversationState, Optional[Dict[str, Any]]]:
    """
    Handle the employee creation conversation flow.
    
    Returns:
        - response: The AI response message
        - state: Updated conversation state
        - action: Optional action to execute (e.g., {"type": "create_employee", "data": {...}})
    """
    
    # Starting the flow
    if state.active_flow != "employee_creation":
        state.active_flow = "employee_creation"
        state.current_step = 0
        state.collected_data = {}
        state.awaiting_confirmation = False
        
        # Return the first question
        first_field = EMPLOYEE_FIELDS[0]
        response = f"""Great! I'll help you create a new employee record. 📝

I'll need to collect some information. You can type **'cancel'** at any time to stop.

**Step 1 of {len(EMPLOYEE_FIELDS)}:** {first_field['prompt']}"""
        return response, state, None
    
    # Check for cancel
    if user_message.strip().lower() in ['cancel', 'stop', 'quit', 'exit', 'nevermind']:
        state.reset()
        return "No problem! Employee creation cancelled. Let me know if you need anything else. 👋", state, None
    
    # Handle confirmation step
    if state.awaiting_confirmation:
        answer = user_message.strip().lower()
        if answer in ['yes', 'y', 'confirm', 'create', 'ok', 'proceed']:
            # Execute the creation
            action = {
                "type": "create_employee",
                "data": state.collected_data.copy()
            }
            state.reset()
            return "✅ Creating the employee record now...", state, action
        elif answer in ['no', 'n', 'cancel', 'edit', 'change']:
            state.awaiting_confirmation = False
            state.current_step = 0
            state.collected_data = {}
            return f"""Okay, let's start over.

**Step 1 of {len(EMPLOYEE_FIELDS)}:** {EMPLOYEE_FIELDS[0]['prompt']}""", state, None
        else:
            return "Please type **'yes'** to confirm and create the employee, or **'no'** to start over.", state, None
    
    # Collecting field data
    current_field = EMPLOYEE_FIELDS[state.current_step]
    
    # Validate the input
    if not current_field['validate'](user_message):
        return f"❌ {current_field['error']}\n\n{current_field['prompt']}", state, None
    
    # Store the normalized value
    normalized_value = _normalize_value(current_field['key'], user_message)
    state.collected_data[current_field['key']] = normalized_value
    
    # Move to next step
    state.current_step += 1
    
    # Check if we've collected all fields
    if state.current_step >= len(EMPLOYEE_FIELDS):
        # Show summary and ask for confirmation
        state.awaiting_confirmation = True
        
        summary = _build_employee_summary(state.collected_data)
        response = f"""Perfect! Here's the employee information I've collected:

{summary}

**Does this look correct?** Type **'yes'** to create the employee or **'no'** to start over."""
        return response, state, None
    
    # Ask for the next field
    next_field = EMPLOYEE_FIELDS[state.current_step]
    response = f"✓ Got it!\n\n**Step {state.current_step + 1} of {len(EMPLOYEE_FIELDS)}:** {next_field['prompt']}"
    return response, state, None


def _build_employee_summary(data: Dict[str, Any]) -> str:
    """Build a formatted summary of collected employee data."""
    lines = []
    
    field_labels = {f['key']: f['label'] for f in EMPLOYEE_FIELDS}
    
    for key, value in data.items():
        label = field_labels.get(key, key.replace('_', ' ').title())
        display_value = value if value else "(not provided)"
        lines.append(f"• **{label}:** {display_value}")
    
    return "\n".join(lines)


# ================== ASSET CREATION FLOW HANDLER ==================

def handle_asset_creation_flow(
    user_message: str,
    state: ConversationState
) -> Tuple[str, ConversationState, Optional[Dict[str, Any]]]:
    """
    Handle the asset creation conversation flow.
    
    Returns:
        - response: The AI response message
        - state: Updated conversation state
        - action: Optional action to execute (e.g., {"type": "create_asset", "data": {...}})
    """
    
    # Starting the flow
    if state.active_flow != "asset_creation":
        state.active_flow = "asset_creation"
        state.current_step = 0
        state.collected_data = {}
        state.awaiting_confirmation = False
        
        # Return the first question
        first_field = ASSET_FIELDS[0]
        response = f"""Great! I'll help you create a new asset record. 📦

I'll need to collect some information. You can type **'cancel'** at any time to stop.

**Step 1 of {len(ASSET_FIELDS)}:** {first_field['prompt']}"""
        return response, state, None
    
    # Check for cancel
    if user_message.strip().lower() in ['cancel', 'stop', 'quit', 'exit', 'nevermind']:
        state.reset()
        return "No problem! Asset creation cancelled. Let me know if you need anything else. 👋", state, None
    
    # Handle confirmation step
    if state.awaiting_confirmation:
        answer = user_message.strip().lower()
        if answer in ['yes', 'y', 'confirm', 'create', 'ok', 'proceed']:
            # Execute the creation
            action = {
                "type": "create_asset",
                "data": state.collected_data.copy()
            }
            state.reset()
            return "✅ Creating the asset record now...", state, action
        elif answer in ['no', 'n', 'cancel', 'edit', 'change']:
            state.awaiting_confirmation = False
            state.current_step = 0
            state.collected_data = {}
            return f"""Okay, let's start over.

**Step 1 of {len(ASSET_FIELDS)}:** {ASSET_FIELDS[0]['prompt']}""", state, None
        else:
            return "Please type **'yes'** to confirm and create the asset, or **'no'** to start over.", state, None
    
    # Collecting field data
    current_field = ASSET_FIELDS[state.current_step]
    
    # Validate the input
    if not current_field['validate'](user_message):
        return f"❌ {current_field['error']}\n\n{current_field['prompt']}", state, None
    
    # Store the normalized value
    normalized_value = _normalize_asset_value(current_field['key'], user_message)
    state.collected_data[current_field['key']] = normalized_value
    
    # Move to next step
    state.current_step += 1
    
    # Check if we've collected all fields
    if state.current_step >= len(ASSET_FIELDS):
        # Show summary and ask for confirmation
        state.awaiting_confirmation = True
        
        summary = _build_asset_summary(state.collected_data)
        response = f"""Perfect! Here's the asset information I've collected:

{summary}

**Does this look correct?** Type **'yes'** to create the asset or **'no'** to start over."""
        return response, state, None
    
    # Ask for the next field
    next_field = ASSET_FIELDS[state.current_step]
    response = f"✓ Got it!\n\n**Step {state.current_step + 1} of {len(ASSET_FIELDS)}:** {next_field['prompt']}"
    return response, state, None


def _build_asset_summary(data: Dict[str, Any]) -> str:
    """Build a formatted summary of collected asset data."""
    lines = []
    
    field_labels = {f['key']: f['label'] for f in ASSET_FIELDS}
    
    for key, value in data.items():
        label = field_labels.get(key, key.replace('_', ' ').title())
        display_value = value if value else "(not provided)"
        lines.append(f"• **{label}:** {display_value}")
    
    return "\n".join(lines)


# ================== EMPLOYEE EDIT FLOW ==================

def handle_employee_edit_flow(
    user_message: str,
    state: ConversationState
) -> Tuple[str, ConversationState, Optional[Dict[str, Any]]]:
    """
    Handle the employee edit/update conversation flow.
    
    Flow:
    1. Ask for employee ID or email to find the employee
    2. Show current details and ask which field to edit
    3. Get new value for the field
    4. Confirm and update
    """
    
    # Starting the flow - ask for employee identifier
    if state.active_flow != "employee_edit":
        state.active_flow = "employee_edit"
        state.current_step = 0
        state.collected_data = {}
        state.awaiting_confirmation = False
        state.edit_target = None
        state.edit_field = None
        
        response = """I'll help you edit an employee record. 📝

Please provide the **Employee ID** or **Email** of the employee you want to edit.

(Type **'cancel'** at any time to stop.)"""
        return response, state, None
    
    # Check for cancel
    if user_message.strip().lower() in ['cancel', 'stop', 'quit', 'exit', 'nevermind']:
        state.reset()
        return "No problem! Edit cancelled. Let me know if you need anything else. 👋", state, None
    
    # Handle confirmation FIRST (before other checks)
    if state.awaiting_confirmation:
        answer = user_message.strip().lower()
        if answer in ['yes', 'y', 'confirm', 'save', 'ok']:
            # Execute the update
            action = {
                "type": "update_employee",
                "employee_id": state.edit_target.get("employee_id"),
                "record_guid": state.edit_target.get("record_guid"),
                "updates": state.collected_data.get("updates", {})
            }
            state.reset()
            return "✅ Updating employee record...", state, action
        elif answer in ['no', 'n', 'cancel']:
            state.reset()
            return "Update cancelled. Let me know if you need anything else! 👋", state, None
        else:
            return "Please type **'yes'** to confirm the update, or **'no'** to cancel.", state, None
    
    # Step 0: Looking up the employee
    if state.current_step == 0 and state.edit_target is None:
        # User provided employee ID or email - we need to look them up
        # Store the search term and signal that we need to look up
        search_term = user_message.strip()
        state.collected_data["search_term"] = search_term
        state.current_step = 1
        
        # Return action to search for employee
        action = {
            "type": "search_employee",
            "search_term": search_term
        }
        return "🔍 Searching for employee...", state, action
    
    # Step 1: Employee found, show details and ask which field to edit
    if state.current_step == 1 and state.edit_target:
        # Check if user selected a field number or 'done'
        user_input = user_message.strip().lower()
        
        if user_input in ['done', 'finish', 'save', 'update', 'confirm']:
            if not state.collected_data.get("updates"):
                return "You haven't made any changes yet. Please select a field number to edit, or type **'cancel'** to exit.", state, None
            
            # Show summary and confirm
            state.awaiting_confirmation = True
            updates_summary = _build_updates_summary(state.collected_data.get("updates", {}))
            response = f"""Here are the changes you want to make:

{updates_summary}

**Confirm update?** Type **'yes'** to save changes or **'no'** to cancel."""
            return response, state, None
        
        # Check if it's a field number
        field_map = {f["number"]: f for f in EDITABLE_FIELDS}
        if user_input in field_map:
            field = field_map[user_input]
            state.edit_field = field["key"]
            state.current_step = 2
            
            current_value = state.edit_target.get(field["key"], "(not set)")
            response = f"""Editing **{field['label']}**

Current value: **{current_value}**

Enter the new value (or type **'skip'** to keep current):"""
            return response, state, None
        
        # Invalid input - show menu again
        return _build_edit_menu(state.edit_target), state, None
    
    # Step 2: Getting new value for a field
    if state.current_step == 2 and state.edit_field:
        user_input = user_message.strip()
        
        if user_input.lower() != 'skip':
            # Validate the input based on field type
            field_config = next((f for f in EMPLOYEE_FIELDS if f["key"] == state.edit_field), None)
            
            if field_config and not field_config.get("validate", lambda x: True)(user_input):
                return f"❌ {field_config.get('error', 'Invalid input')}. Please try again:", state, None
            
            # Store the update
            if "updates" not in state.collected_data:
                state.collected_data["updates"] = {}
            
            normalized = _normalize_value(state.edit_field, user_input)
            state.collected_data["updates"][state.edit_field] = normalized
        
        # Go back to field selection
        state.current_step = 1
        state.edit_field = None
        
        response = f"✓ Got it!\n\n{_build_edit_menu(state.edit_target, state.collected_data.get('updates', {}))}"
        return response, state, None
    
    # Fallback
    return "I didn't understand that. Please try again or type **'cancel'** to exit.", state, None


def _build_edit_menu(employee: Dict[str, Any], pending_updates: Dict[str, Any] = None) -> str:
    """Build the field selection menu for editing."""
    pending_updates = pending_updates or {}
    
    name = f"{employee.get('first_name', '')} {employee.get('last_name', '')}".strip()
    emp_id = employee.get('employee_id', 'Unknown')
    
    lines = [
        f"**Employee:** {name} ({emp_id})",
        "",
        "Select a field to edit (enter the number):",
        ""
    ]
    
    for field in EDITABLE_FIELDS:
        current = employee.get(field["key"], "(not set)")
        pending = pending_updates.get(field["key"])
        
        if pending:
            lines.append(f"**{field['number']}.** {field['label']}: ~~{current}~~ → **{pending}** ✏️")
        else:
            lines.append(f"**{field['number']}.** {field['label']}: {current}")
    
    lines.append("")
    lines.append("Type **'done'** when finished to save all changes.")
    
    return "\n".join(lines)


def _build_updates_summary(updates: Dict[str, Any]) -> str:
    """Build a summary of pending updates."""
    lines = []
    field_labels = {f["key"]: f["label"] for f in EDITABLE_FIELDS}
    
    for key, value in updates.items():
        label = field_labels.get(key, key.replace('_', ' ').title())
        lines.append(f"• **{label}:** {value}")
    
    return "\n".join(lines)


# ================== EMPLOYEE DELETE FLOW ==================

def handle_employee_delete_flow(
    user_message: str,
    state: ConversationState
) -> Tuple[str, ConversationState, Optional[Dict[str, Any]]]:
    """
    Handle the employee delete conversation flow.
    
    Flow:
    1. Ask for employee ID or email to find the employee
    2. Show employee details and ask for strong confirmation
    3. Delete the employee
    """
    
    # Starting the flow - ask for employee identifier
    if state.active_flow != "employee_delete":
        state.active_flow = "employee_delete"
        state.current_step = 0
        state.collected_data = {}
        state.awaiting_confirmation = False
        state.edit_target = None
        
        response = """⚠️ I'll help you delete an employee record. **This action cannot be undone.**

Please provide the **Employee ID** or **Email** of the employee you want to delete.

(Type **'cancel'** at any time to stop.)"""
        return response, state, None
    
    # Check for cancel
    if user_message.strip().lower() in ['cancel', 'stop', 'quit', 'exit', 'nevermind']:
        state.reset()
        return "No problem! Delete cancelled. Let me know if you need anything else. 👋", state, None
    
    # Handle confirmation FIRST (before other checks)
    if state.awaiting_confirmation:
        answer = user_message.strip()
        expected_confirm = state.collected_data.get("confirm_text", "")
        
        if answer == expected_confirm:
            # Execute the delete
            action = {
                "type": "delete_employee",
                "employee_id": state.edit_target.get("employee_id"),
                "record_guid": state.edit_target.get("record_guid"),
            }
            state.reset()
            return "🗑️ Deleting employee record...", state, action
        elif answer.lower() in ['no', 'n', 'cancel']:
            state.reset()
            return "Delete cancelled. The employee record was NOT deleted. 👋", state, None
        else:
            return f"To confirm deletion, please type exactly: **{expected_confirm}**\n\nOr type **'cancel'** to abort.", state, None
    
    # Step 0: Looking up the employee
    if state.current_step == 0 and state.edit_target is None:
        search_term = user_message.strip()
        state.collected_data["search_term"] = search_term
        state.current_step = 1
        
        # Return action to search for employee
        action = {
            "type": "search_employee_for_delete",
            "search_term": search_term
        }
        return "🔍 Searching for employee...", state, action
    
    # Step 1: Employee found, show details and ask for confirmation
    if state.current_step == 1 and state.edit_target:
        # Show employee details and ask for strong confirmation
        emp = state.edit_target
        emp_id = emp.get("employee_id", "Unknown")
        name = f"{emp.get('first_name', '')} {emp.get('last_name', '')}".strip()
        email = emp.get("email", "N/A")
        designation = emp.get("designation", "N/A")
        
        # Set the confirmation text
        confirm_text = f"DELETE {emp_id}"
        state.collected_data["confirm_text"] = confirm_text
        state.awaiting_confirmation = True
        
        response = f"""⚠️ **WARNING: You are about to delete this employee:**

• **Employee ID:** {emp_id}
• **Name:** {name}
• **Email:** {email}
• **Designation:** {designation}

**This action is permanent and cannot be undone.**

To confirm, type exactly: **{confirm_text}**

Or type **'cancel'** to abort."""
        return response, state, None
    
    # Fallback
    return "I didn't understand that. Please try again or type **'cancel'** to exit.", state, None


# ================== LEAVE APPLICATION FLOW HANDLER ==================

def _build_leave_summary(data: Dict[str, Any], employee_id: str = None) -> str:
    """Build a summary of the leave application for confirmation."""
    lines = [
        "📋 **Leave Application Summary**",
        "",
        f"• **Employee ID:** {employee_id or 'Will be auto-detected'}",
        f"• **Leave Type:** {data.get('leave_type', 'N/A')}",
        f"• **Compensation:** {data.get('compensation', 'N/A')}",
        f"• **Start Date:** {data.get('start_date', 'N/A')}",
        f"• **End Date:** {data.get('end_date', 'N/A')}",
        f"• **Reason:** {data.get('reason', 'N/A')}",
        "",
        "Is this correct? Type **'yes'** to submit or **'no'** to start over."
    ]
    return "\n".join(lines)


def handle_leave_application_flow(
    user_message: str,
    state: 'ConversationState',
    user_employee_id: str = None
) -> Tuple[str, 'ConversationState', Optional[Dict[str, Any]]]:
    """
    Handle the leave application conversation flow.
    
    Flow:
    1. Ask for leave type (dropdown: Casual Leave, Sick Leave, Comp Off)
    2. Ask for compensation type (dropdown: Paid, Unpaid)
    3. Ask for start date
    4. Ask for end date
    5. Ask for reason
    6. Show summary and confirm
    7. Submit leave application
    
    Args:
        user_message: The user's message
        state: Current conversation state
        user_employee_id: The logged-in user's employee ID (auto-fetched)
    
    Returns:
        Tuple of (response, updated_state, action_to_execute)
    """
    
    # Starting the flow
    if state.active_flow != "leave_application":
        state.active_flow = "leave_application"
        state.current_step = 0
        state.collected_data = {}
        state.awaiting_confirmation = False
        
        # Store the employee ID if provided
        if user_employee_id:
            state.collected_data["employee_id"] = user_employee_id
        
        # Ask for the first field (leave type)
        field = LEAVE_FIELDS[0]
        response = f"""🏖️ I'll help you apply for leave!

{field['prompt']}

_(Type **'cancel'** at any time to stop.)_"""
        return response, state, None
    
    # Check for cancel
    if user_message.strip().lower() in ['cancel', 'stop', 'quit', 'exit', 'nevermind']:
        state.reset()
        return "No problem! Leave application cancelled. Let me know if you need anything else. 👋", state, None
    
    # Handle confirmation
    if state.awaiting_confirmation:
        answer = user_message.strip().lower()
        if answer in ['yes', 'y', 'confirm', 'submit', 'ok']:
            # Submit the leave application
            action = {
                "type": "apply_leave",
                "data": state.collected_data
            }
            state.reset()
            return "📤 Submitting your leave application...", state, action
        elif answer in ['no', 'n', 'restart', 'start over']:
            state.current_step = 0
            state.collected_data = {"employee_id": state.collected_data.get("employee_id")}
            state.awaiting_confirmation = False
            field = LEAVE_FIELDS[0]
            return f"No problem, let's start over.\n\n{field['prompt']}", state, None
        else:
            return "Please type **'yes'** to submit or **'no'** to start over.", state, None
    
    # Process current field
    current_step = state.current_step
    if current_step < len(LEAVE_FIELDS):
        field = LEAVE_FIELDS[current_step]
        
        # Validate input
        if not field["validate"](user_message):
            return f"❌ {field['error']}\n\n{field['prompt']}", state, None
        
        # Normalize and store value
        normalized_value = _normalize_leave_value(field["key"], user_message, state.collected_data)
        state.collected_data[field["key"]] = normalized_value
        state.current_step += 1
        
        # Check if we have more fields
        if state.current_step < len(LEAVE_FIELDS):
            next_field = LEAVE_FIELDS[state.current_step]
            step_info = f"_(Step {state.current_step + 1} of {len(LEAVE_FIELDS)})_"
            return f"✅ Got it!\n\n{next_field['prompt']}\n\n{step_info}", state, None
        else:
            # All fields collected, show summary and ask for confirmation
            state.awaiting_confirmation = True
            employee_id = state.collected_data.get("employee_id", "Auto-detected from login")
            summary = _build_leave_summary(state.collected_data, employee_id)
            return f"✅ Great! Here's your leave application:\n\n{summary}", state, None
    
    # Fallback
    return "I didn't understand that. Please try again or type **'cancel'** to exit.", state, None


# ================== CHECK-IN/CHECK-OUT HANDLER ==================

def _handle_check_action(
    action_type: str,
    state: 'ConversationState',
    user_employee_id: str = None
) -> Tuple[str, 'ConversationState', Optional[Dict[str, Any]]]:
    """
    Handle check-in or check-out action.
    This is a single-step action - no multi-step flow needed.
    
    Args:
        action_type: 'check_in' or 'check_out'
        state: Current conversation state
        user_employee_id: The logged-in user's employee ID
    
    Returns:
        Tuple of (response, updated_state, action_to_execute)
    """
    # Reset any active flow since this is a one-shot action
    state.reset()
    
    if not user_employee_id:
        return "❌ I couldn't identify your employee ID. Please make sure you're logged in.", state, None
    
    if action_type == "check_in":
        action = {
            "type": "check_in",
            "employee_id": user_employee_id
        }
        return "⏰ Checking you in...", state, action
    elif action_type == "check_out":
        action = {
            "type": "check_out",
            "employee_id": user_employee_id
        }
        return "⏰ Checking you out...", state, action
    
    return "I didn't understand that action.", state, None


# ================== TASK START/STOP FLOW HANDLER ==================

def handle_task_start_flow(
    user_message: str,
    state: 'ConversationState',
    user_employee_id: str = None,
    user_employee_name: str = None,
    user_employee_email: str = None
) -> Tuple[str, 'ConversationState', Optional[Dict[str, Any]]]:
    """
    Handle the task start flow:
    1. Fetch user's tasks
    2. Display numbered list
    3. User selects a task number
    4. Start the timer for that task
    """
    # Check for cancel
    if user_message.strip().lower() in ['cancel', 'stop', 'quit', 'exit', 'nevermind']:
        state.reset()
        return "No problem! Task selection cancelled. Let me know if you need anything else. 👋", state, None
    
    # Starting the flow - fetch tasks and show list
    if state.active_flow != "task_start":
        state.active_flow = "task_start"
        state.current_step = 0
        state.collected_data = {}
        state.awaiting_confirmation = False
        
        # Return action to fetch tasks
        action = {
            "type": "fetch_my_tasks",
            "employee_id": user_employee_id,
            "employee_name": user_employee_name or "",
            "employee_email": user_employee_email or ""
        }
        return "📋 Fetching your tasks...", state, action
    
    # User is selecting a task number
    if state.current_step == 1:
        tasks = state.collected_data.get("tasks", [])
        if not tasks:
            state.reset()
            return "❌ No tasks available. Please try again later.", state, None
        
        # Parse user selection
        user_input = user_message.strip()
        
        # Check if user typed a number
        try:
            selection = int(user_input)
            if 1 <= selection <= len(tasks):
                selected_task = tasks[selection - 1]
                state.reset()
                
                action = {
                    "type": "start_task_timer",
                    "employee_id": user_employee_id,
                    "task_guid": selected_task.get("guid"),
                    "task_id": selected_task.get("task_id"),
                    "task_name": selected_task.get("task_name"),
                    "project_id": selected_task.get("project_id")
                }
                return f"▶️ Starting timer for **{selected_task.get('task_name', 'Task')}**...", state, action
            else:
                return f"❌ Please enter a number between 1 and {len(tasks)}.", state, None
        except ValueError:
            # Check if user typed task name or ID
            user_lower = user_input.lower()
            for task in tasks:
                task_name = (task.get("task_name") or "").lower()
                task_id = (task.get("task_id") or "").lower()
                if user_lower in task_name or user_lower == task_id:
                    state.reset()
                    action = {
                        "type": "start_task_timer",
                        "employee_id": user_employee_id,
                        "task_guid": task.get("guid"),
                        "task_id": task.get("task_id"),
                        "task_name": task.get("task_name"),
                        "project_id": task.get("project_id")
                    }
                    return f"▶️ Starting timer for **{task.get('task_name', 'Task')}**...", state, action
            
            return f"❌ I couldn't find that task. Please enter a number (1-{len(tasks)}) or the task name.", state, None
    
    return "I didn't understand that. Please select a task number.", state, None


def handle_task_stop_flow(
    user_message: str,
    state: 'ConversationState',
    user_employee_id: str = None
) -> Tuple[str, 'ConversationState', Optional[Dict[str, Any]]]:
    """
    Handle stopping the currently running task.
    This is a single-step action.
    """
    state.reset()
    
    if not user_employee_id:
        return "❌ I couldn't identify your employee ID. Please make sure you're logged in.", state, None
    
    action = {
        "type": "stop_task_timer",
        "employee_id": user_employee_id
    }
    return "⏹️ Stopping your current task timer...", state, action


# ================== MAIN AUTOMATION HANDLER ==================

def process_automation(
    user_message: str,
    conversation_state: Optional[Dict[str, Any]] = None,
    user_employee_id: Optional[str] = None,
    user_employee_name: Optional[str] = None,
    user_employee_email: Optional[str] = None
) -> Dict[str, Any]:
    """
    Main entry point for processing automation flows.
    
    Args:
        user_message: The user's message
        conversation_state: Optional existing conversation state (from frontend)
        user_employee_id: Employee ID of the logged-in user
        user_employee_name: Name of the logged-in user
        user_employee_email: Email of the logged-in user
    
    Returns:
        Dict with:
            - is_automation: bool - Whether this is an automation flow
            - response: str - The response message (if automation)
            - state: dict - Updated conversation state
            - action: Optional dict - Action to execute
    """
    
    # Restore or create state
    if conversation_state:
        state = ConversationState.from_dict(conversation_state)
    else:
        state = ConversationState()
    
    # If there's an active flow, continue it
    if state.active_flow:
        if state.active_flow == "employee_creation":
            response, state, action = handle_employee_creation_flow(user_message, state)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif state.active_flow == "employee_edit":
            response, state, action = handle_employee_edit_flow(user_message, state)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif state.active_flow == "employee_delete":
            response, state, action = handle_employee_delete_flow(user_message, state)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif state.active_flow == "leave_application":
            response, state, action = handle_leave_application_flow(user_message, state, user_employee_id)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif state.active_flow == "asset_creation":
            response, state, action = handle_asset_creation_flow(user_message, state)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif state.active_flow == "task_start":
            response, state, action = handle_task_start_flow(user_message, state, user_employee_id, user_employee_name, user_employee_email)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
    
    # Check for new automation intent
    intent = detect_automation_intent(user_message)
    if intent:
        if intent["flow"] == "employee_creation":
            response, state, action = handle_employee_creation_flow(user_message, state)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif intent["flow"] == "employee_edit":
            response, state, action = handle_employee_edit_flow(user_message, state)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif intent["flow"] == "employee_delete":
            response, state, action = handle_employee_delete_flow(user_message, state)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif intent["flow"] == "leave_application":
            response, state, action = handle_leave_application_flow(user_message, state, user_employee_id)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif intent["flow"] == "asset_creation":
            response, state, action = handle_asset_creation_flow(user_message, state)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif intent["flow"] == "check_in":
            response, state, action = _handle_check_action("check_in", state, user_employee_id)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif intent["flow"] == "check_out":
            response, state, action = _handle_check_action("check_out", state, user_employee_id)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif intent["flow"] == "task_start":
            response, state, action = handle_task_start_flow(user_message, state, user_employee_id, user_employee_name, user_employee_email)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
        elif intent["flow"] == "task_stop":
            response, state, action = handle_task_stop_flow(user_message, state, user_employee_id)
            return {
                "is_automation": True,
                "response": response,
                "state": state.to_dict(),
                "action": action
            }
    
    # Not an automation flow
    return {
        "is_automation": False,
        "response": None,
        "state": state.to_dict(),
        "action": None
    }


def execute_automation_action(action: Dict[str, Any], token: str) -> Dict[str, Any]:
    """
    Execute an automation action (e.g., create employee).
    
    Args:
        action: The action to execute
        token: Dataverse access token
    
    Returns:
        Dict with success status and result/error
    """
    import requests
    from dataverse_helper import create_record
    
    if action["type"] == "create_employee":
        try:
            data = action["data"]
            
            # The create_employee endpoint handles all the logic
            # We'll call it internally or replicate the logic here
            from unified_server import (
                get_employee_entity_set, get_field_map, generate_employee_id,
                create_record, BASE_URL, LEAVE_BALANCE_ENTITY,
                calculate_experience, get_leave_allocation_by_experience,
                get_login_table, _hash_password, determine_access_level,
                generate_user_id, send_login_credentials_email,
            )
            import os
            
            entity_set = get_employee_entity_set(token)
            field_map = get_field_map(entity_set)

            first_name = data.get('first_name', '')
            last_name = data.get('last_name', '')
            email = data.get('email', '')
            designation = data.get('designation', '')
            doj = data.get('doj', '')
            contact_number = data.get('contact_number', '')
            employee_flag = data.get('employee_flag', 'Employee')

            # ==================== DUPLICATE CHECKS (same as /api/employees) ====================
            headers_check = {"Authorization": f"Bearer {token}"}

            if email:
                safe_email = email.strip().replace("'", "''")
                check_url = f"{BASE_URL}/{entity_set}?$filter=crc6f_email eq '{safe_email}'"
                resp_email = requests.get(check_url, headers=headers_check)
                if resp_email.status_code == 200:
                    existing = resp_email.json().get('value', [])
                    if existing:
                        return {
                            "success": False,
                            "error": f"Employee with email {email} already exists",
                        }

            if contact_number:
                safe_contact = contact_number.strip().replace("'", "''")
                check_url = f"{BASE_URL}/{entity_set}?$filter=crc6f_contactnumber eq '{safe_contact}'"
                resp_contact = requests.get(check_url, headers=headers_check)
                if resp_contact.status_code == 200:
                    existing = resp_contact.json().get('value', [])
                    if existing:
                        return {
                            "success": False,
                            "error": f"Employee with contact number {contact_number} already exists",
                        }

            # ==================== EMPLOYEE CREATION ====================

            # Generate employee ID (always auto-generated in automation flow)
            employee_id = generate_employee_id()
            
            # Build payload
            payload = {}
            
            if field_map['id']:
                payload[field_map['id']] = employee_id

            # Handle name fields
            if field_map['fullname']:
                payload[field_map['fullname']] = f"{first_name} {last_name}".strip()
            else:
                if field_map['firstname']:
                    payload[field_map['firstname']] = first_name
                if field_map['lastname']:
                    payload[field_map['lastname']] = last_name
            
            if field_map['email']:
                payload[field_map['email']] = email
            if field_map['contact'] and contact_number:
                payload[field_map['contact']] = contact_number
            if field_map['designation']:
                payload[field_map['designation']] = designation
            if field_map['doj']:
                payload[field_map['doj']] = doj
            if field_map['active']:
                payload[field_map['active']] = "Active"
            if field_map.get('employee_flag'):
                payload[field_map['employee_flag']] = employee_flag
            
            # Calculate experience
            if field_map.get('experience') and doj:
                experience = calculate_experience(doj)
                payload[field_map['experience']] = str(experience)
            
            if field_map.get('quota_hours'):
                payload[field_map['quota_hours']] = "9"
            
            # Create the employee record
            created = create_record(entity_set, payload)
            
            # ==================== LOGIN CREATION + EMAIL ====================
            if email:
                try:
                    login_table = get_login_table(token)
                    access_level = determine_access_level(designation)
                    user_id = generate_user_id(employee_id, first_name)
                    default_password = os.getenv("DEFAULT_USER_PASSWORD", "Temp@123")
                    
                    login_payload = {
                        "crc6f_username": email,
                        "crc6f_password": _hash_password(default_password),
                        "crc6f_accesslevel": access_level,
                        "crc6f_userid": user_id,
                        "crc6f_employeename": f"{first_name} {last_name}".strip(),
                        "crc6f_user_status": "Active",
                        "crc6f_loginattempts": "0"
                    }
                    create_record(login_table, login_payload)

                    # Send login credentials email (same as external upload path)
                    try:
                        credentials = {
                            "username": email,
                            "password": default_password,
                        }
                        employee_data = {
                            "email": email,
                            "firstname": first_name,
                            "lastname": last_name,
                            "employee_id": employee_id,
                        }
                        send_login_credentials_email(employee_data, credentials)
                    except Exception as mail_err:
                        print(f"[WARN] Failed to send login credentials email: {mail_err}")

                except Exception as e:
                    print(f"[WARN] Failed to create login: {e}")
            
            # ==================== LEAVE BALANCE CREATION ====================
            try:
                experience = calculate_experience(doj) if doj else 0
                cl, sl, total, allocation_type = get_leave_allocation_by_experience(experience)
                actual_total = cl + sl
                
                leave_payload = {
                    "crc6f_employeeid": employee_id,
                    "crc6f_cl": str(cl),
                    "crc6f_sl": str(sl),
                    "crc6f_compoff": "0",
                    "crc6f_total": str(total),
                    "crc6f_actualtotal": str(actual_total),
                    "crc6f_leaveallocationtype": allocation_type
                }
                create_record(LEAVE_BALANCE_ENTITY, leave_payload)
            except Exception as e:
                print(f"[WARN] Failed to create leave balance: {e}")
            
            return {
                "success": True,
                "message": f"Employee **{first_name} {last_name}** created successfully!",
                "employee_id": employee_id,
                "data": {
                    "employee_id": employee_id,
                    "name": f"{first_name} {last_name}",
                    "email": email,
                    "designation": designation
                }
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": str(e)
            }
    
    # ==================== SEARCH EMPLOYEE (for edit flow) ====================
    if action["type"] == "search_employee":
        try:
            from unified_server import (
                get_employee_entity_set, get_field_map, BASE_URL
            )
            
            search_term = action.get("search_term", "").strip()
            entity_set = get_employee_entity_set(token)
            field_map = get_field_map(entity_set)
            
            headers = {"Authorization": f"Bearer {token}"}
            
            # Try to find by employee ID first, then by email
            employee = None
            
            # Search by employee ID
            if search_term.upper().startswith("EMP") or search_term.isdigit():
                id_field = field_map.get('id', 'crc6f_employeeid')
                safe_term = search_term.strip().replace("'", "''")
                url = f"{BASE_URL}/{entity_set}?$filter={id_field} eq '{safe_term}'"
                resp = requests.get(url, headers=headers)
                if resp.status_code == 200:
                    results = resp.json().get('value', [])
                    if results:
                        employee = results[0]
            
            # Search by email if not found
            if not employee and '@' in search_term:
                email_field = field_map.get('email', 'crc6f_email')
                safe_email = search_term.lower().strip().replace("'", "''")
                url = f"{BASE_URL}/{entity_set}?$filter={email_field} eq '{safe_email}'"
                resp = requests.get(url, headers=headers)
                if resp.status_code == 200:
                    results = resp.json().get('value', [])
                    if results:
                        employee = results[0]
            
            # Try contains search as fallback
            if not employee:
                id_field = field_map.get('id', 'crc6f_employeeid')
                safe_term = search_term.strip().replace("'", "''")
                url = f"{BASE_URL}/{entity_set}?$filter=contains({id_field}, '{safe_term}')"
                resp = requests.get(url, headers=headers)
                if resp.status_code == 200:
                    results = resp.json().get('value', [])
                    if results:
                        employee = results[0]
            
            if not employee:
                return {
                    "success": False,
                    "error": f"No employee found with ID or email: **{search_term}**. Please check and try again."
                }
            
            # Extract employee data
            if field_map.get('fullname'):
                fullname = employee.get(field_map['fullname'], '')
                parts = fullname.split(' ', 1)
                first_name = parts[0] if parts else ''
                last_name = parts[1] if len(parts) > 1 else ''
            else:
                first_name = employee.get(field_map.get('firstname', ''), '')
                last_name = employee.get(field_map.get('lastname', ''), '')
            
            employee_data = {
                "employee_id": employee.get(field_map.get('id')),
                "record_guid": employee.get(field_map.get('primary')),
                "first_name": first_name,
                "last_name": last_name,
                "email": employee.get(field_map.get('email', ''), ''),
                "designation": employee.get(field_map.get('designation', ''), ''),
                "contact_number": employee.get(field_map.get('contact', ''), ''),
                "doj": employee.get(field_map.get('doj', ''), ''),
                "employee_flag": employee.get(field_map.get('employee_flag', ''), ''),
            }
            
            return {
                "success": True,
                "employee": employee_data,
                "message": f"Found employee: {first_name} {last_name}"
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": f"Error searching for employee: {str(e)}"
            }
    
    # ==================== UPDATE EMPLOYEE ====================
    if action["type"] == "update_employee":
        try:
            from unified_server import (
                get_employee_entity_set, get_field_map, BASE_URL
            )
            
            employee_id = action.get("employee_id")
            record_guid = action.get("record_guid")
            updates = action.get("updates", {})
            
            if not updates:
                return {
                    "success": False,
                    "error": "No updates provided"
                }
            
            entity_set = get_employee_entity_set(token)
            field_map = get_field_map(entity_set)
            
            # Build the update payload
            payload = {}
            
            for key, value in updates.items():
                if key == "first_name":
                    if field_map.get('firstname'):
                        payload[field_map['firstname']] = value
                    elif field_map.get('fullname'):
                        # Need to update fullname - get last name first
                        payload[field_map['fullname']] = f"{value} {updates.get('last_name', '')}".strip()
                elif key == "last_name":
                    if field_map.get('lastname'):
                        payload[field_map['lastname']] = value
                    elif field_map.get('fullname') and 'first_name' not in updates:
                        # Need to preserve first name
                        payload[field_map['fullname']] = f"{updates.get('first_name', '')} {value}".strip()
                elif key == "email" and field_map.get('email'):
                    payload[field_map['email']] = value
                elif key == "designation" and field_map.get('designation'):
                    payload[field_map['designation']] = value
                elif key == "contact_number" and field_map.get('contact'):
                    payload[field_map['contact']] = value
                elif key == "doj" and field_map.get('doj'):
                    payload[field_map['doj']] = value
                elif key == "employee_flag" and field_map.get('employee_flag'):
                    payload[field_map['employee_flag']] = value
            
            if not payload:
                return {
                    "success": False,
                    "error": "Could not map any fields for update"
                }
            
            # Perform the PATCH request
            primary_key = field_map.get('primary', 'crc6f_table12id')
            url = f"{BASE_URL}/{entity_set}({record_guid})"
            
            headers = {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "OData-MaxVersion": "4.0",
                "OData-Version": "4.0",
                "If-Match": "*"
            }
            
            resp = requests.patch(url, headers=headers, json=payload)
            
            if resp.status_code in [200, 204]:
                updated_fields = ", ".join([f"**{k}**" for k in updates.keys()])
                return {
                    "success": True,
                    "message": f"Employee **{employee_id}** updated successfully! Changed: {updated_fields}",
                    "employee_id": employee_id
                }
            else:
                return {
                    "success": False,
                    "error": f"Failed to update employee: {resp.status_code} - {resp.text[:200]}"
                }
            
        except Exception as e:
            return {
                "success": False,
                "error": f"Error updating employee: {str(e)}"
            }
    
    # ==================== SEARCH EMPLOYEE FOR DELETE ====================
    if action["type"] == "search_employee_for_delete":
        # Reuse the same search logic as edit flow
        try:
            from unified_server import (
                get_employee_entity_set, get_field_map, BASE_URL
            )
            
            search_term = action.get("search_term", "").strip()
            entity_set = get_employee_entity_set(token)
            field_map = get_field_map(entity_set)
            
            headers = {"Authorization": f"Bearer {token}"}
            
            employee = None
            
            # Search by employee ID
            if search_term.upper().startswith("EMP") or search_term.isdigit():
                id_field = field_map.get('id', 'crc6f_employeeid')
                safe_term = search_term.strip().replace("'", "''")
                url = f"{BASE_URL}/{entity_set}?$filter={id_field} eq '{safe_term}'"
                resp = requests.get(url, headers=headers)
                if resp.status_code == 200:
                    results = resp.json().get('value', [])
                    if results:
                        employee = results[0]
            
            # Search by email if not found
            if not employee and '@' in search_term:
                email_field = field_map.get('email', 'crc6f_email')
                safe_email = search_term.lower().strip().replace("'", "''")
                url = f"{BASE_URL}/{entity_set}?$filter={email_field} eq '{safe_email}'"
                resp = requests.get(url, headers=headers)
                if resp.status_code == 200:
                    results = resp.json().get('value', [])
                    if results:
                        employee = results[0]
            
            # Try contains search as fallback
            if not employee:
                id_field = field_map.get('id', 'crc6f_employeeid')
                safe_term = search_term.strip().replace("'", "''")
                url = f"{BASE_URL}/{entity_set}?$filter=contains({id_field}, '{safe_term}')"
                resp = requests.get(url, headers=headers)
                if resp.status_code == 200:
                    results = resp.json().get('value', [])
                    if results:
                        employee = results[0]
            
            if not employee:
                return {
                    "success": False,
                    "error": f"No employee found with ID or email: **{search_term}**. Please check and try again."
                }
            
            # Extract employee data
            if field_map.get('fullname'):
                fullname = employee.get(field_map['fullname'], '')
                parts = fullname.split(' ', 1)
                first_name = parts[0] if parts else ''
                last_name = parts[1] if len(parts) > 1 else ''
            else:
                first_name = employee.get(field_map.get('firstname', ''), '')
                last_name = employee.get(field_map.get('lastname', ''), '')
            
            employee_data = {
                "employee_id": employee.get(field_map.get('id')),
                "record_guid": employee.get(field_map.get('primary')),
                "first_name": first_name,
                "last_name": last_name,
                "email": employee.get(field_map.get('email', ''), ''),
                "designation": employee.get(field_map.get('designation', ''), ''),
            }
            
            return {
                "success": True,
                "employee": employee_data,
                "message": f"Found employee: {first_name} {last_name}",
                "for_delete": True
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": f"Error searching for employee: {str(e)}"
            }
    
    # ==================== DELETE EMPLOYEE ====================
    if action["type"] == "delete_employee":
        try:
            from unified_server import (
                get_employee_entity_set, get_field_map, BASE_URL, _extract_record_id
            )
            from dataverse_helper import delete_record
            
            employee_id = action.get("employee_id")
            record_guid = action.get("record_guid")
            
            if not record_guid:
                return {
                    "success": False,
                    "error": "Missing record GUID for deletion"
                }
            
            entity_set = get_employee_entity_set(token)
            
            # Perform the DELETE request
            delete_record(entity_set, record_guid)
            
            return {
                "success": True,
                "message": f"Employee **{employee_id}** has been permanently deleted.",
                "employee_id": employee_id
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": f"Error deleting employee: {str(e)}"
            }
    
    # ==================== APPLY LEAVE ====================
    if action["type"] == "apply_leave":
        try:
            from unified_server import (
                generate_leave_id, calculate_leave_days, format_employee_id,
                create_record, LEAVE_ENTITY, BASE_URL, get_access_token,
                _fetch_leave_balance, _ensure_leave_balance_row,
                _get_available_days, _decrement_leave_balance,
                get_employee_name, send_email
            )
            import os
            from datetime import timedelta
            
            data = action["data"]
            
            leave_type = data.get('leave_type', '')
            compensation = data.get('compensation', 'Paid')
            start_date = data.get('start_date', '')
            end_date = data.get('end_date', '')
            reason = data.get('reason', '')
            employee_id = data.get('employee_id', '')
            
            # Format employee ID if needed
            if employee_id:
                if employee_id.isdigit():
                    employee_id = format_employee_id(int(employee_id))
                elif employee_id.upper().startswith("EMP"):
                    employee_id = employee_id.upper()
            
            if not employee_id:
                return {
                    "success": False,
                    "error": "Employee ID is required. Please ensure you are logged in."
                }
            
            # Validate required fields
            if not all([leave_type, start_date, end_date]):
                return {
                    "success": False,
                    "error": "Missing required fields: leave type, start date, and end date are required."
                }
            
            # Generate leave ID and calculate days
            leave_id = generate_leave_id()
            leave_days = calculate_leave_days(start_date, end_date)
            
            # Get leave balance
            balance_row = None
            try:
                balance_row = _fetch_leave_balance(token, employee_id)
            except Exception as bal_err:
                print(f"[WARN] Could not fetch leave balance for {employee_id}: {bal_err}")
            
            paid_flag = (compensation or "").lower() == "paid"
            lt_norm = (leave_type or "").strip().lower()
            
            # Handle Casual Leave and Sick Leave with auto-split logic
            if paid_flag and lt_norm in ("casual leave", "sick leave"):
                if not balance_row:
                    balance_row = _ensure_leave_balance_row(token, employee_id)
                available = _get_available_days(balance_row, leave_type)
                print(f"🔎 Available days for {leave_type} = {available}, requested = {leave_days}")
                paid_days = min(float(available or 0), float(leave_days or 0))
                unpaid_days = max(0.0, float(leave_days or 0) - paid_days)
                
                created_records = []
                primary_leave_id = None
                
                start_dt = datetime.strptime(start_date, "%Y-%m-%d")
                end_dt = datetime.strptime(end_date, "%Y-%m-%d")
                
                # Create paid leave record
                if paid_days > 0:
                    paid_leave_id = leave_id
                    paid_end_dt = start_dt + timedelta(days=int(paid_days) - 1)
                    record_data_paid = {
                        "crc6f_leaveid": paid_leave_id,
                        "crc6f_leavetype": leave_type,
                        "crc6f_startdate": start_dt.date().isoformat(),
                        "crc6f_enddate": paid_end_dt.date().isoformat(),
                        "crc6f_paidunpaid": "Paid",
                        "crc6f_status": "Pending",
                        "crc6f_totaldays": str(int(paid_days)),
                        "crc6f_employeeid": employee_id,
                        "crc6f_approvedby": "",
                    }
                    print(f"📦 Creating Paid leave record: {record_data_paid}")
                    created_paid = create_record(LEAVE_ENTITY, record_data_paid)
                    created_records.append(created_paid)
                    primary_leave_id = paid_leave_id
                    
                    # Decrement leave balance
                    try:
                        if paid_days > 0:
                            _decrement_leave_balance(token, balance_row, leave_type, paid_days)
                    except Exception as dec_err:
                        print(f"[WARN] Failed to decrement leave balance: {dec_err}")
                
                # Create unpaid leave record if needed
                if unpaid_days > 0:
                    unpaid_leave_id = generate_leave_id()
                    unpaid_start_dt = start_dt + timedelta(days=int(paid_days))
                    record_data_unpaid = {
                        "crc6f_leaveid": unpaid_leave_id,
                        "crc6f_leavetype": leave_type,
                        "crc6f_startdate": unpaid_start_dt.date().isoformat(),
                        "crc6f_enddate": end_dt.date().isoformat(),
                        "crc6f_paidunpaid": "Unpaid",
                        "crc6f_status": "Pending",
                        "crc6f_totaldays": str(int(unpaid_days)),
                        "crc6f_employeeid": employee_id,
                        "crc6f_approvedby": "",
                    }
                    print(f"📦 Creating Unpaid leave record: {record_data_unpaid}")
                    created_unpaid = create_record(LEAVE_ENTITY, record_data_unpaid)
                    created_records.append(created_unpaid)
                    if primary_leave_id is None:
                        primary_leave_id = unpaid_leave_id
                
                # Fetch updated balances
                latest_row = None
                try:
                    latest_row = _fetch_leave_balance(token, employee_id) or balance_row
                except Exception:
                    latest_row = balance_row
                balances = {
                    "Casual Leave": float((latest_row or {}).get("crc6f_cl", 0) or 0),
                    "Sick Leave": float((latest_row or {}).get("crc6f_sl", 0) or 0),
                    "Comp Off": float((latest_row or {}).get("crc6f_compoff", 0) or 0),
                }
                balances["Total"] = balances["Casual Leave"] + balances["Sick Leave"] + balances["Comp Off"]
                
                # Send notification email
                try:
                    admin_email = os.getenv("ADMIN_EMAIL")
                    employee_name = get_employee_name(employee_id)
                    if admin_email:
                        send_email(
                            subject=f"[AI Assistant] New Leave Request from {employee_id}",
                            recipients=[admin_email],
                            body=f"""
Employee {employee_name} ({employee_id}) has applied for {leave_type} leave via AI Assistant
from {start_date} to {end_date} ({leave_days} days).

Paid: {paid_days} day(s)
Unpaid: {unpaid_days} day(s)

Reason: {reason or 'Not provided'}

Please review in HR Tool.
""")
                except Exception as mail_err:
                    print(f"[WARN] Failed to send notification email: {mail_err}")
                
                split_msg = ""
                if unpaid_days > 0:
                    split_msg = f"\n\n📊 **Split:** {int(paid_days)} day(s) Paid + {int(unpaid_days)} day(s) Unpaid (insufficient balance)"
                
                return {
                    "success": True,
                    "message": f"Leave applied successfully!{split_msg}",
                    "leave_id": primary_leave_id,
                    "leave_days": leave_days,
                    "balances": balances,
                    "split": {
                        "paid_days": paid_days,
                        "unpaid_days": unpaid_days,
                    }
                }
            
            # Handle other leave types (Comp Off) or Unpaid leaves
            if paid_flag:
                if not balance_row:
                    balance_row = _ensure_leave_balance_row(token, employee_id)
                available = _get_available_days(balance_row, leave_type)
                print(f"🔎 Available days for {leave_type} = {available}, requested = {leave_days}")
                if float(available) < float(leave_days):
                    return {
                        "success": False,
                        "error": f"Insufficient {leave_type} balance. Available: {available}, requested: {leave_days}. Please choose Unpaid or adjust dates.",
                        "available": available,
                        "requested": leave_days,
                        "leave_type": leave_type
                    }
            
            # Create single leave record
            record_data = {
                "crc6f_leaveid": leave_id,
                "crc6f_leavetype": leave_type,
                "crc6f_startdate": start_date,
                "crc6f_enddate": end_date,
                "crc6f_paidunpaid": compensation,
                "crc6f_status": "Pending",
                "crc6f_totaldays": str(leave_days),
                "crc6f_employeeid": employee_id,
                "crc6f_approvedby": "",
            }
            
            print(f"📦 Creating leave record: {record_data}")
            created_record = create_record(LEAVE_ENTITY, record_data)
            
            # Decrement balance if paid
            try:
                if paid_flag and leave_days > 0:
                    _decrement_leave_balance(token, balance_row, leave_type, leave_days)
            except Exception as dec_err:
                print(f"[WARN] Failed to decrement leave balance: {dec_err}")
            
            # Fetch updated balances
            latest_row = None
            try:
                latest_row = _fetch_leave_balance(token, employee_id) or balance_row
            except Exception:
                latest_row = balance_row
            balances = {
                "Casual Leave": float((latest_row or {}).get("crc6f_cl", 0) or 0),
                "Sick Leave": float((latest_row or {}).get("crc6f_sl", 0) or 0),
                "Comp Off": float((latest_row or {}).get("crc6f_compoff", 0) or 0),
            }
            balances["Total"] = balances["Casual Leave"] + balances["Sick Leave"] + balances["Comp Off"]
            
            # Send notification email
            try:
                admin_email = os.getenv("ADMIN_EMAIL")
                employee_name = get_employee_name(employee_id)
                if admin_email:
                    send_email(
                        subject=f"[AI Assistant] New Leave Request from {employee_id}",
                        recipients=[admin_email],
                        body=f"""
Employee {employee_name} ({employee_id}) has applied for {leave_type} leave via AI Assistant
from {start_date} to {end_date} ({leave_days} days).

Compensation: {compensation}
Reason: {reason or 'Not provided'}

Please review in HR Tool.
""")
            except Exception as mail_err:
                print(f"[WARN] Failed to send notification email: {mail_err}")
            
            return {
                "success": True,
                "message": f"Leave applied successfully for {employee_id}!",
                "leave_id": leave_id,
                "leave_days": leave_days,
                "balances": balances
            }
            
        except Exception as e:
            import traceback
            traceback.print_exc()
            return {
                "success": False,
                "error": f"Error applying leave: {str(e)}"
            }
    
    # ==================== CHECK-IN ====================
    if action["type"] == "check_in":
        try:
            from unified_server import format_employee_id, active_sessions
            import requests as req
            
            employee_id = action.get("employee_id", "")
            
            # Normalize employee ID
            if employee_id:
                if employee_id.isdigit():
                    employee_id = format_employee_id(int(employee_id))
                elif employee_id.upper().startswith("EMP"):
                    employee_id = employee_id.upper()
            
            if not employee_id:
                return {
                    "success": False,
                    "error": "Employee ID is required for check-in."
                }
            
            # Call the check-in endpoint internally
            from unified_server import checkin as do_checkin
            from flask import Flask
            
            # We need to make an internal request to the checkin endpoint
            # Since we're in the same process, we can call the function directly
            # but we need to simulate the request context
            from unified_server import (
                ATTENDANCE_ENTITY, FIELD_EMPLOYEE_ID, FIELD_DATE, FIELD_CHECKIN,
                FIELD_ATTENDANCE_ID_CUSTOM, FIELD_RECORD_ID,
                generate_random_attendance_id, create_record, update_record,
                RESOURCE, log_login_event
            )
            
            key = employee_id.upper()
            
            # Check if already checked in
            if key in active_sessions:
                session = active_sessions[key]
                return {
                    "success": True,
                    "message": f"✅ You're already checked in since {session.get('checkin_time', 'earlier')}!",
                    "already_checked_in": True,
                    "checkin_time": session.get("checkin_time")
                }
            
            now = datetime.now()
            formatted_date = now.date().isoformat()
            formatted_time = now.strftime("%H:%M:%S")
            
            # Check for existing attendance record for today
            attendance_record = None
            try:
                headers = {
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/json",
                }
                filter_query = f"?$filter={FIELD_EMPLOYEE_ID} eq '{employee_id}' and {FIELD_DATE} eq '{formatted_date}'"
                url = f"{RESOURCE}/api/data/v9.2/{ATTENDANCE_ENTITY}{filter_query}"
                resp = req.get(url, headers=headers, timeout=20)
                if resp.status_code == 200:
                    vals = resp.json().get("value", [])
                    if vals:
                        attendance_record = vals[0]
            except Exception as probe_err:
                print(f"[WARN] Failed to probe existing attendance record: {probe_err}")
            
            existing_hours = 0.0
            if attendance_record:
                # Reuse existing record
                record_id = (
                    attendance_record.get(FIELD_RECORD_ID)
                    or attendance_record.get("crc6f_table13id")
                    or attendance_record.get("id")
                )
                attendance_id = (
                    attendance_record.get(FIELD_ATTENDANCE_ID_CUSTOM)
                    or generate_random_attendance_id()
                )
                try:
                    existing_hours = float(attendance_record.get("crc6f_duration") or "0")
                except:
                    existing_hours = 0.0
                
                active_sessions[key] = {
                    "record_id": record_id,
                    "checkin_time": formatted_time,
                    "checkin_datetime": now.isoformat(),
                    "attendance_id": attendance_id,
                }
                
                return {
                    "success": True,
                    "message": f"✅ Checked in at **{formatted_time}**! (Continuing today's session)",
                    "checkin_time": formatted_time,
                    "continued_day": True,
                    "total_seconds_today": int(round(existing_hours * 3600))
                }
            
            # Create new attendance record
            random_attendance_id = generate_random_attendance_id()
            record_data = {
                FIELD_EMPLOYEE_ID: employee_id,
                FIELD_DATE: formatted_date,
                FIELD_CHECKIN: formatted_time,
                FIELD_ATTENDANCE_ID_CUSTOM: random_attendance_id,
            }
            
            created = create_record(ATTENDANCE_ENTITY, record_data)
            record_id = (
                created.get(FIELD_RECORD_ID)
                or created.get("crc6f_table13id")
                or created.get("id")
            )
            
            if record_id:
                active_sessions[key] = {
                    "record_id": record_id,
                    "checkin_time": formatted_time,
                    "checkin_datetime": now.isoformat(),
                    "attendance_id": random_attendance_id,
                }
                
                return {
                    "success": True,
                    "message": f"✅ Checked in successfully at **{formatted_time}**!",
                    "checkin_time": formatted_time,
                    "attendance_id": random_attendance_id
                }
            else:
                return {
                    "success": False,
                    "error": "Failed to create attendance record"
                }
                
        except Exception as e:
            import traceback
            traceback.print_exc()
            return {
                "success": False,
                "error": f"Check-in failed: {str(e)}"
            }
    
    # ==================== CHECK-OUT ====================
    if action["type"] == "check_out":
        try:
            from unified_server import format_employee_id, active_sessions
            import requests as req
            
            employee_id = action.get("employee_id", "")
            
            # Normalize employee ID
            if employee_id:
                if employee_id.isdigit():
                    employee_id = format_employee_id(int(employee_id))
                elif employee_id.upper().startswith("EMP"):
                    employee_id = employee_id.upper()
            
            if not employee_id:
                return {
                    "success": False,
                    "error": "Employee ID is required for check-out."
                }
            
            key = employee_id.upper()
            
            # Check if checked in
            session = active_sessions.get(key)
            if not session:
                return {
                    "success": False,
                    "error": "❌ No active check-in found. Please check in first."
                }
            
            from unified_server import (
                ATTENDANCE_ENTITY, FIELD_CHECKOUT, FIELD_DURATION, FIELD_DURATION_INTEXT,
                FIELD_EMPLOYEE_ID, FIELD_DATE, FIELD_RECORD_ID,
                update_record, RESOURCE
            )
            
            now = datetime.now()
            checkout_time_str = now.strftime("%H:%M:%S")
            
            # Calculate session duration
            try:
                if "checkin_datetime" in session:
                    checkin_dt = datetime.fromisoformat(session["checkin_datetime"])
                    session_seconds = int((now - checkin_dt).total_seconds())
                elif "checkin_time" in session:
                    checkin_time_str = session["checkin_time"]
                    checkin_dt = datetime.strptime(checkin_time_str, "%H:%M:%S").replace(
                        year=now.year, month=now.month, day=now.day
                    )
                    session_seconds = int((now - checkin_dt).total_seconds())
                else:
                    session_seconds = 0
            except Exception:
                session_seconds = 0
            
            if session_seconds < 0:
                session_seconds = 0
            
            # Fetch existing duration to aggregate
            attendance_record = None
            record_id = session.get("record_id")
            try:
                headers = {
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/json",
                }
                if record_id:
                    url = f"{RESOURCE}/api/data/v9.2/{ATTENDANCE_ENTITY}({record_id})"
                    resp = req.get(url, headers=headers, timeout=20)
                    if resp.status_code == 200:
                        attendance_record = resp.json()
            except Exception:
                pass
            
            existing_hours = 0.0
            if attendance_record:
                try:
                    existing_hours = float(attendance_record.get(FIELD_DURATION) or "0")
                except:
                    existing_hours = 0.0
            
            # Aggregate duration
            session_hours = session_seconds / 3600.0
            total_hours_today = existing_hours + session_hours
            total_seconds_today = int(round(total_hours_today * 3600))
            
            # Human-readable duration
            hours_int = total_seconds_today // 3600
            minutes_int = (total_seconds_today % 3600) // 60
            readable_duration = f"{hours_int} hour(s) {minutes_int} minute(s)"
            
            update_data = {
                FIELD_CHECKOUT: checkout_time_str,
                FIELD_DURATION: str(round(total_hours_today, 2)),
                FIELD_DURATION_INTEXT: readable_duration,
            }
            
            if record_id:
                update_record(ATTENDANCE_ENTITY, record_id, update_data)
            
            # Clear session
            try:
                if key in active_sessions:
                    del active_sessions[key]
            except:
                pass
            
            return {
                "success": True,
                "message": f"✅ Checked out at **{checkout_time_str}**!\n\n📊 **Today's total:** {readable_duration}",
                "checkout_time": checkout_time_str,
                "duration": readable_duration,
                "total_hours": total_hours_today,
                "total_seconds_today": total_seconds_today
            }
            
        except Exception as e:
            import traceback
            traceback.print_exc()
            return {
                "success": False,
                "error": f"Check-out failed: {str(e)}"
            }
    
    # ==================== CREATE ASSET ====================
    if action["type"] == "create_asset":
        try:
            import requests as req
            from unified_server import (
                RESOURCE, get_access_token, create_record
            )
            
            data = action["data"]
            
            asset_name = data.get('asset_name', '')
            serial_number = data.get('serial_number', '')
            category = data.get('category', '')
            location = data.get('location', '')
            status = data.get('status', 'In Use')
            assigned_to = data.get('assigned_to', '')
            employee_id = data.get('employee_id', '')
            assigned_on = data.get('assigned_on', '')
            
            # Asset entity name
            ASSET_ENTITY = "crc6f_hr_assetdetailses"
            API_BASE = f"{RESOURCE}/api/data/v9.2"
            
            # Generate asset ID based on category
            category_prefix_map = {
                "Laptop": "LP",
                "Monitor": "MO",
                "Charger": "CH",
                "Keyboard": "KB",
                "Headset": "HS",
                "Accessory": "AC",
            }
            prefix = category_prefix_map.get(category, "GEN")
            
            # Count existing assets in this category to generate unique ID
            headers = {"Authorization": f"Bearer {token}"}
            try:
                filter_url = f"{API_BASE}/{ASSET_ENTITY}?$filter=crc6f_assetcategory eq '{category}'&$count=true"
                resp = req.get(filter_url, headers=headers, timeout=20)
                if resp.status_code == 200:
                    existing_count = len(resp.json().get('value', []))
                else:
                    existing_count = 0
            except Exception:
                existing_count = 0
            
            asset_id = f"{prefix}-{existing_count + 1}"
            
            # Check for duplicate asset ID (just in case)
            try:
                check_url = f"{API_BASE}/{ASSET_ENTITY}?$filter=crc6f_assetid eq '{asset_id}'"
                resp = req.get(check_url, headers=headers, timeout=20)
                if resp.status_code == 200:
                    existing = resp.json().get('value', [])
                    if existing:
                        # Generate a unique ID with timestamp
                        import time
                        asset_id = f"{prefix}-{existing_count + 1}-{int(time.time()) % 10000}"
            except Exception:
                pass
            
            # Build the payload for Dataverse
            payload = {
                "crc6f_assetid": asset_id,
                "crc6f_assetname": asset_name,
                "crc6f_serialnumber": serial_number,
                "crc6f_assetcategory": category,
                "crc6f_location": location,
                "crc6f_assetstatus": status,
            }
            
            # Add optional fields if provided
            if assigned_to:
                payload["crc6f_assignedto"] = assigned_to
            if employee_id:
                payload["crc6f_employeeid"] = employee_id
            if assigned_on:
                payload["crc6f_assignedon"] = assigned_on
            
            # Create the asset record
            created = create_record(ASSET_ENTITY, payload)
            
            return {
                "success": True,
                "message": f"Asset **{asset_name}** (ID: {asset_id}) created successfully! 📦",
                "asset_id": asset_id,
                "data": {
                    "asset_id": asset_id,
                    "asset_name": asset_name,
                    "serial_number": serial_number,
                    "category": category,
                    "location": location,
                    "status": status,
                    "assigned_to": assigned_to,
                    "employee_id": employee_id,
                    "assigned_on": assigned_on
                }
            }
            
        except Exception as e:
            import traceback
            traceback.print_exc()
            return {
                "success": False,
                "error": f"Failed to create asset: {str(e)}"
            }
    
    # ==================== FETCH MY TASKS ====================
    if action["type"] == "fetch_my_tasks":
        try:
            import requests as req
            import os as _os
            from dataverse_helper import get_access_token
            
            employee_id = action.get("employee_id", "")
            employee_name = action.get("employee_name") or ""
            employee_email = action.get("employee_email") or ""
            
            if not employee_id:
                return {
                    "success": False,
                    "error": "Employee ID is required to fetch tasks."
                }
            
            # Normalize employee ID
            emp_id_upper = employee_id.upper()
            emp_id_lower = employee_id.lower()
            emp_name_lower = employee_name.lower() if employee_name else ""
            emp_email_lower = employee_email.lower() if employee_email else ""
            
            token = get_access_token()
            headers = {
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "OData-Version": "4.0",
            }
            
            dv_resource = _os.getenv("RESOURCE", "")
            dv_api = "/api/data/v9.2"
            
            all_tasks = []
            
            # ========== 1. Fetch tasks from HR_TaskDetails table ==========
            # This matches what the My Tasks page shows
            try:
                tasks_url = f"{dv_resource}{dv_api}/crc6f_hr_taskdetailses?$select=crc6f_hr_taskdetailsid,crc6f_taskid,crc6f_taskname,crc6f_taskdescription,crc6f_taskpriority,crc6f_taskstatus,crc6f_assignedto,crc6f_assigneddate,crc6f_duedate,crc6f_projectid,crc6f_boardid"
                tasks_resp = req.get(tasks_url, headers=headers, timeout=30)
                if tasks_resp.ok:
                    tasks_data = tasks_resp.json().get("value", [])
                    for t in tasks_data:
                        assigned_to = (t.get("crc6f_assignedto") or "").lower()
                        # Match by employee ID, name, or email
                        if (emp_id_lower and emp_id_lower in assigned_to) or \
                           (emp_name_lower and emp_name_lower in assigned_to) or \
                           (emp_email_lower and emp_email_lower in assigned_to):
                            all_tasks.append({
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
                                "source": "tasks_table"
                            })
            except Exception as te:
                print(f"[AI] Error fetching from tasks table: {te}")
            
            # ========== 2. If no tasks found, fetch projects where user is a contributor ==========
            # Only show projects if user has no tasks assigned
            if len(all_tasks) == 0:
                try:
                    # First get project IDs where user is a contributor
                    contrib_url = f"{dv_resource}{dv_api}/crc6f_hr_projectcontributorses?$filter=crc6f_employeeid eq '{emp_id_upper}'&$select=crc6f_projectid,crc6f_hr_projectcontributorsid"
                    contrib_resp = req.get(contrib_url, headers=headers, timeout=30)
                    
                    user_project_ids = set()
                    if contrib_resp.ok:
                        contrib_data = contrib_resp.json().get("value", [])
                        for c in contrib_data:
                            pid = c.get("crc6f_projectid")
                            if pid:
                                user_project_ids.add(pid)
                    
                    # Also check projects where user is the manager
                    projects_url = f"{dv_resource}{dv_api}/crc6f_hr_projectheaders?$select=crc6f_projectid,crc6f_projectname,crc6f_manager,crc6f_projectstatus,crc6f_startdate,crc6f_enddate,crc6f_hr_projectheaderid"
                    projects_resp = req.get(projects_url, headers=headers, timeout=30)
                    
                    if projects_resp.ok:
                        projects_data = projects_resp.json().get("value", [])
                        for p in projects_data:
                            pid = p.get("crc6f_projectid")
                            manager = (p.get("crc6f_manager") or "").lower()
                            
                            # Include if user is contributor OR manager
                            is_contributor = pid in user_project_ids
                            is_manager = (emp_id_lower and emp_id_lower in manager) or \
                                        (emp_name_lower and emp_name_lower in manager) or \
                                        (emp_email_lower and emp_email_lower in manager)
                            
                            if is_contributor or is_manager:
                                # Add project as a "task" so user can start timer on it
                                all_tasks.append({
                                    "guid": p.get("crc6f_hr_projectheaderid"),
                                    "task_id": pid,
                                    "task_name": p.get("crc6f_projectname") or pid,
                                    "task_description": f"Project: {p.get('crc6f_projectname')}",
                                    "task_priority": "Normal",
                                    "task_status": p.get("crc6f_projectstatus") or "Active",
                                    "assigned_to": employee_id,
                                    "assigned_date": p.get("crc6f_startdate"),
                                    "due_date": p.get("crc6f_enddate"),
                                    "project_id": pid,
                                    "board_id": None,
                                    "source": "projects_table",
                                    "is_project": True
                                })
                except Exception as pe:
                    print(f"[AI] Error fetching from projects table: {pe}")
            
            # Deduplicate by guid
            seen_guids = set()
            unique_tasks = []
            for t in all_tasks:
                guid = t.get("guid")
                if guid and guid not in seen_guids:
                    seen_guids.add(guid)
                    unique_tasks.append(t)
            
            return {
                "success": True,
                "tasks": unique_tasks,
                "message": f"Found {len(unique_tasks)} task(s)."
            }
            
        except Exception as e:
            import traceback
            traceback.print_exc()
            return {
                "success": False,
                "error": f"Error fetching tasks: {str(e)}"
            }
    
    # ==================== START TASK TIMER ====================
    if action["type"] == "start_task_timer":
        try:
            employee_id = action.get("employee_id", "")
            task_guid = action.get("task_guid", "")
            task_id = action.get("task_id", "")
            task_name = action.get("task_name", "")
            project_id = action.get("project_id", "")
            
            if not employee_id or not task_guid:
                return {
                    "success": False,
                    "error": "Employee ID and task GUID are required."
                }
            
            return {
                "success": True,
                "message": f"Timer started for **{task_name or task_id}**! ▶️",
                "task_guid": task_guid,
                "task_id": task_id,
                "task_name": task_name,
                "project_id": project_id,
                "employee_id": employee_id,
                "action": "start_timer"
            }
        except Exception as e:
            import traceback
            traceback.print_exc()
            return {
                "success": False,
                "error": f"Error starting task timer: {str(e)}"
            }
    
    # ==================== STOP TASK TIMER ====================
    if action["type"] == "stop_task_timer":
        try:
            employee_id = action.get("employee_id", "")
            
            if not employee_id:
                return {
                    "success": False,
                    "error": "Employee ID is required."
                }
            
            return {
                "success": True,
                "message": "Task timer stopped! ⏹️",
                "employee_id": employee_id,
                "action": "stop_timer"
            }
        except Exception as e:
            import traceback
            traceback.print_exc()
            return {
                "success": False,
                "error": f"Error stopping task timer: {str(e)}"
            }
    
    return {
        "success": False,
        "error": f"Unknown action type: {action.get('type')}"
    }
