# ai_automation.py - Conversational automation for HR tasks
"""
This module handles multi-step conversational flows for automating HR tasks
like creating employees, applying for leave, etc.
"""
import json
import re
from typing import Dict, Any, Optional, List, Tuple
from datetime import datetime

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
    # Future: add more intents like "apply_leave", "create_asset", etc.
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
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "active_flow": self.active_flow,
            "current_step": self.current_step,
            "collected_data": self.collected_data,
            "awaiting_confirmation": self.awaiting_confirmation
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'ConversationState':
        state = cls()
        state.active_flow = data.get("active_flow")
        state.current_step = data.get("current_step", 0)
        state.collected_data = data.get("collected_data", {})
        state.awaiting_confirmation = data.get("awaiting_confirmation", False)
        return state
    
    def reset(self):
        self.active_flow = None
        self.current_step = 0
        self.collected_data = {}
        self.awaiting_confirmation = False


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


# ================== MAIN AUTOMATION HANDLER ==================

def process_automation(
    user_message: str,
    conversation_state: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Main entry point for processing automation flows.
    
    Args:
        user_message: The user's message
        conversation_state: Optional existing conversation state (from frontend)
    
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
    
    return {
        "success": False,
        "error": f"Unknown action type: {action.get('type')}"
    }
