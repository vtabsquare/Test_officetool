# unified_server.py - Combined Attendance & Leave Tracker Backend
from flask import Flask, render_template, request, jsonify, current_app, redirect
from flask_cors import CORS
from datetime import datetime, timedelta, timezone, date
from calendar import monthrange
from functools import wraps
import random
import string
import traceback
import requests, re
import os
import hashlib
import json
import uuid
import imaplib
import email
import jwt
from email.header import decode_header
from dotenv import load_dotenv
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from google.auth.transport.requests import Request
from dataverse_helper import create_record, update_record, delete_record, get_access_token, get_employee_name, get_employee_email, get_record
from flask_mail import Mail, Message
from mail_app import send_email
from project_contributors import bp as contributors_bp
from project_boards import bp as boards_bp
from project_tasks import tasks_bp
from project_column import columns_bp
from chats import chat_bp
from time_tracking import bp_time

try:
    from zoneinfo import ZoneInfo
except Exception:
    ZoneInfo = None

app = Flask(__name__)

app.register_blueprint(contributors_bp)
app.register_blueprint(boards_bp)
app.register_blueprint(tasks_bp)
app.register_blueprint(columns_bp)
app.register_blueprint(bp_time)
app.register_blueprint(chat_bp)

def _coerce_client_local_datetime(client_time_str, timezone_name):
    """Convert client-supplied ISO timestamp into the user's local timezone if possible."""
    if not client_time_str or not isinstance(client_time_str, str):
        return None
    try:
        normalized = client_time_str
        if normalized.endswith("Z"):
            normalized = normalized[:-1] + "+00:00"
        client_dt = datetime.fromisoformat(normalized)
        if timezone_name and ZoneInfo:
            try:
                tz = ZoneInfo(timezone_name)
                return client_dt.astimezone(tz)
            except Exception:
                return client_dt
        return client_dt
    except Exception:
        return None

def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        auth_header = request.headers.get('Authorization')
        if not auth_header or not auth_header.startswith('Bearer '):
            return jsonify({'error': 'No authorization token provided'}), 401
        
        token = auth_header.split(' ')[1]
        try:
            # Verify token and check admin status
            headers = {
                'Authorization': f'Bearer {token}',
                'Accept': 'application/json'
            }
            entity_set = get_employee_entity_set(get_access_token())
            field_map = get_field_map(entity_set)
            
            email_field = field_map.get('email')
            desig_field = field_map.get('designation')
            
            if not email_field or not desig_field:
                return jsonify({'error': 'Invalid configuration'}), 500
                
            url = f"{BASE_URL}/{entity_set}?$select={email_field},{desig_field}"
            resp = requests.get(url, headers=headers)
            
            if resp.status_code != 200:
                return jsonify({'error': 'Invalid token'}), 401
                
            user_data = resp.json().get('value', [])[0]
            designation = user_data.get(desig_field, '').lower()
            
            if not ('admin' in designation or 'manager' in designation):
                return jsonify({'error': 'Admin access required'}), 403
                
            return f(*args, **kwargs)
            
        except Exception as e:
            return jsonify({'error': str(e)}), 401
            
    return decorated_function

@app.route('/api/admin/query', methods=['POST'])
@admin_required
def admin_query():
    try:
        data = request.get_json()
        entity_name = data.get('entity')
        query_type = data.get('type', 'select')
        filters = data.get('filters', {})
        fields = data.get('fields', [])
        
        if not entity_name:
            return jsonify({'error': 'Entity name is required'}), 400
            
        token = get_access_token()
        headers = {
            'Authorization': f'Bearer {token}',
            'Accept': 'application/json',
            'OData-MaxVersion': '4.0',
            'OData-Version': '4.0'
        }
        
        # Build OData query
        query_parts = []
        if fields:
            query_parts.append(f"$select={','.join(fields)}")
            
        if filters:
            filter_conditions = []
            for field, value in filters.items():
                if isinstance(value, str):
                    filter_conditions.append(f"{field} eq '{value}'")
                else:
                    filter_conditions.append(f"{field} eq {value}")
            if filter_conditions:
                query_parts.append(f"$filter={' and '.join(filter_conditions)}")
                
        query_string = '&'.join(query_parts)
        url = f"{BASE_URL}/{entity_name}?{query_string}"
        
        response = requests.get(url, headers=headers)
        if response.status_code == 200:
            return jsonify(response.json()), 200
        else:
            return jsonify({'error': f'Query failed: {response.text}'}), response.status_code
            
    except Exception as e:
        return jsonify({'error': str(e)}), 500

allowed_origins = os.getenv("CORS_ORIGINS", "")
origins = [o.strip() for o in allowed_origins.split(",") if o.strip()]
# Sensible defaults for prod if env is missing
default_origins = [
    "https://officetool-zeta.vercel.app",
    "https://vtab-office-tool.onrender.com",
]
if origins:
    CORS(app, origins=origins)
else:
    CORS(app, origins=default_origins)

# Frontend base used to build reset links
FRONTEND_BASE_URL = os.getenv("FRONTEND_BASE_URL", "https://officetool-zeta.vercel.app").rstrip("/")
app.config['DEBUG'] = os.getenv("FLASK_DEBUG", "false").lower() == "true"
app.url_map.strict_slashes = False

# [MAIL] Mail server configuration (used for sending emails)
# Load from environment variables for security and flexibility
app.config['MAIL_SERVER'] = os.getenv('MAIL_SERVER', 'smtp.gmail.com') # Default: Gmail SMTP
app.config['MAIL_PORT'] = 587  # Port for TLS
app.config['MAIL_USE_TLS'] = True   # Enable TLS encryption
app.config['MAIL_USERNAME'] = os.getenv('MAIL_USERNAME')    # Sender email address
app.config['MAIL_PASSWORD'] = os.getenv('MAIL_PASSWORD')      # App password or SMTP key

# 📨 Default sender address (if not provided in individual emails)
app.config['MAIL_DEFAULT_SENDER'] = os.getenv('MAIL_DEFAULT_SENDER', app.config['MAIL_USERNAME'])

# ✉️ Initialize Flask-Mail with the app configuration
mail = Mail(app)


# Load environment variables
if os.getenv("FLASK_ENV", "development").lower() != "production":
    if os.path.exists("id.env"):
        load_dotenv("id.env")
    load_dotenv()  # Also try .env in current directory

# Allow insecure (HTTP) transport for Google OAuth when not running in production.
if os.getenv("FLASK_ENV", "development").lower() != "production":
    os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"

GOOGLE_CLIENT_CONFIG_FILE = os.path.join(os.path.dirname(__file__), "Googlemeet token.json")

def get_employee_entity_set(token):
    """Get the correct employee entity set name"""
    global EMPLOYEE_ENTITY
    
    if EMPLOYEE_ENTITY_ENV:
        return EMPLOYEE_ENTITY_ENV
        
    headers = {
        'Authorization': f'Bearer {token}',
        'Accept': 'application/json'
    }
    
    # Try the default first
    url = f"{BASE_URL}/{EMPLOYEE_ENTITY}?$top=1"
    response = requests.get(url, headers=headers)
    
    if response.status_code == 200:
        return EMPLOYEE_ENTITY
        
    # Try alternatives
    alternatives = [
        'crc6f_employees',
        'crc6f_employeeses',
        'crc6f_hr_employees',
        'crc6f_hr_employeeses'
    ]
    
    for alt in alternatives:
        url = f"{BASE_URL}/{alt}?$top=1"
        response = requests.get(url, headers=headers)
        if response.status_code == 200:
            EMPLOYEE_ENTITY = alt
            return alt
            
    raise Exception('Could not resolve employee entity set')

def get_field_map(entity_set):
    """Get field mappings for the entity"""
    field_map = FIELD_MAPS.get(entity_set, {})
    if not field_map:
        # Default field mappings
        field_map = {
            'email': 'crc6f_email',
            'designation': 'crc6f_designation',
            'employee_id': 'crc6f_employeeid',
            'name': 'crc6f_name'
        }
    return field_map

def _maybe_load_google_client_from_file():
    try:
        if not os.path.exists(GOOGLE_CLIENT_CONFIG_FILE):
            return None

        with open(GOOGLE_CLIENT_CONFIG_FILE, 'r', encoding='utf-8') as fh:
            data = json.load(fh)
        return data.get("web") or data
    except Exception as e:
        print(f"[WARN] Failed to load Google client config from json: {e}")
        return None

def _event_local_date_time(event: dict):
    if not event or not isinstance(event, dict):
        return None, None
    tz_name = (event.get("client_timezone") or "").strip()
    ts = (event.get("client_time_local") or event.get("server_time_utc") or "").strip()
    if not ts:
        return None, None

    try:
        ts_norm = ts.replace("Z", "+00:00")
        dt = datetime.fromisoformat(ts_norm)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
    except Exception:
        return None, None

    if tz_name and ZoneInfo:
        try:
            dt = dt.astimezone(ZoneInfo(tz_name))
        except Exception:
            pass

    # Return a timezone-adjusted ISO value (for DateTime fields) not the raw client string.
    try:
        dt_utc = dt.astimezone(timezone.utc).replace(microsecond=0)
        time_iso = dt_utc.isoformat().replace("+00:00", "Z")
    except Exception:
        time_iso = dt.replace(microsecond=0).isoformat()

    return dt.date().isoformat(), time_iso

# Populate GOOGLE_* env vars from json file if they are missing.
client_cfg = _maybe_load_google_client_from_file()
if client_cfg:
    os.environ.setdefault("GOOGLE_CLIENT_ID", client_cfg.get("client_id", ""))
    os.environ.setdefault("GOOGLE_CLIENT_SECRET", client_cfg.get("client_secret", ""))
    redirect_uri = client_cfg.get("redirect_uris", [None])[0]
    if redirect_uri:
        os.environ.setdefault("GOOGLE_REDIRECT_URI", redirect_uri)

RESOURCE = os.getenv("RESOURCE")
if not RESOURCE:
    raise ValueError("RESOURCE environment variable not set. Check id.env file location.")
BASE_URL = RESOURCE.rstrip("/") + "/api/data/v9.2"
JWT_SECRET = os.getenv("JWT_SECRET")
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS512")

if not JWT_SECRET:
    raise ValueError("JWT_SECRET is missing in .env file!")
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET")
GOOGLE_REDIRECT_URI = os.getenv("GOOGLE_REDIRECT_URI", "http://localhost:5000/google/oauth2callback")
GOOGLE_SCOPES = ["https://www.googleapis.com/auth/calendar.events"]

SOCKET_SERVER_URL = os.getenv("SOCKET_SERVER_URL", "http://localhost:4000")


def _build_google_oauth_flow(state: str | None = None):
    flow_kwargs = {
        "scopes": GOOGLE_SCOPES,
    }
    if state:
        flow_kwargs["state"] = state
    if os.path.exists(GOOGLE_CLIENT_CONFIG_FILE):
        flow = Flow.from_client_secrets_file(GOOGLE_CLIENT_CONFIG_FILE, **flow_kwargs)
    else:
        flow = Flow.from_client_config(
            {
                "web": {
                    "client_id": GOOGLE_CLIENT_ID,
                    "client_secret": GOOGLE_CLIENT_SECRET,
                    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                    "token_uri": "https://oauth2.googleapis.com/token",
                }
            },
            **flow_kwargs,
        )
    redirect_uri = os.getenv("GOOGLE_REDIRECT_URI", "http://localhost:5000/google/oauth2callback")
    flow.redirect_uri = redirect_uri
    return flow
# ================== LOGIN CONFIGURATION ==================
# Try multiple possible table names for login
LOGIN_TABLE_CANDIDATES = [
    "crc6f_hr_login_detailses",  # Plural with 'es'
    "crc6f_hr_login_details",    # Singular
    "crc6f_hr_logindetails",     # Without underscore
]
LOGIN_TABLE = "crc6f_hr_login_detailses"  # Default to most common
LOGIN_TABLE_RESOLVED = None

# ================== ATTENDANCE CONFIGURATION ==================
ATTENDANCE_ENTITY = "crc6f_table13s"
FIELD_EMPLOYEE_ID = "crc6f_employeeid"
FIELD_DATE = "crc6f_date"
FIELD_CHECKIN = "crc6f_checkin"
FIELD_CHECKOUT = "crc6f_checkout"
FIELD_DURATION = "crc6f_duration"
FIELD_DURATION_INTEXT = "crc6f_duration_intext"
FIELD_ATTENDANCE_ID_CUSTOM = "crc6f_attendanceid"
FIELD_RECORD_ID = "crc6f_table13id"

# ================== LEAVE TRACKER CONFIGURATION ==================
LEAVE_ENTITY = "crc6f_table14s"
# Leave quota/balance entity (Dataverse logical set for leave management)
LEAVE_BALANCE_ENTITY = "crc6f_hr_leavemangements"  # Dataverse collection name (plural with 's')
# Some orgs may expose different collection names; we'll auto-resolve on first use
LEAVE_BALANCE_ENTITY_CANDIDATES = [
    "crc6f_hr_leavemangements",     # plural variant (most common)
    "crc6f_hr_leavemangement",      # singular variant
    "crc6f_leave_mangements",       # pluralized without 'hr'
    "crc6f_leave_mangement",        # underscore variant without 'hr'
]
LEAVE_BALANCE_ENTITY_RESOLVED = None

# ================== ASSET MANAGEMENT CONFIGURATION ==================
API_BASE = f"{RESOURCE}/api/data/v9.2"
ENTITY_NAME = "crc6f_hr_assetdetailses"  # Asset entity logical table name

# ================== HOLIDAY MANAGEMENT CONFIGURATION ==================
HOLIDAY_ENTITY = "crc6f_hr_holidayses"  # Holiday entity table name

# ================== CLIENTS CONFIGURATION ==================
CLIENTS_ENTITY = "crc6f_hr_clients"  # default logical name
CLIENTS_ENTITY_CANDIDATES = [
    "crc6f_hr_clientses",   # common Dataverse plural
    "crc6f_hr_clients",     # singular logical
    "crc6f_clients",        # alternative without 'hr'
    "crc6f_clientses",      # alternative plural without 'hr'
]
CLIENTS_ENTITY_RESOLVED = None

# ================== PROJECTS CONFIGURATION ==================
# Dataverse table: crc6f_hr_projectheaders (logical: crc6f_hr_projectheader)
PROJECTS_ENTITY = "crc6f_hr_projectheaders"
PROJECTS_ENTITY_CANDIDATES = [
    "crc6f_hr_projectheaders",
    "crc6f_hr_projectheaderses",  # in some orgs pluralization is with 'es'
]
PROJECTS_ENTITY_RESOLVED = None

# ================== EMPLOYEE MASTER CONFIGURATION ==================
# Prefer ENV override if provided; otherwise we'll auto-resolve between common sets
EMPLOYEE_ENTITY_ENV = os.getenv("EMPLOYEE_ENTITY")
EMPLOYEE_ENTITY = EMPLOYEE_ENTITY_ENV or "crc6f_table12s"

# Field mappings for different employee tables
FIELD_MAPS = {
    "crc6f_employees": {  # VTAB Employees
        "id": "crc6f_employeeid1",
        "fullname": "crc6f_fullname",
        "firstname": None,
        "lastname": None,
        "email": "crc6f_email",
        "contact": "crc6f_mobilenumber",
        "address": "crc6f_address",
        "department": None,
        "designation": "crc6f_designation",
        "doj": "crc6f_dateofjoining",  # Try different field name for this table
        "active": "crc6f_status",
        "experience": None,
        "quota_hours": None,
        "employee_flag": "crc6f_employeeflag",
        "primary": "crc6f_employeeid"  # Dataverse primary key (best effort)
    },
    "crc6f_table12s": {  # HR_Employee_master
        "id": "crc6f_employeeid",
        "fullname": None,
        "firstname": "crc6f_firstname",
        "lastname": "crc6f_lastname",
        "email": "crc6f_email",
        "contact": "crc6f_contactnumber",
        "address": "crc6f_address",
        "department": "crc6f_department",
        "designation": "crc6f_designation",
        "doj": "crc6f_doj",  # Correct field name for DOJ
        "active": "crc6f_activeflag",
        "experience": "crc6f_experience",
        "quota_hours": "crc6f_quotahours",
        "employee_flag": "crc6f_employeeflag",
        "primary": "crc6f_table12id"
    }
}

# ================== INTERN MANAGEMENT CONFIGURATION ==================
INTERN_ENTITY = "crc6f_hr_interndetailses"
INTERN_FIELDS = {
    "primary": "crc6f_hr_interndetailsid",
    "intern_id": "crc6f_internid",
    "employee_id": "crc6f_employeeid",
    "unpaid_duration": "crc6f_unpaidduration",
    "unpaid_start": "crc6f_unpaidstart",
    "unpaid_end": "crc6f_unpaidend",
    "paid_duration": "crc6f_paidtrainingduration",
    "paid_start": "crc6f_paidtrainingstart",
    "paid_end": "crc6f_paidtrainingend",
    "paid_salary": "crc6f_paidtrainingsalary",
    "probation_duration": "crc6f_probationduration",
    "probation_start": "crc6f_probationstart",
    "probation_end": "crc6f_probationend",
    "probation_salary": "crc6f_probationsalary",
    "postprob_duration": "crc6f_postprobduration",
    "postprob_start": "crc6f_postprobstart",
    "postprob_end": "crc6f_postprobend",
    "postprob_salary": "crc6f_postprobsalary",
    "created_by": "createdby"
}

INTERN_PHASES = {
    "unpaid": {
        "title": "Unpaid Internship",
        "duration_field": "unpaid_duration",
        "start_field": "unpaid_start",
        "end_field": "unpaid_end",
        "salary_field": None
    },
    "paid": {
        "title": "Paid Internship",
        "duration_field": "paid_duration",
        "start_field": "paid_start",
        "end_field": "paid_end",
        "salary_field": "paid_salary"
    },
    "probation": {
        "title": "Probation",
        "duration_field": "probation_duration",
        "start_field": "probation_start",
        "end_field": "probation_end",
        "salary_field": "probation_salary"
    },
    "postprob": {
        "title": "Post Probation",
        "duration_field": "postprob_duration",
        "start_field": "postprob_start",
        "end_field": "postprob_end",
        "salary_field": "postprob_salary"
    }
}

# ================== TEAM MANAGEMENT CONFIGURATION ==================
HIERARCHY_ENTITY = "crc6f_hierarchy"
HIERARCHY_ENTITY_CANDIDATES = [
    "crc6f_hierarchies",
    "crc6f_hr_hierarchy",
    "crc6f_hr_hierarchies"
]
HIERARCHY_ENTITY_RESOLVED = None
HIERARCHY_EMPLOYEE_FIELD = "crc6f_employeeid"
HIERARCHY_MANAGER_FIELD = "crc6f_managerid"
HIERARCHY_PRIMARY_FIELD = "crc6f_hr_hierarchyid"
HIERARCHY_CREATEDBY_FIELD = "createdby"

STORAGE_DIR = os.path.join(os.path.dirname(__file__), "storage")
UPLOADS_DIR = os.path.join(STORAGE_DIR, "uploads")
TEAM_HIERARCHY_STORAGE = os.path.join(STORAGE_DIR, "team_hierarchy.json")
DOCUMENT_INDEX_FILE = os.path.join(STORAGE_DIR, "document_index.json")
GOOGLE_TOKEN_FILE = os.path.join(STORAGE_DIR, "google_tokens.json")

def _load_document_index():
    try:
        os.makedirs(STORAGE_DIR, exist_ok=True)
        if os.path.exists(DOCUMENT_INDEX_FILE):
            with open(DOCUMENT_INDEX_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
    except Exception:
        pass
    return {}

def _save_document_index(idx):
    try:
        os.makedirs(STORAGE_DIR, exist_ok=True)
        with open(DOCUMENT_INDEX_FILE, 'w', encoding='utf-8') as f:
            json.dump(idx, f)
        return True
    except Exception:
        return False

# Cache for resolved entity set name (set after first successful call)
EMPLOYEE_ENTITY_RESOLVED = None

# ================== INBOX CONFIGURATION ==================
# Some orgs pluralize with 'inboxes', others keep singular 'inbox'. Resolve dynamically.
INBOX_ENTITY_CANDIDATES = [
    "crc6f_hr_inboxes",
    "crc6f_hr_inbox",
]
INBOX_ENTITY_RESOLVED = None

# Store active check-in sessions (in production, use Redis or database)
active_sessions = {}

# Store login events (check-in/out with location) - in production, persist to DB
login_events = []

LOGIN_ACTIVITY_ENTITY = "crc6f_hr_loginactivitytbs"
LOGIN_ACTIVITY_PRIMARY_FIELD = "crc6f_hr_loginactivitytbid"
LA_FIELD_EMPLOYEE_ID = "crc6f_employeeid"
LA_FIELD_DATE = "crc6f_date"
LA_FIELD_CHECKIN_LOCATION = "crc6f_checkinlocation"
LA_FIELD_CHECKIN_TIME = "crc6f_checkintime"
LA_FIELD_CHECKOUT_LOCATION = "crc6f_checkoutlocation"
LA_FIELD_CHECKOUT_TIME = "crc6f_checkouttime"

def reverse_geocode_to_city(lat, lng):
    """Convert lat/lng to city/locality using OpenStreetMap Nominatim API."""
    if not lat or not lng:
        return None
    try:
        # zoom 16 for tighter locality; addressdetails=1 for richer fields
        url = (
            "https://nominatim.openstreetmap.org/reverse"
            f"?lat={lat}&lon={lng}&format=json&zoom=16&addressdetails=1&accept-language=en-IN"
        )
        headers = {"User-Agent": "OfficeToolApp/1.0"}
        resp = requests.get(url, headers=headers, timeout=7)
        if resp.status_code == 200:
            data = resp.json()
            address = data.get("address", {})
            # Try multiple locality-level fields for best accuracy
            city = (
                address.get("city")
                or address.get("town")
                or address.get("village")
                or address.get("municipality")
                or address.get("suburb")
                or address.get("neighbourhood")
                or address.get("locality")
                or address.get("hamlet")
                or address.get("county")
                or address.get("state_district")
                or address.get("state")
            )
            if city:
                print(f"[GEOCODE] {lat},{lng} -> {city}")
                return city
    except Exception as e:
        print(f"[GEOCODE] Error reverse geocoding: {e}")
    return None

def log_login_event(employee_id, event_type, req, location=None, client_time=None, timezone_str=None):
    """Log a check-in or check-out event with location and device info."""
    now = datetime.now(timezone.utc)
    
    # Get city name from coordinates
    city_name = None
    if location and isinstance(location, dict) and location.get("lat") and location.get("lng"):
        city_name = reverse_geocode_to_city(location.get("lat"), location.get("lng"))
    
    event = {
        "id": str(uuid.uuid4()),
        "employee_id": employee_id,
        "event_type": event_type,  # 'check_in' or 'check_out'
        "server_time_utc": now.isoformat(),
        "client_time_local": client_time,
        "client_timezone": timezone_str,
        "location_lat": None,
        "location_lng": None,
        "accuracy_m": None,
        "location_source": "none",
        "city": city_name,  # City name from reverse geocoding
        "ip_address": req.remote_addr if req else None,
        "user_agent": req.headers.get("User-Agent", "") if req else None,
        "date": now.date().isoformat(),
    }
    if location and isinstance(location, dict):
        event["location_lat"] = location.get("lat")
        event["location_lng"] = location.get("lng")
        event["accuracy_m"] = location.get("accuracy_m")
        # Respect explicit source if provided, else assume browser when coords exist
        event["location_source"] = location.get("source") or ("browser" if location.get("lat") else "none")
    login_events.append(event)
    print(f"[LOGIN-EVENT] {event_type} for {employee_id} at {now.isoformat()}, city={city_name}")
    return event

def _safe_odata_string(val: str) -> str:
    return (val or "").replace("'", "''")

def _login_activity_location_string(event: dict):
    if not event or not isinstance(event, dict):
        return None
    city = event.get("city")
    if isinstance(city, str) and city.strip():
        return city.strip()
    lat = event.get("location_lat")
    lng = event.get("location_lng")
    if lat is not None and lng is not None:
        try:
            return f"{float(lat):.6f},{float(lng):.6f}"
        except Exception:
            return f"{lat},{lng}"
    return None

def _format_duration_text_from_hours(hours: float) -> str:
    total_seconds = max(0, int(hours * 3600))
    hours_int = total_seconds // 3600
    minutes_int = (total_seconds % 3600) // 60
    return f"{hours_int} hour(s) {minutes_int} minute(s)"

def _live_session_progress_hours(emp_id: str, target_date: str) -> float:
    """Return elapsed hours for an active session on target_date (if any)."""
    if not emp_id or not target_date:
        return 0.0
    session = active_sessions.get(emp_id.strip().upper())
    if not session:
        return 0.0
    if session.get("local_date") != target_date:
        return 0.0

    now_dt = datetime.now()
    checkin_dt = None

    checkin_iso = session.get("checkin_datetime")
    if checkin_iso:
        try:
            checkin_dt = datetime.fromisoformat(checkin_iso)
        except Exception:
            checkin_dt = None

    if checkin_dt is None:
        checkin_str = session.get("checkin_time")
        if checkin_str:
            try:
                checkin_dt = datetime.strptime(checkin_str, "%H:%M:%S").replace(
                    year=now_dt.year, month=now_dt.month, day=now_dt.day
                )
            except Exception:
                checkin_dt = None

    if checkin_dt is None:
        return 0.0

    try:
        elapsed_seconds = (now_dt - checkin_dt).total_seconds()
    except Exception:
        return 0.0

    if elapsed_seconds <= 0:
        return 0.0

    return elapsed_seconds / 3600.0

def _fetch_login_activity_record(token: str, employee_id: str, date_str: str):
    emp = (employee_id or "").strip().upper()
    dt = (date_str or "").strip()
    if not emp or not dt:
        return None
    safe_emp = _safe_odata_string(emp)
    safe_dt = _safe_odata_string(dt)
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0",
    }
    select_fields = ",".join(
        [
            LOGIN_ACTIVITY_PRIMARY_FIELD,
            LA_FIELD_EMPLOYEE_ID,
            LA_FIELD_DATE,
            LA_FIELD_CHECKIN_TIME,
            LA_FIELD_CHECKIN_LOCATION,
            LA_FIELD_CHECKOUT_TIME,
            LA_FIELD_CHECKOUT_LOCATION,
        ]
    )
    url = (
        f"{BASE_URL}/{LOGIN_ACTIVITY_ENTITY}"
        f"?$select={select_fields}&$top=1&$filter={LA_FIELD_EMPLOYEE_ID} eq '{safe_emp}' and {LA_FIELD_DATE} eq '{safe_dt}'"
    )
    resp = requests.get(url, headers=headers, timeout=20)
    if resp.status_code == 200:
        vals = resp.json().get("value", [])
        return vals[0] if vals else None

    # Fallback: if the date column is DateTime, equality against YYYY-MM-DD will not match.
    # Try a day-range query: [dtT00:00:00Z, nextDayT00:00:00Z)
    try:
        d0 = date.fromisoformat(dt)
        d1 = d0 + timedelta(days=1)
        start_iso = f"{d0.isoformat()}T00:00:00Z"
        end_iso = f"{d1.isoformat()}T00:00:00Z"
        safe_start = _safe_odata_string(start_iso)
        safe_end = _safe_odata_string(end_iso)
        url2 = (
            f"{BASE_URL}/{LOGIN_ACTIVITY_ENTITY}"
            f"?$select={select_fields}&$top=1&$filter={LA_FIELD_EMPLOYEE_ID} eq '{safe_emp}' and {LA_FIELD_DATE} ge '{safe_start}' and {LA_FIELD_DATE} lt '{safe_end}'"
        )
        resp2 = requests.get(url2, headers=headers, timeout=20)
        if resp2.status_code == 200:
            vals2 = resp2.json().get("value", [])
            return vals2[0] if vals2 else None
    except Exception:
        pass

    raise Exception(f"Dataverse fetch failed ({resp.status_code}): {resp.text}")

def _upsert_login_activity(token: str, employee_id: str, date_str: str, payload: dict):
    emp = (employee_id or "").strip().upper()
    dt = (date_str or "").strip()
    print(f"[LOGIN-ACTIVITY-UPSERT] emp={emp} date={dt} payload={payload}")
    if not emp or not dt:
        print(f"[LOGIN-ACTIVITY-UPSERT] SKIP: missing emp or date")
        return None
    patch_payload = dict(payload or {})
    if not patch_payload:
        print(f"[LOGIN-ACTIVITY-UPSERT] SKIP: empty payload")
        return None

    existing = None
    try:
        existing = _fetch_login_activity_record(token, emp, dt)
        print(f"[LOGIN-ACTIVITY-UPSERT] existing record: {existing}")
    except Exception as fetch_err:
        print(f"[LOGIN-ACTIVITY-UPSERT] fetch error: {fetch_err}")
        existing = None

    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "Content-Type": "application/json",
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0",
    }

    if existing and existing.get(LOGIN_ACTIVITY_PRIMARY_FIELD):
        record_id = str(existing.get(LOGIN_ACTIVITY_PRIMARY_FIELD)).strip("{}")
        url = f"{BASE_URL}/{LOGIN_ACTIVITY_ENTITY}({record_id})"
        patch_headers = {**headers, "If-Match": "*"}
        print(f"[LOGIN-ACTIVITY-UPSERT] PATCH url={url} payload={patch_payload}")
        r = requests.patch(url, headers=patch_headers, json=patch_payload, timeout=20)
        print(f"[LOGIN-ACTIVITY-UPSERT] PATCH response: {r.status_code} {r.text[:500] if r.text else ''}")
        if r.status_code in (204, 200):
            return record_id
        raise Exception(f"Dataverse update failed ({r.status_code}): {r.text}")

    create_payload = {
        LA_FIELD_EMPLOYEE_ID: emp,
        LA_FIELD_DATE: dt,
        **patch_payload,
    }
    create_headers = {**headers, "Prefer": "return=representation"}
    print(f"[LOGIN-ACTIVITY-UPSERT] POST url={BASE_URL}/{LOGIN_ACTIVITY_ENTITY} payload={create_payload}")
    r = requests.post(f"{BASE_URL}/{LOGIN_ACTIVITY_ENTITY}", headers=create_headers, json=create_payload, timeout=20)
    print(f"[LOGIN-ACTIVITY-UPSERT] POST response: {r.status_code} {r.text[:500] if r.text else ''}")
    if r.status_code in (200, 201):
        body = r.json() if r.content else {}
        rid = body.get(LOGIN_ACTIVITY_PRIMARY_FIELD) or body.get("id")
        return str(rid).strip("{}") if rid else None
    raise Exception(f"Dataverse create failed ({r.status_code}): {r.text}")

def _fetch_login_activity_records_range(token: str, from_date: str, to_date: str, employee_id: str = ""):
    fd = (from_date or "").strip()
    td = (to_date or "").strip()
    if not fd or not td:
        return []
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0",
    }
    select_fields = ",".join(
        [
            LOGIN_ACTIVITY_PRIMARY_FIELD,
            LA_FIELD_EMPLOYEE_ID,
            LA_FIELD_DATE,
            LA_FIELD_CHECKIN_TIME,
            LA_FIELD_CHECKIN_LOCATION,
            LA_FIELD_CHECKOUT_TIME,
            LA_FIELD_CHECKOUT_LOCATION,
        ]
    )
    filter_parts = [
        f"{LA_FIELD_DATE} ge '{_safe_odata_string(fd)}'",
        f"{LA_FIELD_DATE} le '{_safe_odata_string(td)}'",
    ]
    if employee_id:
        filter_parts.append(f"{LA_FIELD_EMPLOYEE_ID} eq '{_safe_odata_string(employee_id.strip().upper())}'")
    filter_query = " and ".join(filter_parts)
    url = f"{BASE_URL}/{LOGIN_ACTIVITY_ENTITY}?$select={select_fields}&$top=5000&$filter={filter_query}"

    merged = []
    seen = set()

    resp = requests.get(url, headers=headers, timeout=25)
    if resp.status_code == 200:
        for r in resp.json().get("value", []):
            rid = r.get(LOGIN_ACTIVITY_PRIMARY_FIELD) or id(r)
            if rid in seen:
                continue
            seen.add(rid)
            merged.append(r)

    # Fallback: DateTime range query using start-of-day and next-day-exclusive for to_date.
    try:
        d0 = date.fromisoformat(fd)
        d1 = date.fromisoformat(td) + timedelta(days=1)
        start_iso = f"{d0.isoformat()}T00:00:00Z"
        end_iso = f"{d1.isoformat()}T00:00:00Z"
        filter_parts2 = [
            f"{LA_FIELD_DATE} ge '{_safe_odata_string(start_iso)}'",
            f"{LA_FIELD_DATE} lt '{_safe_odata_string(end_iso)}'",
        ]
        if employee_id:
            filter_parts2.append(f"{LA_FIELD_EMPLOYEE_ID} eq '{_safe_odata_string(employee_id.strip().upper())}'")
        filter_query2 = " and ".join(filter_parts2)
        url2 = f"{BASE_URL}/{LOGIN_ACTIVITY_ENTITY}?$select={select_fields}&$top=5000&$filter={filter_query2}"
        resp2 = requests.get(url2, headers=headers, timeout=25)
        if resp2.status_code == 200:
            for r in resp2.json().get("value", []):
                rid = r.get(LOGIN_ACTIVITY_PRIMARY_FIELD) or id(r)
                if rid in seen:
                    continue
                seen.add(rid)
                merged.append(r)
    except Exception:
        pass

    # If both queries failed, surface error.
    if merged:
        return merged
    if resp.status_code != 200:
        raise Exception(f"Dataverse range fetch failed ({resp.status_code}): {resp.text}")
    return []

def _fetch_all_employee_ids(token: str):
    entity_set = get_employee_entity_set(token)
    field_map = get_field_map(entity_set)
    id_field = field_map.get("id")
    if not id_field:
        return []
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0",
    }
    url = f"{RESOURCE}/api/data/v9.2/{entity_set}?$select={id_field}&$top=5000&$orderby=createdon desc"
    resp = requests.get(url, headers=headers, timeout=25)
    if resp.status_code != 200:
        return []
    ids = []
    for r in resp.json().get("value", []):
        v = r.get(id_field)
        if v is not None and str(v).strip():
            ids.append(str(v).strip().upper())
    return sorted(set(ids))

def _sync_login_activity_from_event(event: dict):
    try:
        print(f"[LOGIN-ACTIVITY-SYNC] event={event}")
        if not event or not isinstance(event, dict):
            print(f"[LOGIN-ACTIVITY-SYNC] SKIP: invalid event")
            return
        emp = (event.get("employee_id") or "").strip().upper()
        et = (event.get("event_type") or "").strip().lower()
        local_date, local_time_iso = _event_local_date_time(event)
        print(f"[LOGIN-ACTIVITY-SYNC] emp={emp} type={et} local_date={local_date} local_time_iso={local_time_iso}")
        if not emp or not local_date or not local_time_iso or et not in ("check_in", "check_out"):
            print(f"[LOGIN-ACTIVITY-SYNC] SKIP: missing required fields")
            return

        # Some Dataverse schemas use Time-only columns for checkin/checkout.
        # Keep a time-only fallback derived from client/server timestamp.
        time_only = None
        try:
            ts = (event.get("client_time_local") or event.get("server_time_utc") or "").strip()
            if ts:
                dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                tz_name = (event.get("client_timezone") or "").strip()
                if tz_name and ZoneInfo:
                    try:
                        dt = dt.astimezone(ZoneInfo(tz_name))
                    except Exception:
                        pass
                time_only = dt.strftime("%H:%M:%S")
        except Exception:
            time_only = None

        token = get_access_token()
        patch = {}
        if et == "check_in":
            patch[LA_FIELD_CHECKIN_TIME] = local_time_iso
            patch[LA_FIELD_CHECKIN_LOCATION] = _login_activity_location_string(event)
        else:
            patch[LA_FIELD_CHECKOUT_TIME] = local_time_iso
            patch[LA_FIELD_CHECKOUT_LOCATION] = _login_activity_location_string(event)

        try:
            _upsert_login_activity(token, emp, local_date, patch)
        except Exception as e:
            # Retry with time-only values if the schema expects Time instead of DateTime
            if time_only:
                patch2 = dict(patch)
                if et == "check_in":
                    patch2[LA_FIELD_CHECKIN_TIME] = time_only
                else:
                    patch2[LA_FIELD_CHECKOUT_TIME] = time_only
                _upsert_login_activity(token, emp, local_date, patch2)
            else:
                raise e
    except Exception as e:
        print(f"[WARN] Failed to sync login activity: emp={event.get('employee_id')} type={event.get('event_type')} date={event.get('date')} err={e}")

# ================== HELPER FUNCTIONS ==================
def generate_random_attendance_id():
    """Generate random Attendance ID: ATD-H35J6U9"""
    random_part = ''.join(random.choices(string.ascii_uppercase + string.digits, k=7))
    return f"ATD-{random_part}"

def _submission_marker_id(emp_id: str, year: int, month: int) -> str:
    emp = (emp_id or '').strip().upper()
    if emp.isdigit():
        emp = f"EMP{int(emp):03d}"
    return f"SUBMIT-{emp}-{year:04d}-{month:02d}"

def _submission_payload_text(emp_id: str, year: int, month: int, status: str, reason: str = "") -> str:
    """Return a compact string under 100 chars to store in crc6f_duration_intext.
    Format: sub:{status}|{emp}|{YYYY}-{MM}|{ts}|{reason(optional)}
    """
    ts = datetime.now().strftime("%Y%m%d%H%M%S")
    base = f"sub:{status}|{emp_id}|{year:04d}-{month:02d}|{ts}"
    if reason:
        # Ensure total <= 100 chars
        avail = 100 - len(base) - 1
        reason_short = reason.strip().replace("|", "/")[:max(0, avail)]
        if reason_short:
            return f"{base}|{reason_short}"
    return base

def _parse_submission_intext(text: str) -> dict:
    """Parse compact intext and return dict with keys: status, employee_id, year, month, rejection_reason"""
    res = {"status": "pending", "employee_id": None, "year": None, "month": None, "rejection_reason": ""}
    if not text:
        return res
    try:
        # Support old JSON format if present
        import json
        if text.strip().startswith("{"):
            obj = json.loads(text)
            res["status"] = (obj.get("status") or "pending").lower()
            res["employee_id"] = obj.get("employee_id")
            res["year"] = obj.get("year")
            res["month"] = obj.get("month")
            res["rejection_reason"] = obj.get("rejection_reason") or ""
            return res
    except Exception:
        pass
    # Compact format: sub:{status}|{emp}|YYYY-MM|timestamp|reason?
    try:
        if text.startswith("sub:"):
            body = text[4:]
            parts = body.split("|")
            if len(parts) >= 3:
                res["status"] = parts[0].lower()
                res["employee_id"] = parts[1]
                ym = parts[2]
                if "-" in ym:
                    y, m = ym.split("-", 1)
                    res["year"] = int(y)
                    res["month"] = int(m)
                if len(parts) >= 5:
                    res["rejection_reason"] = parts[4]
    except Exception:
        pass
    return res

def _probe_entity_set(token: str, entity_set: str) -> bool:
    try:
        headers = {}
        if token:
            headers = {
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "OData-MaxVersion": "4.0",
                "OData-Version": "4.0"
            }
        # Minimal safe query - just get one record without selecting specific fields
        url = f"{RESOURCE}/api/data/v9.2/{entity_set}?$top=1"
        r = requests.get(url, headers=headers, timeout=15)
        return r.status_code == 200
    except Exception:
        return False

def get_employee_entity_set(token: str) -> str:
    global EMPLOYEE_ENTITY_RESOLVED
    if EMPLOYEE_ENTITY_RESOLVED:
        return EMPLOYEE_ENTITY_RESOLVED
    # Candidate order: ENV override, known custom sets
    candidates = [c for c in [EMPLOYEE_ENTITY_ENV, "crc6f_table12s", "crc6f_employees"] if c]
    for cand in candidates:
        if _probe_entity_set(token, cand):
            EMPLOYEE_ENTITY_RESOLVED = cand
            print(f"[OK] Resolved employee entity set: {cand}")
            return cand
    # If none succeed, fall back to the first candidate (likely wrong) so error surfaces with URL
    EMPLOYEE_ENTITY_RESOLVED = candidates[0]
    return EMPLOYEE_ENTITY_RESOLVED

def get_hierarchy_entity(token: str) -> str:
    global HIERARCHY_ENTITY_RESOLVED
    if HIERARCHY_ENTITY_RESOLVED:
        return HIERARCHY_ENTITY_RESOLVED
    candidates = [c for c in [HIERARCHY_ENTITY] + HIERARCHY_ENTITY_CANDIDATES if c]
    seen = set()
    ordered = []
    for cand in candidates:
        if cand not in seen:
            ordered.append(cand)
            seen.add(cand)
    for cand in ordered:
        if _probe_entity_set(token, cand):
            HIERARCHY_ENTITY_RESOLVED = cand
            print(f"[OK] Resolved hierarchy entity set: {cand}")
            return cand
    HIERARCHY_ENTITY_RESOLVED = ordered[0]
    print(f"[WARN] Could not verify hierarchy entity; defaulting to {HIERARCHY_ENTITY_RESOLVED}")
    return HIERARCHY_ENTITY_RESOLVED

def get_inbox_entity_set(token: str) -> str:
    global INBOX_ENTITY_RESOLVED
    if INBOX_ENTITY_RESOLVED:
        return INBOX_ENTITY_RESOLVED
    for cand in INBOX_ENTITY_CANDIDATES:
        if _probe_entity_set(token, cand):
            INBOX_ENTITY_RESOLVED = cand
            print(f"[OK] Resolved inbox entity set: {cand}")
            return cand
    # Fallback to first candidate so the error surfaces clearly
    INBOX_ENTITY_RESOLVED = INBOX_ENTITY_CANDIDATES[0]
    return INBOX_ENTITY_RESOLVED

def get_clients_entity(token: str) -> str:
    """Resolve the correct clients entity set name by probing candidates."""
    global CLIENTS_ENTITY_RESOLVED
    if CLIENTS_ENTITY_RESOLVED:
        return CLIENTS_ENTITY_RESOLVED
    # Deduplicate while keeping order
    candidates = []
    seen = set()
    for cand in [CLIENTS_ENTITY] + CLIENTS_ENTITY_CANDIDATES:
        if cand and cand not in seen:
            candidates.append(cand)
            seen.add(cand)
    for cand in candidates:
        if _probe_entity_set(token, cand):
            CLIENTS_ENTITY_RESOLVED = cand
            print(f"[OK] Resolved clients entity set: {cand}")
            return cand
    CLIENTS_ENTITY_RESOLVED = candidates[0]
    print(f"[WARN] Could not verify clients entity; defaulting to {CLIENTS_ENTITY_RESOLVED}")
    return CLIENTS_ENTITY_RESOLVED


def generate_project_id():
    """
    Auto-generate a unique Project ID (VTAB001, VTAB002, etc.).
    Finds the latest ID from Dataverse and increments it.
    """
    try:
        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        }

        # [OK] Fetch latest project record (ordered descending)
        url = f"{RESOURCE}/api/data/v9.2/{PROJECTS_ENTITY}?$select=crc6f_projectid&$orderby=createdon desc&$top=1"

        res = requests.get(url, headers=headers, timeout=20)

        last_id = None
        if res.ok:
            items = res.json().get("value", [])
            if items and items[0].get("crc6f_projectid"):
                last_id = items[0]["crc6f_projectid"]

        # [OK] Extract numeric part and increment
        if last_id:
            match = re.search(r"VTAB(\d+)", last_id)
            if match:
                next_num = int(match.group(1)) + 1
            else:
                next_num = 1
        else:
            next_num = 1

        new_id = f"VTAB{next_num:03d}"
        current_app.logger.info(f"Auto-generated Project ID: {new_id}")
        return new_id

    except Exception as e:
        current_app.logger.exception("Error generating project ID")
        return "VTAB001"


def get_projects_entity(token: str) -> str:
    """Resolve the correct projects entity set name by probing candidates."""
    global PROJECTS_ENTITY_RESOLVED
    if PROJECTS_ENTITY_RESOLVED:
        return PROJECTS_ENTITY_RESOLVED
    candidates = []
    seen = set()
    for cand in [PROJECTS_ENTITY] + PROJECTS_ENTITY_CANDIDATES:
        if cand and cand not in seen:
            candidates.append(cand)
            seen.add(cand)
    for cand in candidates:
        if _probe_entity_set(token, cand):
            PROJECTS_ENTITY_RESOLVED = cand
            print(f"[OK] Resolved projects entity set: {cand}")
            return cand
    PROJECTS_ENTITY_RESOLVED = candidates[0]
    print(f"[WARN] Could not verify projects entity; defaulting to {PROJECTS_ENTITY_RESOLVED}")
    return PROJECTS_ENTITY_RESOLVED

def get_login_table(token: str) -> str:
    """Resolve the correct login table name from candidates"""
    global LOGIN_TABLE_RESOLVED
    if LOGIN_TABLE_RESOLVED:
        return LOGIN_TABLE_RESOLVED
    for cand in LOGIN_TABLE_CANDIDATES:
        if _probe_entity_set(token, cand):
            LOGIN_TABLE_RESOLVED = cand
            print(f"[OK] Resolved login table: {cand}")
            return cand
    # Fallback to first candidate
    LOGIN_TABLE_RESOLVED = LOGIN_TABLE_CANDIDATES[0]
    print(f"[WARN] Could not resolve login table, using default: {LOGIN_TABLE_RESOLVED}")
    return LOGIN_TABLE_RESOLVED

def get_field_map(entity_set: str) -> dict:
    """Get field mapping for the given entity set"""
    return FIELD_MAPS.get(entity_set, FIELD_MAPS["crc6f_table12s"])


def generate_leave_id():
    """Generate Leave ID: LVE-XXXXXXX"""
    random_part = ''.join(random.choices(string.ascii_uppercase + string.digits, k=7))
    leave_id = f"LVE-{random_part}"
    print(f"   [KEY] Generated Leave ID: {leave_id}")
    return leave_id


def format_employee_id(emp_number):
    """Format employee ID as EMP001, EMP002, etc."""
    emp_id = f"EMP{emp_number:03d}"
    print(f"   [USER] Formatted Employee ID: {emp_id}")
    return emp_id


def calculate_leave_days(start_date, end_date):
    """Calculate number of days between start and end date"""
    start = datetime.strptime(start_date, "%Y-%m-%d")
    end = datetime.strptime(end_date, "%Y-%m-%d")
    days = (end - start).days + 1
    print(f"   [DATE] Calculated Leave Days: {days} (from {start_date} to {end_date})")
    return days


def calculate_experience(doj_str):
    """Calculate experience in years from date of joining to current date
    Supports multiple date formats: YYYY-MM-DD, DD/MM/YYYY, etc.
    """
    if not doj_str:
        return 0.0
    
    try:
        # Try parsing different date formats
        doj = None
        for fmt in ["%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%Y/%m/%d"]:
            try:
                doj = datetime.strptime(str(doj_str).strip(), fmt)
                break
            except ValueError:
                continue
        
        if not doj:
            print(f"   [WARN] Could not parse DOJ: {doj_str}")
            return 0.0
        
        # Calculate years of experience
        today = datetime.now()
        years = (today - doj).days / 365.25
        experience = round(years, 1)
        print(f"   [DATA] Calculated Experience: {experience} years (from {doj_str})")
        return experience
    except Exception as e:
        print(f"   [WARN] Error calculating experience: {e}")
        return 0.0


def determine_access_level(designation):
    """Determine access level based on designation
    Admin L3, Manager L2, others L1
    """
    if not designation:
        return "L1"
    
    designation_lower = str(designation).lower().strip()
    
    if "admin" in designation_lower:
        return "L3"
    elif "manager" in designation_lower:
        return "L2"
    else:
        return "L1"


def generate_user_id(employee_id, first_name=None):
    """Generate user ID in format USER-001, USER-002, etc.
    Auto-increments based on employee ID number
    """
    # Extract number from employee ID (e.g., EMP001 -> 1)
    import re
    match = re.search(r'(\d+)', str(employee_id))
    if match:
        emp_number = int(match.group(1))
        user_id = f"USER-{emp_number:03d}"
    else:
        # Fallback if no number found
        user_id = f"USER-{employee_id}"
    
    print(f"   🆔 Generated User ID: {user_id}")
    return user_id


def _normalize_guid(value: str) -> str:
    if not value:
        return value
    return value.strip('{}')


def _normalize_employee_id(value: str) -> str:
    if not value:
        return ''
    return str(value).strip()


def _get_employee_display_name(record: dict, field_map: dict) -> str:
    if not record:
        return ''
    if field_map.get('fullname') and record.get(field_map['fullname']):
        return str(record.get(field_map['fullname'])).strip()
    first = record.get(field_map.get('firstname')) or ''
    last = record.get(field_map.get('lastname')) or ''
    full = f"{first} {last}".strip()
    return full or first or last or ''


def _format_intern_phase(record: dict, phase_key: str) -> dict:
    cfg = INTERN_PHASES.get(phase_key) or {}
    duration = record.get(INTERN_FIELDS.get(cfg.get('duration_field'), '')) if isinstance(cfg.get('duration_field'), str) else None
    def _get_val(field_key):
        logical = INTERN_FIELDS.get(field_key)
        return record.get(logical) if logical else None

    return {
        "title": cfg.get('title', phase_key.title()),
        "duration": record.get(INTERN_FIELDS.get(cfg.get('duration_field'))),
        "start": record.get(INTERN_FIELDS.get(cfg.get('start_field'))),
        "end": record.get(INTERN_FIELDS.get(cfg.get('end_field'))),
        "salary": record.get(INTERN_FIELDS.get(cfg.get('salary_field'))) if cfg.get('salary_field') else None
    }


def _format_intern_record(record: dict) -> dict:
    if not record:
        return {}
    phases = {
        key: _format_intern_phase(record, key)
        for key in INTERN_PHASES.keys()
    }
    return {
        "intern_id": record.get(INTERN_FIELDS['intern_id']),
        "employee_id": record.get(INTERN_FIELDS['employee_id']),
        "record_id": record.get(INTERN_FIELDS['primary']) or record.get('crc6f_hr_interndetailsid'),
        "created_on": record.get('createdon'),
        "fields": record,
        "phases": phases
    }


def _fetch_intern_record_by_id(token: str, intern_id: str, include_system: bool = True):
    select_clause = ','.join(_build_intern_select_fields(include_system=include_system))
    safe_id = (intern_id or '').replace("'", "''")
    filter_query = f"?$select={select_clause}&$top=1&$filter={INTERN_FIELDS['intern_id']} eq '{safe_id}'"
    url = f"{RESOURCE}/api/data/v9.2/{INTERN_ENTITY}{filter_query}"

    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0",
    }

    resp = requests.get(url, headers=headers, timeout=30)
    if resp.status_code != 200:
        raise Exception(f"Dataverse returned {resp.status_code}: {resp.text}")

    values = resp.json().get("value", [])
    return values[0] if values else None


def _fetch_employee_by_employee_id(token: str, employee_id: str, select_fields=None):
    entity_set = get_employee_entity_set(token)
    field_map = get_field_map(entity_set)
    id_field = field_map.get('id')
    if not id_field:
        raise ValueError("Employee ID field not configured for entity set")

    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0"
    }

    select_parts = set(select_fields or [])
    if id_field:
        select_parts.add(id_field)
    if field_map.get('firstname'):
        select_parts.add(field_map['firstname'])
    if field_map.get('lastname'):
        select_parts.add(field_map['lastname'])
    if field_map.get('fullname'):
        select_parts.add(field_map['fullname'])
    if field_map.get('department'):
        select_parts.add(field_map['department'])

    select_clause = ''
    if select_parts:
        select_clause = f"?$select={','.join(select_parts)}"

    safe_emp = str(employee_id).replace("'", "''")
    filter_clause = "$filter={} eq '{}'".format(id_field, safe_emp)
    operator = '&' if select_clause else '?'
    url = f"{RESOURCE}/api/data/v9.2/{entity_set}{select_clause}{operator}{filter_clause}&$top=1"

    resp = requests.get(url, headers=headers)
    if resp.status_code != 200:
        print(f"[WARN] Failed to fetch employee {employee_id}: {resp.status_code} {resp.text}")
        return None

    values = resp.json().get('value', [])
    return values[0] if values else None


def _save_google_credentials(creds: Credentials):
    try:
        if not creds:
            return
        token_json = creds.to_json()
        save_google_token(token_json)
    except Exception as e:
        print(f"[WARN] Failed to persist Google OAuth credentials: {e}")


def _load_google_credentials():
    try:
        token_json = load_google_token()
        if not token_json:
            return None
        data = json.loads(token_json)
        creds = Credentials.from_authorized_user_info(data, GOOGLE_SCOPES)
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
            _save_google_credentials(creds)
        return creds
    except Exception as e:
        print(f"[WARN] Failed to load Google OAuth credentials: {e}")
        return None


def get_google_calendar_service():
    creds = _load_google_credentials()
    if not creds:
        raise RuntimeError("Google OAuth credentials not found. Please authorize via /google/authorize.")
    if not creds.valid and creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
            _save_google_credentials(creds)
        except Exception as e:
            print(f"[ERROR] Failed to refresh Google OAuth credentials: {e}")
            raise
    return build("calendar", "v3", credentials=creds)


def _get_project_member_employee_ids(token: str, project_id: str):
    safe_pid = str(project_id or "").replace("'", "''")
    if not safe_pid:
        return []
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0",
    }
    url = f"{RESOURCE}/api/data/v9.2/crc6f_hr_projectcontributorses?$select=crc6f_employeeid&$filter=crc6f_projectid eq '{safe_pid}'"
    try:
        resp = requests.get(url, headers=headers, timeout=30)
        if resp.status_code != 200:
            print(f"[WARN] Failed to fetch project members for {project_id}: {resp.status_code} {resp.text}")
            return []
        values = resp.json().get("value", [])
        emp_ids = []
        for row in values:
            emp = row.get("crc6f_employeeid")
            if emp:
                emp_ids.append(emp)
        return emp_ids
    except Exception as e:
        print(f"[WARN] Exception while fetching project members for {project_id}: {e}")
        return []


def notify_socket_server(admin_id: str, meet_url: str, participants: list, title: str = "Meeting"):
    try:
        payload = {
            "admin_id": admin_id,
            "title": title or "Meeting",
            "meet_url": meet_url,
            "participants": participants or [],
        }
        print("[MEET][SOCKET] notify_socket_server payload:", payload)
        resp = requests.post(f"{SOCKET_SERVER_URL}/emit", json=payload, timeout=5)
        print("[MEET][SOCKET] socket server response:", resp.status_code, resp.text[:500])
        if resp.status_code >= 400:
            print(f"[MEET][SOCKET] Non-2xx response from socket server: {resp.status_code} {resp.text}")
            return None
        try:
            data = resp.json() or {}
            return data.get("call_id")
        except Exception:
            return None
    except Exception as e:
        print(f"[MEET][SOCKET] Failed to notify socket server: {e}")
        return None


def _ensure_storage_dir():
    try:
        os.makedirs(STORAGE_DIR, exist_ok=True)
    except Exception as e:
        print(f"[WARN] Failed to ensure storage directory: {e}")


def _load_team_hierarchy_local():
    _ensure_storage_dir()
    if not os.path.exists(TEAM_HIERARCHY_STORAGE):
        return []
    try:
        with open(TEAM_HIERARCHY_STORAGE, 'r', encoding='utf-8') as fh:
            data = json.load(fh)
            if isinstance(data, list):
                return data
    except Exception as e:
        print(f"[WARN] Failed to load team hierarchy cache: {e}")
    return []


def _save_team_hierarchy_local(records: list):
    _ensure_storage_dir()
    try:
        with open(TEAM_HIERARCHY_STORAGE, 'w', encoding='utf-8') as fh:
            json.dump(records or [], fh, indent=2)
    except Exception as e:
        print(f"[WARN] Failed to persist team hierarchy cache: {e}")


def _upsert_team_hierarchy_local(record: dict):
    if not record or not record.get('id'):
        return
    current = _load_team_hierarchy_local()
    normalized_id = _normalize_guid(record.get('id')) or record.get('id')
    record['id'] = normalized_id
    updated = False
    for idx, existing in enumerate(current):
        existing_id = _normalize_guid(existing.get('id')) or existing.get('id')
        if existing_id == normalized_id:
            current[idx] = record
            updated = True
            break
    if not updated:
        current.append(record)
    _save_team_hierarchy_local(current)


def _delete_team_hierarchy_local(record_id: str) -> bool:
    if not record_id:
        return False
    normalized = _normalize_guid(record_id) or record_id
    current = _load_team_hierarchy_local()
    remaining = [r for r in current if (_normalize_guid(r.get('id')) or r.get('id')) != normalized]
    if len(remaining) != len(current):
        _save_team_hierarchy_local(remaining)
        return True
    return False


def _find_local_hierarchy_record(record_id: str):
    if not record_id:
        return None
    normalized = _normalize_guid(record_id) or record_id
    for rec in _load_team_hierarchy_local():
        rec_id = _normalize_guid(rec.get('id')) or rec.get('id')
        if rec_id == normalized:
            return rec
    return None


def _compose_hierarchy_display(token: str, employee_id: str, manager_id: str, record_id: str):
    normalized_id = _normalize_guid(record_id) or record_id or str(uuid.uuid4())
    result = {
        "id": normalized_id,
        "employeeId": employee_id,
        "employeeName": employee_id,
        "employeeDepartment": "",
        "managerId": manager_id,
        "managerName": manager_id,
        "managerDepartment": "",
        "createdBy": None
    }

    lookup = {}
    if token:
        try:
            lookup = _build_employee_lookup(token, {employee_id, manager_id})
        except Exception as e:
            print(f"[WARN] Could not resolve employee names for hierarchy record: {e}")
    if lookup:
        employee_info = lookup.get(employee_id, {})
        manager_info = lookup.get(manager_id, {})
        result["employeeName"] = employee_info.get('name') or employee_id
        result["employeeDepartment"] = employee_info.get('department') or ''
        result["managerName"] = manager_info.get('name') or manager_id
        result["managerDepartment"] = manager_info.get('department') or ''
    else:
        existing = _find_local_hierarchy_record(normalized_id)
        if existing:
            result["employeeName"] = existing.get('employeeName') or employee_id
            result["employeeDepartment"] = existing.get('employeeDepartment') or ''
            result["managerName"] = existing.get('managerName') or manager_id
            result["managerDepartment"] = existing.get('managerDepartment') or ''

    return result


def get_leave_allocation_by_experience(experience_years):
    """Determine leave allocation based on employee experience
    Returns: (cl, sl, total, allocation_type)
    
    Type 1: 3+ years -> 6 CL + 6 SL = 12 total
    Type 2: 2+ years -> 4 CL + 4 SL = 8 total
    Type 3: 1+ years -> 3 CL + 3 SL = 6 total
    Default: < 1 year -> 3 CL + 3 SL = 6 total
    """
    exp = float(experience_years or 0)
    
    if exp >= 3:
        return (6.0, 6.0, 12.0, "Type 1")
    elif exp >= 2:
        return (4.0, 4.0, 8.0, "Type 2")
    elif exp >= 1:
        return (3.0, 3.0, 6.0, "Type 3")
    else:
        # Default for new employees (< 1 year)
        return (3.0, 3.0, 6.0, "Type 3")
    
    print(f"   [FETCH] Leave allocation: Type {allocation_type} - CL: {cl}, SL: {sl}, Total: {total}")


# ================== LEAVE BALANCE HELPERS ==================
def _fetch_leave_balance(token: str, employee_id: str) -> dict:
    """Fetch leave balance row for an employee from Dataverse leave management table.

    Expected columns:
      - crc6f_empid
      - crc6f_cl, crc6f_sl, crc6f_compoff
      - crc6f_total, crc6f_actualtotal
    """
    global LEAVE_BALANCE_ENTITY_RESOLVED
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0",
    }
    safe_emp = employee_id.replace("'", "''")
    # Try resolved set first, else probe candidates
    candidate_sets = [LEAVE_BALANCE_ENTITY]
    if LEAVE_BALANCE_ENTITY_RESOLVED:
        candidate_sets = [LEAVE_BALANCE_ENTITY_RESOLVED]
    else:
        candidate_sets = LEAVE_BALANCE_ENTITY_CANDIDATES

    last_error = None
    for entity_set in candidate_sets:
        try:
            # Try primary FK field name
            url1 = f"{BASE_URL}/{entity_set}?$filter=crc6f_empid eq '{safe_emp}'&$top=1"
            resp = requests.get(url1, headers=headers)
            if resp.status_code == 200:
                values = resp.json().get("value", [])
                if values:
                    LEAVE_BALANCE_ENTITY_RESOLVED = entity_set
                    print(f"[OK] Leave balance entity resolved: {entity_set} using crc6f_empid for {employee_id}")
                    return values[0]
            # Try alternative FK field name if first returned empty
            url2 = f"{BASE_URL}/{entity_set}?$filter=crc6f_employeeid eq '{safe_emp}'&$top=1"
            resp2 = requests.get(url2, headers=headers)
            if resp2.status_code == 200:
                values2 = resp2.json().get("value", [])
                if values2:
                    LEAVE_BALANCE_ENTITY_RESOLVED = entity_set
                    print(f"[OK] Leave balance entity resolved: {entity_set} using crc6f_employeeid for {employee_id}")
                    return values2[0]
            # Record last error body for diagnostics
            last_error = f"{resp.status_code} {resp.text} | alt {resp2.status_code} {resp2.text}"
        except Exception as e:
            last_error = str(e)

    # If none returned data, return None to indicate not found
    if last_error:
        print(f"[WARN] Leave balance fetch error (last): {last_error}")
    return None


def _get_available_days(balance_row: dict, leave_type: str) -> float:
    """Return available days for the requested leave type from a balance row.
    Tries multiple possible column names to be resilient to schema variations.
    """
    if not balance_row:
        return 0
    lt = (leave_type or "").strip().lower()
    def probe(keys):
        for k in keys:
            if k in balance_row:
                try:
                    return float(balance_row.get(k, 0) or 0)
                except Exception:
                    return 0
        return 0
    if lt in ["casual leave", "cl"]:
        return probe(["crc6f_cl", "crc6f_casualleave", "crc6f_casual"])
    if lt in ["sick leave", "sl"]:
        return probe(["crc6f_sl", "crc6f_sickleave", "crc6f_sick", "crc6f_sickleaves"])
    if lt in ["compensatory off", "comp off", "compoff", "co"]:
        return probe(["crc6f_compoff", "crc6f_comp_off", "crc6f_compensatoryoff", "crc6f_compensatory_off"])
    # Fallback total bucket(s)
    return probe(["crc6f_total", "crc6f_overall", "crc6f_totalleave"])


def _decrement_leave_balance(token: str, balance_row: dict, leave_type: str, days: float):
    """Decrement the leave balance for the specified leave type by given days."""
    if not balance_row:
        return
    # Determine column to decrement
    lt = (leave_type or "").strip().lower()
    # Resolve the target field robustly by checking which columns exist on the row
    def resolve_field(row: dict, lt_str: str) -> str:
        lt_low = (lt_str or '').lower()
        candidates = []
        if lt_low in ["casual leave", "cl"]:
            candidates = ["crc6f_cl", "crc6f_casualleave", "crc6f_casual"]
        elif lt_low in ["sick leave", "sl"]:
            candidates = ["crc6f_sl", "crc6f_sickleave", "crc6f_sick", "crc6f_sickleaves"]
        elif lt_low in ["compensatory off", "comp off", "compoff", "co", "crc6f_compoff"]:
            candidates = ["crc6f_compoff", "crc6f_comp_off", "crc6f_compensatoryoff", "crc6f_compensatory_off"]
        else:
            candidates = ["crc6f_total", "crc6f_overall", "crc6f_totalleave"]
        for c in candidates:
            if c in row:
                return c
        # Default to first candidate for PATCH to create the field if schema supports it
        return candidates[0]

    field = resolve_field(balance_row, leave_type)

    current_val = float(balance_row.get(field, 0) or 0)
    new_val = max(0, current_val - float(days))
    try:
        print(f"[TOOL] Decrementing balance: field={field}, current={current_val}, days={days}, new={new_val}")
    except Exception:
        pass

    # Extract primary id key, prioritize known schema
    record_id = balance_row.get('crc6f_hr_leavemangementid') or None
    if not record_id:
        # Check common GUID/ID-like fields
        for k, v in balance_row.items():
            if isinstance(k, str) and k.lower().endswith('id') and isinstance(v, str) and len(v) >= 30:
                record_id = v
                break
    if not record_id:
        # Fallbacks: try typical primary names
        possible_keys = [
            'crc6f_hr_leavemangementid',
            'crc6f_leave_mangementid',
            f"{(LEAVE_BALANCE_ENTITY_RESOLVED or LEAVE_BALANCE_ENTITY)[:-1]}id",
            f"{(LEAVE_BALANCE_ENTITY_RESOLVED or LEAVE_BALANCE_ENTITY)}id",
        ]
        for k in possible_keys:
            if k in balance_row and balance_row[k]:
                record_id = balance_row[k]
                break

    if not record_id:
        # Retry by re-querying Dataverse using the employee id foreign key
        try:
            headers = {
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "OData-MaxVersion": "4.0",
                "OData-Version": "4.0",
            }
            emp_val = balance_row.get('crc6f_empid') or balance_row.get('crc6f_employeeid')
            if not emp_val:
                raise Exception("Missing employee id in balance row")
            entity_set_probe = LEAVE_BALANCE_ENTITY_RESOLVED or LEAVE_BALANCE_ENTITY
            # Try both common fk field names
            for fk in ['crc6f_empid', 'crc6f_employeeid']:
                safe_emp = str(emp_val).replace("'", "''")
                url = f"{BASE_URL}/{entity_set_probe}?$filter={fk} eq '{safe_emp}'&$top=1"
                resp = requests.get(url, headers=headers)
                if resp.status_code == 200:
                    vals = resp.json().get('value', [])
                    if vals:
                        # Find primary id field dynamically
                        for k, v in vals[0].items():
                            if isinstance(k, str) and k.lower().endswith('id') and isinstance(v, str) and len(v) >= 30:
                                record_id = v
                                break
                if record_id:
                    break
        except Exception as re_err:
            try:
                print(f"[WARN] Failed to resolve record id via requery: {re_err}")
            except Exception:
                pass
    if not record_id:
        raise Exception("Unable to resolve leave balance record ID for update")

    # Recalculate actual total = cl + sl + compoff (do not modify total quota)
    cur_cl = float(balance_row.get('crc6f_cl', balance_row.get('crc6f_casualleave', balance_row.get('crc6f_casual', 0))) or 0)
    cur_sl = float(balance_row.get('crc6f_sl', balance_row.get('crc6f_sickleave', balance_row.get('crc6f_sick', balance_row.get('crc6f_sickleaves', 0)))) or 0)
    cur_co = float(balance_row.get('crc6f_compoff', balance_row.get('crc6f_comp_off', balance_row.get('crc6f_compensatoryoff', balance_row.get('crc6f_compensatory_off', 0)))) or 0)
    if field in ('crc6f_cl', 'crc6f_casualleave', 'crc6f_casual'):
        cur_cl = new_val
    elif field in ('crc6f_sl', 'crc6f_sickleave', 'crc6f_sick', 'crc6f_sickleaves'):
        cur_sl = new_val
    elif field in ('crc6f_compoff', 'crc6f_comp_off', 'crc6f_compensatoryoff', 'crc6f_compensatory_off'):
        cur_co = new_val
    # Update total as sum of buckets (your table uses crc6f_total)
    new_total = max(0.0, cur_cl + cur_sl + cur_co)

    # Your Dataverse columns show values as strings; send strings to be safe
    payload = { field: str(new_val), 'crc6f_total': str(new_total) }

    # Prefer the confirmed entity set if available
    entity_set = 'crc6f_hr_leavemangements'
    try:
        if LEAVE_BALANCE_ENTITY_RESOLVED:
            entity_set = LEAVE_BALANCE_ENTITY_RESOLVED
        elif LEAVE_BALANCE_ENTITY:
            entity_set = LEAVE_BALANCE_ENTITY
    except Exception:
        pass
    try:
        print(f"[SEND] Updating Dataverse balance row: entity_set={entity_set}, record_id={record_id}")
        print(f"   Payload: {payload}")
    except Exception:
        pass
    update_record(entity_set, record_id, payload)
    try:
        print("[OK] Leave balance updated successfully")
    except Exception:
        pass

    # Verify update stuck; if not, attempt direct PATCH fallback
    try:
        headers_chk = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0",
        }
        # Read back row via filter using employee id to avoid primary key quoting issues
        safe_emp = str(emp_val).replace("'", "''")
        url_chk = f"{BASE_URL}/{entity_set}?$filter=crc6f_employeeid eq '{safe_emp}' or crc6f_empid eq '{safe_emp}'&$top=1"
        resp_chk = requests.get(url_chk, headers=headers_chk)
        if resp_chk.status_code == 200 and resp_chk.json().get('value'):
            row_back = resp_chk.json()['value'][0]
            current_after = float(row_back.get(field, 0) or 0)
            if abs(current_after - new_val) > 1e-6:
                # Attempt direct PATCH with If-Match fallback using record_id
                try:
                    headers_patch = {
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "application/json",
                        "If-Match": "*",
                        "OData-MaxVersion": "4.0",
                        "OData-Version": "4.0",
                        "Accept": "application/json",
                    }
                    url_upd = f"{BASE_URL}/{entity_set}({record_id})"
                    resp_upd = requests.patch(url_upd, headers=headers_patch, json=payload)
                    print(f"🔁 Direct PATCH fallback status: {resp_upd.status_code}")
                except Exception as patch_err:
                    print(f"[WARN] Direct PATCH fallback failed: {patch_err}")
        else:
            print(f"[WARN] Verification GET failed: {resp_chk.status_code} {resp_chk.text}")
    except Exception as ver_err:
        print(f"[WARN] Post-update verification error: {ver_err}")

def _ensure_leave_balance_row(token: str, employee_id: str, defaults: dict = None) -> dict:
    """Ensure a leave balance row exists for employee; create with defaults if missing.
    Returns the balance row (existing or created).
    """
    row = _fetch_leave_balance(token, employee_id)
    if row:
        return row
    # Prepare defaults
    defaults = defaults or {"crc6f_cl": 3, "crc6f_sl": 3, "crc6f_compoff": 0}
    payload = {
        # Try both common FK field names; Dataverse will ignore unknown fields
        "crc6f_empid": employee_id,
        "crc6f_employeeid": employee_id,
        "crc6f_cl": float(defaults.get("crc6f_cl", 0) or 0),
        "crc6f_sl": float(defaults.get("crc6f_sl", 0) or 0),
        "crc6f_compoff": float(defaults.get("crc6f_compoff", 0) or 0),
    }
    payload["crc6f_actualtotal"] = payload["crc6f_cl"] + payload["crc6f_sl"] + payload["crc6f_compoff"]
    # Attempt create on candidate entity sets until success
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0",
    }
    for entity_set in (LEAVE_BALANCE_ENTITY_RESOLVED and [LEAVE_BALANCE_ENTITY_RESOLVED] or LEAVE_BALANCE_ENTITY_CANDIDATES):
        try:
            url = f"{BASE_URL}/{entity_set}"
            resp = requests.post(url, headers=headers, json=payload)
            if resp.status_code in (200, 201, 204):
                print(f"[OK] Created default leave balance row in {entity_set} for {employee_id}")
                # Read back the row to return consistent structure
                created = _fetch_leave_balance(token, employee_id)
                if created:
                    return created
        except Exception as e:
            print(f"[WARN] Failed creating default balance in {entity_set}: {e}")
    # If create failed, return an in-memory row so callers can proceed (will reflect zeros)
    return {
        "crc6f_empid": employee_id,
        "crc6f_employeeid": employee_id,
        "crc6f_cl": payload["crc6f_cl"],
        "crc6f_sl": payload["crc6f_sl"],
        "crc6f_compoff": payload["crc6f_compoff"],
        "crc6f_actualtotal": payload["crc6f_actualtotal"],
    }

# ================== ASSET MANAGEMENT FUNCTIONS ==================
def get_all_assets():
    token = get_access_token()
    url = f"{API_BASE}/{ENTITY_NAME}"
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    res = requests.get(url, headers=headers)
    if res.status_code == 200:
        return res.json().get("value", [])
    raise Exception(f"Error fetching assets: {res.status_code} - {res.text}")

def get_asset_by_empid(emp_id):
    token = get_access_token()
    url = f"{API_BASE}/{ENTITY_NAME}?$filter=crc6f_employeeid eq '{emp_id}'"
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    res = requests.get(url, headers=headers)
    if res.status_code == 200:
        data = res.json().get("value", [])
        return data[0] if data else None
    raise Exception(f"Error fetching asset by emp id: {res.status_code} - {res.text}")

def get_asset_by_assetid(asset_id):
    token = get_access_token()
    url = f"{API_BASE}/{ENTITY_NAME}?$filter=crc6f_assetid eq '{asset_id}'"
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    res = requests.get(url, headers=headers)
    if res.status_code == 200:
        data = res.json().get("value", [])
        return data[0] if data else None
    raise Exception(f"Error fetching asset by asset id: {res.status_code} - {res.text}")

def create_asset(data):
    # Basic validation server-side
    assigned_to = data.get("crc6f_assignedto", "").strip()
    emp_id = data.get("crc6f_employeeid", "").strip()
    asset_id = data.get("crc6f_assetid", "").strip()

    if not assigned_to or not emp_id:
        return {"error": "Assigned To (crc6f_assignedto) and Employee ID (crc6f_employeeid) are required."}, 400

    if not asset_id:
        return {"error": "Asset ID (crc6f_assetid) is required."}, 400

    # check duplicate asset id
    existing = get_asset_by_assetid(asset_id)
    if existing:
        return {"error": f"Asset with id {asset_id} already exists."}, 409

    token = get_access_token()
    url = f"{API_BASE}/{ENTITY_NAME}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Prefer": "return=representation"
    }
    res = requests.post(url, headers=headers, json=data)
    if res.status_code in (200, 201):
        return res.json()
    raise Exception(f"Error creating asset: {res.status_code} - {res.text}")

def update_asset_by_assetid(asset_id, data):
    asset = get_asset_by_assetid(asset_id)
    if not asset:
        raise Exception("Asset not found for update.")
    record_id = asset.get("crc6f_hr_assetdetailsid")
    if not record_id:
        raise Exception("Record id missing from Dataverse response; cannot update.")
    token = get_access_token()
    url = f"{API_BASE}/{ENTITY_NAME}({record_id})"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "If-Match": "*"
    }
    res = requests.patch(url, headers=headers, json=data)
    if res.status_code in (204, 1223):
        return {"message": "Asset updated successfully"}
    raise Exception(f"Error updating asset: {res.status_code} - {res.text}")

def delete_asset_by_assetid(asset_id):
    asset = get_asset_by_assetid(asset_id)
    if not asset:
        raise Exception("Asset not found for deletion.")
    record_id = asset.get("crc6f_hr_assetdetailsid")
    if not record_id:
        raise Exception("Record id missing from Dataverse response; cannot delete.")
    token = get_access_token()
    url = f"{API_BASE}/{ENTITY_NAME}({record_id})"
    headers = {"Authorization": f"Bearer {token}", "If-Match": "*"}
    res = requests.delete(url, headers=headers)
    if res.status_code == 204:
        return {"message": "Asset deleted successfully"}
    raise Exception(f"Error deleting asset: {res.status_code} - {res.text}")

# ================== AUTH/LOGIN HELPERS ==================
def _hash_password(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()

def _fetch_login_by_username(username: str, token: str, headers: dict):
    # Escape single quotes for OData filter
    login_table = get_login_table(token)
    safe_user = (username or '').strip().replace("'", "''")
    # Try case-sensitive match first (tolower not supported on some Dataverse instances)
    url = f"{BASE_URL}/{login_table}?$top=1&$filter=crc6f_username eq '{safe_user}'"
    resp = requests.get(url, headers=headers)
    resp.raise_for_status()
    records = resp.json().get("value", [])
    return records[0] if records else None

def _update_login_record(record_id: str, payload: dict, headers: dict, token: str):
    login_table = get_login_table(token)
    record_id = (record_id or '').strip("{}")
    url = f"{BASE_URL}/{login_table}({record_id})"
    r = requests.patch(url, headers=headers, json=payload)
    r.raise_for_status()
    return True


# ================== ATTENDANCE ROUTES ==================
@app.route('/api/checkin', methods=['POST'])
def checkin():
    """Check-in: opens or continues today's attendance session for the employee.

    This endpoint is idempotent while a session is active, and supports multiple
    check-in/check-out pairs per calendar day by reusing the same Dataverse
    attendance record and aggregating duration on checkout.
    """
    try:
        data = request.json or {}
        employee_id_raw = (data.get('employee_id') or '').strip()
        if not employee_id_raw:
            return jsonify({"success": False, "error": "Employee ID is required"}), 400

        # Extract location data if provided
        location_data = data.get('location')
        client_time = data.get('client_time')
        timezone_str = data.get('timezone')

        # Normalize employee ID to canonical EMP### form for storage / lookups
        normalized_emp_id = employee_id_raw.upper()
        if normalized_emp_id.isdigit():
            normalized_emp_id = format_employee_id(int(normalized_emp_id))
        key = normalized_emp_id

        now = datetime.now()
        local_now = _coerce_client_local_datetime(client_time, timezone_str) or now

        # Log the check-in event with location
        event = log_login_event(normalized_emp_id, "check_in", request, location_data, client_time, timezone_str)
        _sync_login_activity_from_event(event)

        # If already checked in, return existing active session (idempotent)
        if key in active_sessions:
            session = active_sessions[key]
            print(f"[INFO] Duplicate check-in attempt for {key}, returning existing session")
            return jsonify({
                "success": True,
                "record_id": session.get("record_id"),
                "attendance_id": session.get("attendance_id"),
                "checkin_time": session.get("checkin_time"),
                "already_checked_in": True,
            })

        formatted_date = local_now.date().isoformat()
        formatted_time = local_now.strftime("%H:%M:%S")

        # Try to find an existing attendance record for this employee + date so that
        # we can continue the same day across multiple sessions instead of
        # creating new records.
        attendance_record = None
        try:
            token = get_access_token()
            headers = {
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "OData-MaxVersion": "4.0",
                "OData-Version": "4.0",
            }
            filter_query = (
                f"?$filter={FIELD_EMPLOYEE_ID} eq '{normalized_emp_id}' "
                f"and {FIELD_DATE} eq '{formatted_date}'"
            )
            url = f"{RESOURCE}/api/data/v9.2/{ATTENDANCE_ENTITY}{filter_query}"
            resp = requests.get(url, headers=headers, timeout=20)
            if resp.status_code == 200:
                vals = resp.json().get("value", [])
                if vals:
                    attendance_record = vals[0]
        except Exception as probe_err:
            print(f"[WARN] Failed to probe existing attendance record: {probe_err}")

        existing_hours = 0.0
        if attendance_record:
            # Reuse existing record for this date (continuation session)
            record_id = (
                attendance_record.get(FIELD_RECORD_ID)
                or attendance_record.get("cr6f_table13id")
                or attendance_record.get("id")
            )
            attendance_id = (
                attendance_record.get(FIELD_ATTENDANCE_ID_CUSTOM)
                or generate_random_attendance_id()
            )
            try:
                existing_hours = float(attendance_record.get(FIELD_DURATION) or "0")
            except Exception:
                existing_hours = 0.0
            # If we had to generate a new attendance ID for an existing record,
            # patch it back to Dataverse (best-effort).
            if attendance_id and not attendance_record.get(FIELD_ATTENDANCE_ID_CUSTOM):
                try:
                    update_record(ATTENDANCE_ENTITY, record_id, {FIELD_ATTENDANCE_ID_CUSTOM: attendance_id})
                except Exception:
                    pass

            active_sessions[key] = {
                "record_id": record_id,
                "checkin_time": formatted_time,
                "checkin_datetime": now.isoformat(),
                "attendance_id": attendance_id,
                "local_date": formatted_date,
            }

            print(f"[OK] CONTINUATION CHECK-IN for {key} on {formatted_date}, record {record_id}")
            return jsonify(
                {
                    "success": True,
                    "record_id": record_id,
                    "attendance_id": attendance_id,
                    "checkin_time": formatted_time,
                    "already_checked_in": False,
                    "continued_day": True,
                    "total_seconds_today": int(round(existing_hours * 3600)),
                }
            )

        # No record for today yet: create a fresh one
        random_attendance_id = generate_random_attendance_id()
        record_data = {
            FIELD_EMPLOYEE_ID: normalized_emp_id,
            FIELD_DATE: formatted_date,
            FIELD_CHECKIN: formatted_time,
            FIELD_ATTENDANCE_ID_CUSTOM: random_attendance_id,
        }

        print(f"\n{'='*60}")
        print("CHECK-IN REQUEST")
        print(f"{'='*60}")
        print(f"Employee: {normalized_emp_id}")
        print(f"Attendance ID: {random_attendance_id}")
        print(f"Date: {formatted_date}")
        print(f"Time: {formatted_time}")
        print("Sending to Dataverse...")

        created = create_record(ATTENDANCE_ENTITY, record_data)
        record_id = (
            created.get(FIELD_RECORD_ID)
            or created.get("cr6f_table13id")
            or created.get("id")
        )

        if record_id:
            active_sessions[key] = {
                "record_id": record_id,
                "checkin_time": formatted_time,
                "checkin_datetime": now.isoformat(),
                "attendance_id": random_attendance_id,
                "local_date": formatted_date,
            }

            print(f"[OK] SUCCESS! Record ID: {record_id}")
            print(f"{'='*60}\n")

            return jsonify(
                {
                    "success": True,
                    "record_id": record_id,
                    "attendance_id": random_attendance_id,
                    "checkin_time": formatted_time,
                    "total_seconds_today": 0,
                }
            )
        else:
            print("[ERROR] FAILED: No record ID returned")
            print(f"{'='*60}\n")
            return jsonify({"success": False, "error": "Failed to create record"}), 500
    except Exception as e:
        print(f"\n[ERROR] CHECK-IN ERROR: {str(e)}\n")
        return jsonify({"success": False, "error": str(e)}), 500

#  for reset password
def generate_reset_token(email):
    payload = {
        "email": email,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=30)  # 30 min validity
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)
def verify_reset_token(token):
    try:
        decoded = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return decoded["email"]
    except jwt.ExpiredSignatureError:
        return None
    except Exception:
        return None


def _normalize_access_level(value):
    level = (value or "").strip().upper()
    if level in ("L1", "L2", "L3"):
        return level
    return "L1"


@app.route("/api/login", methods=["POST"])
def login():
    try:
        data = request.get_json(force=True)
        username = data.get("username")
        password = data.get("password")

        if not username or not password:
            return jsonify({"status": "error", "message": "Username and password required"}), 400

        # Fetch Dataverse
        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0",
            "Accept": "application/json"
        }

        # -------------------------
        # FETCH USER RECORD
        # -------------------------
        try:
            record = _fetch_login_by_username(username, token, headers)
        except Exception as e:
            return jsonify({"status": "error", "message": f"Fetch error: {e}"}), 500

        # USER NOT FOUND
        if not record:
            return jsonify({"status": "failed", "message": "Invalid Username or Password"}), 401

        record_id = record.get("crc6f_hr_login_detailsid")
        status = record.get("crc6f_user_status", "Active")
        attempts = int(record.get("crc6f_loginattempts") or 0)
        stored_hash = record.get("crc6f_password") or ""
        access_level = _normalize_access_level(record.get("crc6f_accesslevel"))

        # -------------------------
        # CHECK ACCOUNT LOCKED
        # -------------------------
        if status.lower() == "locked":
            return jsonify({"status": "locked", "message": "Account locked"}), 403

        # -------------------------
        # PREPARE HASH VALUES
        # -------------------------
        default_password = os.getenv("DEFAULT_USER_PASSWORD", "Temp@123")
        hashed_default = _hash_password(default_password)
        hashed_input = _hash_password(password)

        # ======================================================
        # RULE 1: FIRST LOGIN (Username + Temp@123 MUST MATCH DATAVERSE)
        # ======================================================
        if password == default_password:
            if stored_hash == hashed_default:
                return jsonify({
                    "status": "first_login",
                    "username": username,
                    "message": "Default password detected. Create new password."
                }), 200
            else:
                return jsonify({
                    "status": "failed",
                    "message": "Invalid Username or Password"
                }), 401

        # ======================================================
        # RULE 2: NORMAL LOGIN
        # ======================================================
        if hashed_input == stored_hash:

            # Reset attempts
            payload = {
                "crc6f_last_login": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "crc6f_loginattempts": "0",
                "crc6f_user_status": "Active"
            }

            _update_login_record(record_id, payload, headers, token)

            # -------------------------
            # ACCESS LOGIC RESTORED
            # Fetch employee data from master
            # -------------------------
            employee_id_value = None
            employee_designation = None
            is_admin_flag = access_level == "L3"
            is_manager_flag = access_level in ("L2", "L3")

            try:
                entity_set = get_employee_entity_set(token)
                field_map = get_field_map(entity_set)

                email_field = field_map.get("email")
                id_field = field_map.get("id")
                desig_field = field_map.get("designation")

                if email_field and id_field:
                    safe_email = username.replace("'", "''")
                    select_cols = [id_field, email_field]
                    if desig_field:
                        select_cols.append(desig_field)

                    url_emp = (
                        f"{BASE_URL}/{entity_set}"
                        f"?$top=1&$select={','.join(select_cols)}"
                        f"&$filter={email_field} eq '{safe_email}'"
                    )

                    resp = requests.get(url_emp, headers=headers)
                    if resp.status_code == 200:
                        vals = resp.json().get("value", [])
                        if vals:
                            emp = vals[0]
                            employee_id_value = emp.get(id_field)
                            employee_designation = emp.get(desig_field)

                            designation_lower = (employee_designation or "").lower()
                            if "admin" in designation_lower:
                                is_admin_flag = True
                            if "manager" in designation_lower:
                                is_manager_flag = True

            except Exception as e:
                print("ACCESS LOGIC ERROR:", e)

            # SUCCESS LOGIN RESPONSE
            return jsonify({
                "status": "success",
                "message": f"Welcome, {record.get('crc6f_employeename')}",
                "user": {
                    "email": record.get("crc6f_username"),
                    "name": record.get("crc6f_employeename"),
                    "employee_id": employee_id_value,
                    "designation": employee_designation,
                    "access_level": access_level,
                    "role": access_level,
                    "is_admin": is_admin_flag,
                    "is_manager": is_manager_flag
                }
            }), 200

        # ======================================================
        # RULE 3: WRONG PASSWORD
        # ======================================================
        attempts += 1
        update_payload = {"crc6f_loginattempts": str(attempts)}

        admin_email = os.getenv("ADMIN_EMAIL")

        if attempts >= 3:
            update_payload["crc6f_user_status"] = "Locked"

            if admin_email:
                try:
                    send_email(
                        subject="🔒 Account Locked",
                        recipients=[admin_email],
                        body=f"User '{username}' locked after 3 failed attempts.",
                        html=f"<p>User <b>{username}</b> locked after <b>3 attempts</b>.</p>"
                    )
                except Exception as e:
                    print("Admin email failed:", e)

        _update_login_record(record_id, update_payload, headers, token)

        if attempts >= 3:
            return jsonify({
                "status": "locked",
                "message": "Account locked after 3 attempts"
            }), 403

        return jsonify({
            "status": "failed",
            "message": "Invalid Username or Password"
        }), 401

    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/forgot-password", methods=["POST"])
def forgot_password():
    """Password reset request handler with debug logging."""
    import sys
    print("[FORGOT-PWD] Handler started", flush=True)
    
    data = request.get_json(silent=True) or {}
    user_email = data.get("email")

    if not user_email:
        print("[FORGOT-PWD] No email provided", flush=True)
        return jsonify({"status": "error", "message": "Email required"}), 400

    print(f"[FORGOT-PWD] Processing request for: {user_email}", flush=True)

    try:
        # Step 1: Get access token (with timeout logging)
        print("[FORGOT-PWD] Step 1: Getting access token...", flush=True)
        access_token = get_access_token()
        if not access_token:
            print("[FORGOT-PWD] Failed to get access token", flush=True)
            return jsonify({"status": "error", "message": "Failed to obtain access token"}), 500
        print("[FORGOT-PWD] Access token obtained", flush=True)

        # Step 2: Lookup user in Dataverse
        print("[FORGOT-PWD] Step 2: Looking up user in Dataverse...", flush=True)
        url = f"{BASE_URL}/crc6f_hr_login_detailses?$filter=crc6f_username eq '{user_email}'"
        headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0",
            "Accept": "application/json"
        }

        res = requests.get(url, headers=headers, timeout=10)
        res.raise_for_status()
        result = res.json()
        print(f"[FORGOT-PWD] Dataverse lookup complete, found {len(result.get('value', []))} records", flush=True)

        if not result.get("value"):
            print(f"[FORGOT-PWD] Email not found: {user_email}", flush=True)
            return jsonify({"status": "error", "message": "Email not found"}), 404

        record = result["value"][0]
        record_id = record.get("crc6f_hr_login_detailsid")
        print(f"[FORGOT-PWD] Found user record: {record_id}", flush=True)

        # Step 3: Generate reset token
        print("[FORGOT-PWD] Step 3: Generating reset token...", flush=True)
        token = generate_reset_token(user_email)
        if not token:
            print("[FORGOT-PWD] Failed to generate token", flush=True)
            return jsonify({"status": "error", "message": "Failed to generate reset token"}), 500
        print("[FORGOT-PWD] Token generated", flush=True)

        # Step 4: Build reset link
        reset_link = f"{FRONTEND_BASE_URL}/create_new_password.html?token={token}"
        print(f"[FORGOT-PWD] Reset link: {reset_link}", flush=True)

        # Step 5: Send email (plain text only to avoid Brevo link tracking)
        print("[FORGOT-PWD] Step 5: Sending email...", flush=True)
        subject = "Reset Your Password - VTab Office Tool"
        text_body = f"""Hello,

You requested a password reset for your VTab Office Tool account.

Copy and paste this link into your browser to reset your password:

{reset_link}

This link expires in 28 minutes.

If you did not request this, please ignore this message.

- VTab Office Tool Team"""

        sent = False
        try:
            # Send plain text only (no HTML) to prevent Brevo from tracking/wrapping links
            sent = send_email(subject=subject, recipients=[user_email], body=text_body, html=None)
            print(f"[FORGOT-PWD] send_email returned: {sent}", flush=True)
        except Exception as mail_err:
            print(f"[FORGOT-PWD] Email send exception: {mail_err}", flush=True)
            traceback.print_exc()

        if not sent:
            print("[FORGOT-PWD] Email not sent", flush=True)
            return jsonify({"status": "error", "message": "Failed to send reset email"}), 500

        print("[FORGOT-PWD] Success - email sent", flush=True)
        return jsonify({"status": "success", "message": "Reset email sent"}), 200

    except requests.Timeout:
        print("[FORGOT-PWD] Request timeout (Dataverse)", flush=True)
        return jsonify({"status": "error", "message": "Request timeout"}), 504
    except requests.HTTPError as e:
        print(f"[FORGOT-PWD] HTTP error: {e}", flush=True)
        traceback.print_exc()
        return jsonify({"status": "error", "message": "Upstream API error", "detail": str(e)}), 502
    except Exception as e:
        print(f"[FORGOT-PWD] Unexpected error: {e}", flush=True)
        traceback.print_exc()
        return jsonify({"status": "error", "message": "Internal server error"}), 500


@app.route("/api/reset-password", methods=["POST"])
def reset_password():
    data = request.get_json(silent=True) or {}

    token = data.get("token")         # forgot password flow
    username = data.get("username")   # first-login flow
    new_password = data.get("new_password")

    # --------------------------------------------
    # Validate required fields
    # --------------------------------------------
    if not new_password:
        return jsonify({
            "status": "error",
            "message": "Missing new_password"
        }), 400

    # ========================================================
    # CASE 1 —— FORGOT PASSWORD (Token based)
    # ========================================================
    if token:
        email = verify_reset_token(token)

        if not email:
            return jsonify({
                "status": "error",
                "message": "Invalid or expired link."
            }), 401

        lookup_email = email

    # ========================================================
    # CASE 2 —— FIRST LOGIN (Username based)
    # ========================================================
    elif username:
        lookup_email = username

    else:
        return jsonify({
            "status": "error",
            "message": "Invalid request. Missing token or username."
        }), 400

    try:
        # --------------------------------------------
        # Get Dataverse Access Token
        # --------------------------------------------
        access_token = get_access_token()
        if not access_token:
            return jsonify({
                "status": "error",
                "message": "Failed to obtain access token"
            }), 500

        headers = {
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "OData-Version": "4.0",
            "OData-MaxVersion": "4.0"
        }

        # --------------------------------------------
        # Lookup Login Row using crc6f_username
        # --------------------------------------------
        lookup_url = (
            f"{BASE_URL}/crc6f_hr_login_detailses"
            f"?$filter=crc6f_username eq '{lookup_email}'"
        )

        res = requests.get(lookup_url, headers=headers, timeout=15)
        res.raise_for_status()
        result = res.json()

        if not result.get("value"):
            return jsonify({
                "status": "error",
                "message": "User not found"
            }), 404

        record = result["value"][0]
        record_id = record.get("crc6f_hr_login_detailsid")

        if not record_id:
            return jsonify({
                "status": "error",
                "message": "User record id missing"
            }), 500

        record_id = record_id.replace("{", "").replace("}", "")

        # --------------------------------------------
        # Hash the NEW password
        # --------------------------------------------
        hashed_password = _hash_password(new_password)

        patch_url = f"{BASE_URL}/crc6f_hr_login_detailses({record_id})"

        patch_body = {
            "crc6f_password": hashed_password,
            "crc6f_loginattempts": "0"   # reset attempts
        }

        patch_headers = dict(headers)
        patch_headers["If-Match"] = "*"

        patch_res = requests.patch(
            patch_url,
            headers=patch_headers,
            json=patch_body,
            timeout=15
        )

        # Debug Log
        print("\n----- PATCH Debug -----")
        print("PATCH URL:", patch_url)
        print("PATCH Body:", patch_body)
        print("PATCH Status:", patch_res.status_code)
        print("PATCH Response:", patch_res.text)
        print("-----------------------\n")

        if patch_res.status_code not in (200, 204):
            return jsonify({
                "status": "error",
                "message": "Password update failed",
                "detail": patch_res.text
            }), 400

        return jsonify({
            "status": "success",
            "message": "Password updated"
        }), 200

    except requests.HTTPError as e:
        traceback.print_exc()
        return jsonify({
            "status": "error",
            "message": "Dataverse API error",
            "detail": str(e)
        }), 502

    except Exception as ex:
        traceback.print_exc()
        return jsonify({
            "status": "error",
            "message": "Internal server error",
            "detail": str(ex)
        }), 500

@app.route("/api/reset-attempts", methods=["POST"])
def reset_attempts():
    data = request.get_json()
    username = data.get("username")

    token = get_access_token()
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }

    record = _fetch_login_by_username(username, token, headers)
    if not record:
        return jsonify({"status": "error", "message": "User not found"}), 404

    record_id = record.get("crc6f_hr_login_detailsid")

    _update_login_record(record_id, {
        "crc6f_attempts": 0,
        "crc6f_locked": False
    }, headers, token)

    return jsonify({"status": "success", "message": "Attempts reset"})

@app.route("/api/login-accounts", methods=["GET"])
def list_login_accounts():
    try:
        token = get_access_token()
        login_table = get_login_table(token)
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0",
        }
        select = (
            "$select=crc6f_hr_login_detailsid,crc6f_username,crc6f_employeename,"
            "crc6f_accesslevel,crc6f_last_login,crc6f_loginattempts,crc6f_user_status,crc6f_userid"
        )
        url = f"{BASE_URL}/{login_table}?{select}&$top=5000"
        resp = requests.get(url, headers=headers)
        if resp.status_code != 200:
            return jsonify({
                "success": False,
                "error": "Failed to fetch login accounts",
                "details": resp.text,
            }), 500
        records = resp.json().get("value", [])
        items = []
        for r in records:
            record_id = r.get("crc6f_hr_login_detailsid") or r.get("id")
            if not record_id:
                continue
            items.append({
                "id": record_id,
                "username": r.get("crc6f_username") or "",
                "employeeName": r.get("crc6f_employeename") or "",
                "accessLevel": r.get("crc6f_accesslevel") or "",
                "lastLogin": r.get("crc6f_last_login"),
                "loginAttempts": int(r.get("crc6f_loginattempts") or 0),
                "userStatus": r.get("crc6f_user_status") or "",
                "userId": r.get("crc6f_userid") or "",
            })
        return jsonify({"success": True, "items": items, "count": len(items)})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/login-accounts/by-username", methods=["GET"])
def get_login_account_by_username():
    username = request.args.get("username", "").strip()
    if not username:
        return jsonify({"success": False, "error": "username query param is required"}), 400
    try:
        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0",
        }
        record = _fetch_login_by_username(username, token, headers)
        if not record:
            return jsonify({"success": False, "error": "Login account not found"}), 404
        item = {
            "id": record.get("crc6f_hr_login_detailsid") or record.get("id"),
            "username": record.get("crc6f_username") or "",
            "employeeName": record.get("crc6f_employeename") or "",
            "accessLevel": _normalize_access_level(record.get("crc6f_accesslevel")),
            "lastLogin": record.get("crc6f_last_login"),
            "loginAttempts": int(record.get("crc6f_loginattempts") or 0),
            "userStatus": record.get("crc6f_user_status") or "",
        }
        return jsonify({"success": True, "item": item})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/login-accounts", methods=["POST"])
def create_login_account():
    try:
        data = request.get_json(force=True) or {}
        username = (data.get("username") or "").strip()

        if not username:
            return jsonify({"success": False, "error": "Username is required"}), 400
        token = get_access_token()
        login_table = get_login_table(token)
        employee_name = (data.get("employee_name") or "").strip()
        access_level = (data.get("access_level") or "").strip() or "L1"
        user_status = (data.get("user_status") or "").strip() or "Active"
        login_attempts_raw = data.get("login_attempts")
        last_login = data.get("last_login")
        try:
            login_attempts_int = int(login_attempts_raw)
        except Exception:
            login_attempts_int = 0
        default_password = os.getenv("DEFAULT_USER_PASSWORD", "Temp@123")
        hashed_password = _hash_password(default_password)
        payload = {
            "crc6f_username": username,
            "crc6f_password": hashed_password,
            "crc6f_employeename": employee_name,
            "crc6f_accesslevel": access_level,
            "crc6f_user_status": user_status,
            "crc6f_loginattempts": str(login_attempts_int),
        }
        if last_login:
            payload["crc6f_last_login"] = last_login
        user_id_value = data.get("user_id")
        if user_id_value:
            payload["crc6f_userid"] = str(user_id_value)
        created = create_record(login_table, payload)
        record_id = created.get("crc6f_hr_login_detailsid") or created.get("id")
        item = {
            "id": record_id,
            "username": created.get("crc6f_username") or username,
            "employeeName": created.get("crc6f_employeename") or employee_name,
            "accessLevel": created.get("crc6f_accesslevel") or access_level,
            "lastLogin": created.get("crc6f_last_login") or last_login,
            "loginAttempts": int(created.get("crc6f_loginattempts") or login_attempts_int),
            "userStatus": created.get("crc6f_user_status") or user_status,
            "userId": created.get("crc6f_userid") or user_id_value or "",
        }
        return jsonify({"success": True, "item": item}), 201
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/login-accounts/<login_id>", methods=["PUT"])
def update_login_account(login_id):
    try:
        data = request.get_json(force=True) or {}
        token = get_access_token()
        login_table = get_login_table(token)
        record_id = (login_id or "").strip("{}")
        payload = {}
        if "username" in data:
            payload["crc6f_username"] = (data.get("username") or "").strip()
        if "employee_name" in data:
            payload["crc6f_employeename"] = (data.get("employee_name") or "").strip()
        if "access_level" in data:
            payload["crc6f_accesslevel"] = (data.get("access_level") or "").strip()
        if "user_status" in data:
            payload["crc6f_user_status"] = (data.get("user_status") or "").strip()
        if "last_login" in data:
            last_login = data.get("last_login")
            if last_login:
                payload["crc6f_last_login"] = last_login
            else:
                payload["crc6f_last_login"] = None
        if "login_attempts" in data:
            try:
                attempts_int = int(data.get("login_attempts"))
            except Exception:
                attempts_int = 0
            payload["crc6f_loginattempts"] = str(attempts_int)
        if "user_id" in data:
            payload["crc6f_userid"] = str(data.get("user_id") or "")
        if not payload:
            return jsonify({"success": False, "error": "No fields to update"}), 400
        update_record(login_table, record_id, payload)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/login-accounts/<login_id>", methods=["DELETE"])
def delete_login_account(login_id):
    try:
        token = get_access_token()
        login_table = get_login_table(token)
        record_id = (login_id or "").strip("{}")
        delete_record(login_table, record_id)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# # ================== LOGIN ROUTE ==================
# @app.route("/api/login", methods=["POST"])
# def login():
#     try:
#         data = request.get_json(force=True)
#         username = data.get("username")
#         password = data.get("password")
#         if not username or not password:
#             return jsonify({"status": "error", "message": "Username and password required"}), 400

#         token = get_access_token()
#         headers = {
#             "Authorization": f"Bearer {token}",
#             "Content-Type": "application/json",
#             "OData-MaxVersion": "4.0",
#             "OData-Version": "4.0",
#             "Accept": "application/json"
#         }

#         try:
#             record = _fetch_login_by_username(username, token, headers)
#         except Exception as e:
#             return jsonify({"status": "error", "message": f"Failed to fetch record: {e}"}), 500

#         if not record:
#             # Auto-provision on first login attempt if employee exists and password is default
#             try:
#                 default_password = os.getenv("DEFAULT_USER_PASSWORD", "Temp@123")
#                 if password == default_password:
#                     # Try resolve employee by email (robust across alternate columns)
#                     entity_set = get_employee_entity_set(token)
#                     field_map = get_field_map(entity_set)
#                     email_field = field_map.get('email')
#                     id_field = field_map.get('id')
#                     desig_field = field_map.get('designation')
#                     email_alts = ['crc6f_officialemail', 'crc6f_emailaddress', 'emailaddress', 'officialemail', 'crc6f_mail', 'crc6f_quotahours']
#                     # Attempt direct match first (if primary field present)
#                     safe_email = (username or '').replace("'", "''")
#                     select_parts = [p for p in [id_field, email_field, desig_field] if p]
#                     # add alternates to $select so we can scan
#                     for alt in email_alts:
#                         if alt and alt not in select_parts:
#                             select_parts.append(alt)
#                     url_emp = f"{BASE_URL}/{entity_set}?$top=5&$select={','.join(select_parts)}&$filter={email_field} eq '{safe_email}'" if email_field else None
#                     emp_row = None
#                     if url_emp:
#                         r1 = requests.get(url_emp, headers=headers)
#                         if r1.status_code == 200:
#                             vals = r1.json().get('value', [])
#                             if vals:
#                                 emp_row = vals[0]
#                     # Fallback: fetch a page and scan all possible email fields case-insensitively
#                     if not emp_row and id_field:
#                         url_scan = f"{BASE_URL}/{entity_set}?$top=200&$select={','.join(select_parts)}"
#                         r2 = requests.get(url_scan, headers=headers)
#                         if r2.status_code == 200:
#                             want = (username or '').strip().lower()
#                             for rec in r2.json().get('value', []):
#                                 candidates = []
#                                 if email_field:
#                                     candidates.append(rec.get(email_field))
#                                 for alt in email_alts:
#                                     candidates.append(rec.get(alt))
#                                 # fall back: scan any email-like value
#                                 found_match = False
#                                 for v in candidates:
#                                     if isinstance(v, str) and v.strip().lower() == want:
#                                         found_match = True
#                                         break
#                                 if not found_match:
#                                     for k, v in rec.items():
#                                         if isinstance(v, str) and '@' in v and '.' in v and v.strip().lower() == want:
#                                             found_match = True
#                                             break
#                                 if found_match:
#                                     emp_row = rec
#                                     break
#                     if emp_row:
#                         # Create login
#                         hashed = _hash_password(default_password)
#                         login_payload = {
#                             "crc6f_username": username.strip().lower(),
#                             "crc6f_password": hashed,
#                             "crc6f_user_status": "Active",
#                             "crc6f_loginattempts": "0",
#                             "crc6f_employeename": username
#                         }
#                         try:
#                             login_table = get_login_table(token)
#                             create_record(login_table, login_payload)
#                         except Exception:
#                             pass
#                         # Treat as success login now
#                         employee_id_value = emp_row.get(id_field)
#                         employee_designation = emp_row.get(desig_field) if desig_field else None
#                         is_admin = False
#                         try:
#                             dv = str(employee_designation or '').lower()
#                             if any(k in dv for k in ['admin', 'manager']):
#                                 is_admin = True
#                         except Exception:
#                             is_admin = False
#                         return jsonify({
#                             "status": "success",
#                             "message": f"Welcome, {username}",
#                             "last_login": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
#                             "login_attempts": 0,
#                             "user_status": "Active",
#                             "user": {
#                                 "email": username,
#                                 "name": username,
#                                 "employee_id": employee_id_value,
#                                 "designation": employee_designation,
#                                 "is_admin": is_admin
#                             }
#                         }), 200
#             except Exception:
#                 pass
#             return jsonify({"status": "failed", "message": "Invalid Username or Password"}), 401

#         record_id = record.get("crc6f_hr_login_detailsid") or record.get("id")
#         status = (record.get("crc6f_user_status") or "Active")
#         attempts = int(record.get("crc6f_loginattempts") or 0)
#         stored_hash = record.get("crc6f_password") or ""

#         if status and str(status).lower() == "locked":
#             return jsonify({"status": "locked", "message": "Account is locked due to too many failed attempts."}), 403

#         hashed_input = _hash_password(password)
#         default_pw = os.getenv("DEFAULT_USER_PASSWORD", "Temp@123")
#         old_default_pw = "Welcome@123"

#         if hashed_input == stored_hash or (_hash_password(default_pw) == stored_hash and password == default_pw):
#             # Success: reset attempts and set last login
#             payload = {
#                 "crc6f_last_login": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
#                 "crc6f_loginattempts": "0",
#                 "crc6f_user_status": "Active"
#             }
#             try:
#                 _update_login_record(record_id, payload, headers, token)
#             except Exception as e:
#                 return jsonify({"status": "error", "message": f"Failed to update last login: {e}"}), 500
#             # Resolve canonical employee_id and designation from Employee master using username/email
#             employee_id_value = None
#             employee_designation = None
#             try:
#                 entity_set = get_employee_entity_set(token)
#                 field_map = get_field_map(entity_set)
#                 email_field = field_map.get('email')
#                 id_field = field_map.get('id')
#                 desig_field = field_map.get('designation')
#                 if email_field and id_field:
#                     # Escape single quotes in username for OData filter
#                     safe_email = (username or '').replace("'", "''")
#                     select_parts = [id_field, email_field]
#                     if desig_field:
#                         select_parts.append(desig_field)
#                     url_emp = f"{BASE_URL}/{entity_set}?$top=1&$select={','.join(select_parts)}&$filter={email_field} eq '{safe_email}'"
#                     resp_emp = requests.get(url_emp, headers={
#                         "Authorization": f"Bearer {token}",
#                         "Accept": "application/json",
#                     })
#                     if resp_emp.status_code == 200:
#                         vals = resp_emp.json().get('value', [])
#                         if vals:
#                             row = vals[0]
#                             employee_id_value = row.get(id_field)
#                             employee_designation = row.get(desig_field) if desig_field else None
#             except Exception as e:
#                 print(f"[WARN] Failed to resolve employee_id from username: {e}")
#             # Determine admin flag from designation keywords
#             is_admin = False
#             try:
#                 desig_val = str(employee_designation or '').lower()
#                 if any(k in desig_val for k in ['admin', 'manager']):
#                     is_admin = True
#             except Exception:
#                 is_admin = False

#             return jsonify({
#                 "status": "success",
#                 "message": f"Welcome, {record.get('crc6f_employeename')}",
#                 "last_login": payload["crc6f_last_login"],
#                 "login_attempts": 0,
#                 "user_status": "Active",
#                 # Minimal user payload for frontend session
#                 "user": {
#                     "email": record.get("crc6f_username"),
#                     "name": record.get("crc6f_employeename"),
#                     "employee_id": employee_id_value,
#                     "designation": employee_designation,
#                     "is_admin": is_admin
#                 }
#             }), 200
#         elif _hash_password(old_default_pw) == stored_hash and password == default_pw:
#             # Migrate old default to new default on the fly and login
#             try:
#                 _update_login_record(record_id, {"crc6f_password": _hash_password(default_pw), "crc6f_loginattempts": "0"}, headers, token)
#             except Exception:
#                 pass
#             return jsonify({
#                 "status": "success",
#                 "message": f"Welcome, {record.get('crc6f_employeename')}",
#                 "last_login": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
#                 "login_attempts": 0,
#                 "user_status": "Active",
#                 "user": {
#                     "email": record.get("crc6f_username"),
#                     "name": record.get("crc6f_employeename"),
#                     "employee_id": employee_id_value,
#                     "designation": employee_designation,
#                     "is_admin": is_admin
#                 }
#             }), 200
#         else:
#             attempts += 1
#             payload = {"crc6f_loginattempts": str(attempts)}
#             if attempts >= 3:
#                 payload["crc6f_user_status"] = "Locked"
#             try:
#                 _update_login_record(record_id, payload, headers, token)
#             except Exception as e:
#                 return jsonify({"status": "error", "message": f"Failed to update login attempts/status: {e}"}), 500
#             if attempts >= 3:
#                 return jsonify({
#                     "status": "locked",
#                     "message": "Maximum attempts reached. Your account is now locked.",
#                     "login_attempts": attempts
#                 }), 403
#             else:
#                 return jsonify({
#                     "status": "failed",
#                     "message": "Invalid Username or Password",
#                     "login_attempts": attempts
#                 }), 401
#     except Exception as e:
#         return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/checkout', methods=['POST'])
def checkout():
    """Check-out: closes the current session and aggregates duration for the day.

    This endpoint updates the Dataverse attendance record for the employee and
    current date by *adding* this session's duration to any existing duration in
    `FIELD_DURATION`. It returns both the human readable duration and the
    total seconds worked today so the frontend timer can resume accurately.
    """
    try:
        data = request.json or {}
        employee_id_raw = (data.get('employee_id') or '').strip()
        if not employee_id_raw:
            return jsonify({"success": False, "error": "Employee ID is required"}), 400

        # Extract location data if provided
        location_data = data.get('location')
        client_time = data.get('client_time')
        timezone_str = data.get('timezone')

        # Normalize employee ID (must match what we used at check-in)
        normalized_emp_id = employee_id_raw.upper()
        if normalized_emp_id.isdigit():
            normalized_emp_id = format_employee_id(int(normalized_emp_id))
        key = normalized_emp_id

        # Verify this employee has an active check-in
        session = active_sessions.get(key)
        if not session:
            return jsonify({
                "success": False,
                "error": "No active check-in found. Please check in first.",
            }), 400

        # Use client time if available
        local_now = _coerce_client_local_datetime(client_time, timezone_str) or datetime.now()
        checkout_time_str = local_now.strftime("%H:%M:%S")

        # Log the check-out event with location
        event = log_login_event(normalized_emp_id, "check_out", request, location_data, client_time, timezone_str)
        _sync_login_activity_from_event(event)

        # If no in-memory session, try to recover from Dataverse
        # This handles server restarts where active_sessions is cleared
        if not session:
            try:
                formatted_date = now.date().isoformat()
                token = get_access_token()
                headers = {
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/json",
                    "OData-MaxVersion": "4.0",
                    "OData-Version": "4.0",
                }
                filter_query = (
                    f"?$filter={FIELD_EMPLOYEE_ID} eq '{normalized_emp_id}' "
                    f"and {FIELD_DATE} eq '{formatted_date}'"
                )
                url = f"{RESOURCE}/api/data/v9.2/{ATTENDANCE_ENTITY}{filter_query}"
                resp = requests.get(url, headers=headers, timeout=20)
                if resp.status_code == 200:
                    vals = resp.json().get("value", [])
                    if vals:
                        rec = vals[0]
                        checkin_time = rec.get(FIELD_CHECKIN)
                        checkout_time = rec.get(FIELD_CHECKOUT)
                        # If there's a check-in but no checkout, recover the session
                        if checkin_time and not checkout_time:
                            record_id = (
                                rec.get(FIELD_RECORD_ID)
                                or rec.get("cr6f_table13id")
                                or rec.get("id")
                            )
                            # Reconstruct checkin datetime from today's date + checkin time
                            try:
                                checkin_dt = datetime.strptime(checkin_time, "%H:%M:%S").replace(
                                    year=now.year, month=now.month, day=now.day
                                )
                            except:
                                checkin_dt = now  # Fallback
                            session = {
                                "record_id": record_id,
                                "checkin_time": checkin_time,
                                "checkin_datetime": checkin_dt.isoformat(),
                                "attendance_id": rec.get(FIELD_ATTENDANCE_ID_CUSTOM),
                                "recovered": True,
                            }
                            active_sessions[key] = session
                            print(f"[INFO] Recovered session from Dataverse for {key}")
            except Exception as recover_err:
                print(f"[WARN] Failed to recover session from Dataverse: {recover_err}")
        
        if not session:
            return jsonify({
                "success": False,
                "error": "No active check-in found. Please check in first.",
            }), 400

        # Calculate session duration in seconds
        try:
            if "checkin_datetime" in session:
                checkin_dt = datetime.fromisoformat(session["checkin_datetime"])
                session_seconds = int((local_now - checkin_dt).total_seconds())
            elif "checkin_time" in session:
                # Fallback for older sessions without datetime
                checkin_time_str = session["checkin_time"]
                checkin_dt = datetime.strptime(checkin_time_str, "%H:%M:%S").replace(
                    year=local_now.year, month=local_now.month, day=local_now.day
                )
                session_seconds = int((local_now - checkin_dt).total_seconds())
            else:
                session_seconds = 0
        except Exception as time_err:
            print(f"[WARN] Error calculating session duration: {time_err}")
            session_seconds = 0

        if session_seconds < 0:
            session_seconds = 0

        # Fetch today's attendance record to aggregate previous sessions
        attendance_record = None
        record_id = session.get("record_id")
        try:
            token = get_access_token()
            headers = {
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "OData-MaxVersion": "4.0",
                "OData-Version": "4.0",
            }
            if record_id:
                # First try direct lookup by record id
                url = f"{RESOURCE}/api/data/v9.2/{ATTENDANCE_ENTITY}({record_id})"
                resp = requests.get(url, headers=headers, timeout=20)
                if resp.status_code == 200:
                    attendance_record = resp.json()
            if not attendance_record:
                # Fallback: search by employee + date
                formatted_date = now.date().isoformat()
                filter_query = (
                    f"?$filter={FIELD_EMPLOYEE_ID} eq '{normalized_emp_id}' "
                    f"and {FIELD_DATE} eq '{formatted_date}'"
                )
                url = f"{RESOURCE}/api/data/v9.2/{ATTENDANCE_ENTITY}{filter_query}"
                resp2 = requests.get(url, headers=headers, timeout=20)
                if resp2.status_code == 200:
                    vals = resp2.json().get("value", [])
                    if vals:
                        attendance_record = vals[0]
                        record_id = (
                            attendance_record.get(FIELD_RECORD_ID)
                            or attendance_record.get("cr6f_table13id")
                            or attendance_record.get("id")
                        )
        except Exception as fetch_err:
            print(f"[WARN] Failed to fetch attendance record on checkout: {fetch_err}")

        existing_hours = 0.0
        if attendance_record:
            try:
                existing_hours = float(attendance_record.get(FIELD_DURATION) or "0")
            except Exception:
                existing_hours = 0.0

        # Aggregate: previous hours + this session's hours
        session_hours = session_seconds / 3600.0
        total_hours_today = existing_hours + session_hours
        total_seconds_today = int(round(total_hours_today * 3600))

        # Classification based on total hours today
        if total_hours_today >= 9.0:
            status = "P"
        elif total_hours_today >= 4.0:
            status = "HL"
        else:
            status = "A"

        # Human-readable duration from aggregated seconds
        hours_int = total_seconds_today // 3600
        minutes_int = (total_seconds_today % 3600) // 60
        readable_duration = f"{hours_int} hour(s) {minutes_int} minute(s)"

        update_data = {
            FIELD_CHECKOUT: checkout_time_str,
            FIELD_DURATION: str(round(total_hours_today, 2)),
            FIELD_DURATION_INTEXT: readable_duration,
        }

        print(f"\n{'='*60}")
        print("CHECK-OUT REQUEST")
        print(f"{'='*60}")
        print(f"Employee: {normalized_emp_id}")
        print(f"Record ID: {record_id}")
        print(f"Session seconds: {session_seconds}")
        print(f"Total hours today (agg): {total_hours_today}")
        print(f"Check-out: {checkout_time_str}")
        print(f"Duration (display): {readable_duration}")
        print("Updating Dataverse...")

        if record_id:
            update_record(ATTENDANCE_ENTITY, record_id, update_data)
        else:
            print("[WARN] No record_id found to update on checkout")

        # Clear in-memory active session
        try:
            if key in active_sessions:
                del active_sessions[key]
        except Exception:
            pass

        print("[OK] CHECK-OUT SUCCESS!")
        print(f"{'='*60}\n")

        return jsonify(
            {
                "success": True,
                "checkout_time": checkout_time_str,
                "duration": readable_duration,
                "total_hours": total_hours_today,
                "total_seconds_today": total_seconds_today,
                "status": status,
            }
        )
    except Exception as e:
        print(f"\n[ERROR] CHECK-OUT ERROR: {str(e)}\n")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/status/<employee_id>', methods=['GET'])
def get_status(employee_id):
    """Return current attendance timer state for the employee.

    Includes:
    - checked_in: whether there's an active in-memory session
    - elapsed_seconds: seconds in the current active session (0 if none)
    - total_seconds_today: aggregated seconds for today (Dataverse duration + active)
    - status: provisional P / HL / A based on total hours so far
    """
    try:
        emp_raw = (employee_id or '').strip()
        if not emp_raw:
            return jsonify({"checked_in": False}), 400

        normalized_emp_id = emp_raw.upper()
        if normalized_emp_id.isdigit():
            normalized_emp_id = format_employee_id(int(normalized_emp_id))
        key = normalized_emp_id

        # Try to recover session from Dataverse if not in memory
        # This handles server restarts
        if key not in active_sessions:
            try:
                from datetime import date as _date
                formatted_date = _date.today().isoformat()
                now = datetime.now()
                token = get_access_token()
                headers = {
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/json",
                    "OData-MaxVersion": "4.0",
                    "OData-Version": "4.0",
                }
                filter_query = (
                    f"?$filter={FIELD_EMPLOYEE_ID} eq '{normalized_emp_id}' "
                    f"and {FIELD_DATE} eq '{formatted_date}'"
                )
                url = f"{RESOURCE}/api/data/v9.2/{ATTENDANCE_ENTITY}{filter_query}"
                resp = requests.get(url, headers=headers, timeout=20)
                if resp.status_code == 200:
                    vals = resp.json().get("value", [])
                    if vals:
                        rec = vals[0]
                        checkin_time_rec = rec.get(FIELD_CHECKIN)
                        checkout_time_rec = rec.get(FIELD_CHECKOUT)
                        # If there's a check-in but no checkout, recover the session
                        if checkin_time_rec and not checkout_time_rec:
                            record_id = (
                                rec.get(FIELD_RECORD_ID)
                                or rec.get("cr6f_table13id")
                                or rec.get("id")
                            )
                            try:
                                checkin_dt = datetime.strptime(checkin_time_rec, "%H:%M:%S").replace(
                                    year=now.year, month=now.month, day=now.day
                                )
                            except:
                                checkin_dt = now
                            active_sessions[key] = {
                                "record_id": record_id,
                                "checkin_time": checkin_time_rec,
                                "checkin_datetime": checkin_dt.isoformat(),
                                "attendance_id": rec.get(FIELD_ATTENDANCE_ID_CUSTOM),
                                "recovered": True,
                            }
                            print(f"[INFO] Recovered session from Dataverse for status check: {key}")
            except Exception as recover_err:
                print(f"[WARN] Failed to recover session in status: {recover_err}")

        active = key in active_sessions
        elapsed = 0
        checkin_time = None
        attendance_id = None
        if active:
            try:
                session = active_sessions[key]
                checkin_time = session.get("checkin_time")
                attendance_id = session.get("attendance_id")
                checkin_dt = datetime.fromisoformat(session["checkin_datetime"])
                elapsed = int((datetime.now() - checkin_dt).total_seconds())
                if elapsed < 0:
                    elapsed = 0
            except Exception as e:
                print(f"[WARN] Failed to compute elapsed for status: {e}")
                elapsed = 0

        # Base seconds from today's Dataverse record
        total_seconds_today = 0
        try:
            from datetime import date as _date
            formatted_date = _date.today().isoformat()
            token = get_access_token()
            headers = {
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "OData-MaxVersion": "4.0",
                "OData-Version": "4.0",
            }
            filter_query = (
                f"?$filter={FIELD_EMPLOYEE_ID} eq '{normalized_emp_id}' "
                f"and {FIELD_DATE} eq '{formatted_date}'"
            )
            url = f"{RESOURCE}/api/data/v9.2/{ATTENDANCE_ENTITY}{filter_query}"
            resp = requests.get(url, headers=headers, timeout=20)
            if resp.status_code == 200:
                vals = resp.json().get("value", [])
                if vals:
                    rec = vals[0]
                    try:
                        hours = float(rec.get(FIELD_DURATION) or "0")
                    except Exception:
                        hours = 0.0
                    total_seconds_today = int(round(hours * 3600))
        except Exception as fetch_err:
            print(f"[WARN] Failed to fetch today's attendance in status: {fetch_err}")

        if active:
            total_seconds_today += max(0, elapsed)

        # Classification from total seconds today
        total_hours_today = total_seconds_today / 3600.0
        if total_hours_today >= 9.0:
            status = "P"
        elif total_hours_today >= 4.0:
            status = "HL"
        else:
            status = "A"

        return jsonify({
            "checked_in": active,
            "checkin_time": checkin_time,
            "attendance_id": attendance_id,
            "elapsed_seconds": elapsed,
            "total_seconds_today": total_seconds_today,
            "status": status,
        })
    except Exception as e:
        print(f"[ERROR] status error: {e}")
        return jsonify({"checked_in": False, "error": str(e)}), 500


@app.route('/api/attendance/<employee_id>/<int:year>/<int:month>', methods=['GET'])
def get_monthly_attendance(employee_id, year, month):
    """Get attendance records for a specific month with status classification"""
    try:
        print(f"\n{'='*70}")
        print(f"[SEARCH] FETCHING ATTENDANCE FOR EMPLOYEE: {employee_id}, {year}-{month:02d}")
        print(f"{'='*70}")
        
        token = get_access_token()
        
        _, last_day = monthrange(year, month)
        start_date = f"{year}-{str(month).zfill(2)}-01"
        end_date = f"{year}-{str(month).zfill(2)}-{str(last_day).zfill(2)}"
        
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0"
        }
        
        # Normalize employee ID format
        normalized_emp_id = employee_id.upper().strip()
        if normalized_emp_id.isdigit():
            normalized_emp_id = format_employee_id(int(normalized_emp_id))
        
        print(f"   [USER] Normalized Employee ID: {normalized_emp_id}")
        print(f"   [DATE] Date Range: {start_date} to {end_date}")
        
        filter_query = (f"?$filter={FIELD_EMPLOYEE_ID} eq '{normalized_emp_id}' "
                       f"and {FIELD_DATE} ge '{start_date}' "
                       f"and {FIELD_DATE} le '{end_date}'")
        
        url = f"{RESOURCE}/api/data/v9.2/{ATTENDANCE_ENTITY}{filter_query}"
        
        print(f"   [URL] Sending request to Dataverse: {url}")
        response = requests.get(url, headers=headers)
        
        if response.status_code != 200:
            print(f"[ERROR] Dataverse fetch failed: {response.status_code} {response.text}")
            return jsonify({"success": False, "error": "Failed to fetch records"}), 500
        
        records = response.json().get("value", [])
        print(f"   [DATA] Found {len(records)} attendance records")
        
        # If no records found, try case-insensitive search
        if len(records) == 0:
            print(f"[SEARCH] No attendance found for {normalized_emp_id}, trying case-insensitive search...")
            try:
                # Try different case variations
                variations = [
                    normalized_emp_id.lower(),
                    normalized_emp_id.title(),
                    employee_id  # original case
                ]
                
                for variation in variations:
                    if variation != normalized_emp_id:
                        filter_query = (f"?$filter={FIELD_EMPLOYEE_ID} eq '{variation}' "
                                       f"and {FIELD_DATE} ge '{start_date}' "
                                       f"and {FIELD_DATE} le '{end_date}'")
                        url = f"{RESOURCE}/api/data/v9.2/{ATTENDANCE_ENTITY}{filter_query}"
                        response = requests.get(url, headers=headers)
                        
                        if response.status_code == 200:
                            records = response.json().get("value", [])
                            if records:
                                print(f"[OK] Found {len(records)} records with variation: {variation}")
                                break
            except Exception as e:
                print(f"[WARN] Case-insensitive search failed: {str(e)}")
        
        formatted_records = []
        
        for r in records:
            date_str = r.get(FIELD_DATE)
            checkin = r.get(FIELD_CHECKIN)
            checkout = r.get(FIELD_CHECKOUT)
            duration_str = r.get(FIELD_DURATION) or "0"
            
            try:
                duration_hours = float(duration_str)
            except ValueError:
                duration_hours = 0

            # Overlay live timer if employee is still checked in for that date
            live_hours = 0.0
            if date_str:
                live_hours = _live_session_progress_hours(normalized_emp_id, date_str)
            augmented_hours = duration_hours + max(0.0, live_hours)
            effective_hours = augmented_hours if augmented_hours > duration_hours else duration_hours

            # Attendance classification based on hours (post overlay)
            if effective_hours >= 9:
                status = "P"  # Present
            elif 4 <= effective_hours < 9:
                status = "HL"  # Half Day (>=4h and <9h)
            else:
                status = "A"  # Absent (< 4 hours)
            
            # Extract day number for frontend mapping
            day_num = None
            if date_str:
                try:
                    day_num = int(date_str.split("-")[-1])
                except (ValueError, IndexError):
                    pass

            duration_text = r.get(FIELD_DURATION_INTEXT)
            if augmented_hours > duration_hours:
                duration_text = _format_duration_text_from_hours(effective_hours)
            
            formatted_records.append({
                "date": date_str,
                "day": day_num,
                "attendance_id": r.get(FIELD_ATTENDANCE_ID_CUSTOM),
                "checkIn": checkin,
                "checkOut": checkout,
                "duration": effective_hours,
                "duration_text": duration_text,
                "status": status,
                "liveAugmented": augmented_hours > duration_hours
            })
        
        # Overlay employee-specific leaves into the same month range (CL/SL/CO)
        try:
            leaves_url = (
                f"{RESOURCE}/api/data/v9.2/{LEAVE_ENTITY}"
                f"?$filter=crc6f_employeeid eq '{normalized_emp_id}'"
            )
            leaves_resp = requests.get(leaves_url, headers=headers)
            if leaves_resp.status_code == 200:
                leaves = leaves_resp.json().get("value", [])
                # Build day -> record map for quick overlay
                by_day = {}
                for fr in formatted_records:
                    if fr.get("day"):
                        by_day[fr["day"]] = fr
                # Month boundaries
                month_start_dt = datetime.strptime(start_date, "%Y-%m-%d")
                month_end_dt = datetime.strptime(end_date, "%Y-%m-%d")
                for lv in leaves:
                    lt_raw = (lv.get("crc6f_leavetype") or "").strip()
                    if not lt_raw:
                        continue
                    status_raw = (lv.get("crc6f_status") or "").strip().lower()
                    if status_raw not in ("approved", "pending"):
                        # Only overlay approved/pending leaves; others shouldn't affect attendance
                        continue
                    # Determine short code
                    ltl = lt_raw.lower()
                    if "casual" in ltl or ltl == "cl":
                        lt_code = "CL"
                    elif "sick" in ltl or ltl == "sl":
                        lt_code = "SL"
                    elif "comp" in ltl or ltl in ("co", "compoff", "comp off", "compensatory off"):
                        lt_code = "CO"
                    else:
                        # Unknown type: do not overlay to avoid incorrect marks
                        continue
                    paid_unpaid = lv.get("crc6f_paidunpaid")
                    sd = lv.get("crc6f_startdate")
                    ed = lv.get("crc6f_enddate") or sd
                    try:
                        sd_dt = datetime.strptime(sd, "%Y-%m-%d") if sd else None
                        ed_dt = datetime.strptime(ed, "%Y-%m-%d") if ed else None
                    except Exception:
                        sd_dt, ed_dt = None, None
                    if not sd_dt:
                        continue
                    if not ed_dt:
                        ed_dt = sd_dt
                    # Clamp to current month window
                    rng_start = max(sd_dt, month_start_dt)
                    rng_end = min(ed_dt, month_end_dt)
                    if rng_start > rng_end:
                        continue
                    cur = rng_start
                    while cur <= rng_end:
                        day_idx = cur.day
                        # Create or update day's record
                        rec = by_day.get(day_idx)
                        if not rec:
                            rec = {
                                "date": cur.date().isoformat(),
                                "day": day_idx,
                                "attendance_id": None,
                                "checkIn": None,
                                "checkOut": None,
                                "duration": 0.0,
                                "duration_text": None,
                                "status": "" if status_raw == "pending" else "A",
                            }
                            formatted_records.append(rec)
                            by_day[day_idx] = rec
                        if status_raw == "approved":
                            # Overlay leave fields; approved leaves affect status/metrics
                            rec["leaveType"] = lt_raw
                            rec["paid_unpaid"] = paid_unpaid
                            rec["leaveStart"] = sd
                            rec["leaveEnd"] = ed
                            rec["leaveStatus"] = lv.get("crc6f_status")
                            rec["status"] = lt_code
                        else:
                            # Pending leaves only attach metadata for UI overlay
                            pending_entry = {
                                "leaveType": lt_raw,
                                "status": lv.get("crc6f_status") or "Pending",
                                "paid_unpaid": paid_unpaid,
                                "start": sd,
                                "end": ed,
                                "leave_id": lv.get("crc6f_leaveid"),
                            }
                            existing = rec.get("pendingLeaves") or []
                            existing.append(pending_entry)
                            rec["pendingLeaves"] = existing
                        # advance by one day
                        cur = cur + timedelta(days=1)
        except Exception as leave_err:
            print(f"[WARN] Leave overlay failed: {leave_err}")
        
        print(f"[OK] Successfully formatted {len(formatted_records)} attendance records")
        print(f"{'='*70}\n")
        
        return jsonify({
            "success": True,
            "records": formatted_records,
            "count": len(formatted_records)
        })
            
    except Exception as e:
        print(f"[ERROR] Error fetching monthly attendance: {str(e)}")
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


@app.route('/api/attendance/manual-edit', methods=['POST'])
def manual_edit_attendance():
    try:
        body = request.get_json(force=True) or {}
        employee_id = (body.get("employee_id") or "").strip()
        year = int(body.get("year") or 0)
        month = int(body.get("month") or 0)
        day = int(body.get("day") or 0)
        code = (body.get("code") or "").strip().upper()

        if not employee_id or not year or not month or not day or code not in ("P", "HL", "H", "A"):
            return jsonify({"success": False, "error": "employee_id, year, month, day and valid code required"}), 400

        date_str = f"{year}-{str(month).zfill(2)}-{str(day).zfill(2)}"

        if code == "P":
            duration_hours = 9.0
            checkin_val = "09:00:00"
            checkout_val = "18:00:00"
        elif code in ("HL", "H"):
            duration_hours = 5.0
            checkin_val = "09:00:00"
            checkout_val = "14:00:00"
        else:
            duration_hours = 0.0
            checkin_val = None
            checkout_val = None

        normalized_emp_id = employee_id.upper().strip()
        if normalized_emp_id.isdigit():
            normalized_emp_id = format_employee_id(int(normalized_emp_id))

        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0",
            "Content-Type": "application/json",
        }

        safe_emp = normalized_emp_id.replace("'", "''")
        safe_date = date_str
        filter_q = (
            f"?$top=1&$filter={FIELD_EMPLOYEE_ID} eq '{safe_emp}' and {FIELD_DATE} eq '{safe_date}' "
            f"and startswith({FIELD_ATTENDANCE_ID_CUSTOM},'ATD-')"
        )
        url = f"{RESOURCE}/api/data/v9.2/{ATTENDANCE_ENTITY}{filter_q}"
        resp = requests.get(url, headers=headers)
        record_id = None
        if resp.status_code == 200:
            values = resp.json().get("value", [])
            if values:
                row = values[0]
                record_id = row.get(FIELD_RECORD_ID) or row.get("crc6f_table13id") or row.get("id")

        payload = {
            FIELD_DURATION: str(int(duration_hours)),
            FIELD_DURATION_INTEXT: f"{int(duration_hours)} hour(s) 0 minute(s)",
        }
        if checkin_val is not None:
            payload[FIELD_CHECKIN] = checkin_val
        if checkout_val is not None:
            payload[FIELD_CHECKOUT] = checkout_val

        if record_id:
            update_record(ATTENDANCE_ENTITY, record_id, payload)
        else:
            new_att_id = generate_random_attendance_id()
            create_payload = {
                FIELD_EMPLOYEE_ID: normalized_emp_id,
                FIELD_DATE: date_str,
                FIELD_ATTENDANCE_ID_CUSTOM: new_att_id,
                FIELD_DURATION: str(int(duration_hours)),
                FIELD_DURATION_INTEXT: f"{int(duration_hours)} hour(s) 0 minute(s)",
            }
            if checkin_val is not None:
                create_payload[FIELD_CHECKIN] = checkin_val
            if checkout_val is not None:
                create_payload[FIELD_CHECKOUT] = checkout_val
            created = create_record(ATTENDANCE_ENTITY, create_payload)
            record_id = created.get(FIELD_RECORD_ID) or created.get("crc6f_table13id") or created.get("id")

        final_status = "P" if duration_hours >= 9 else ("H" if duration_hours > 4 else "A")

        return jsonify({
            "success": True,
            "employee_id": normalized_emp_id,
            "date": date_str,
            "status": final_status,
            "duration": duration_hours,
            "record_id": record_id,
        })
    except Exception as e:
        print(f"[ERROR] manual_edit_attendance failed: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/attendance/<employee_id>/all', methods=['GET'])
def get_all_attendance(employee_id):
    """Get all historical attendance records for an employee"""
    try:
        print(f"\n{'='*70}")
        print(f"[DATA] FETCH ALL ATTENDANCE - Employee: {employee_id}")
        print(f"{'='*70}")
        
        token = get_access_token()
        
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0"
        }
        
        # Fetch all attendance records for this employee
        filter_query = f"?$filter={FIELD_EMPLOYEE_ID} eq '{employee_id}'"
        url = f"{RESOURCE}/api/data/v9.2/{ATTENDANCE_ENTITY}{filter_query}"
        
        print(f"[URL] Fetching from: {url}")
        
        response = requests.get(url, headers=headers)
        
        if response.status_code == 200:
            records = response.json().get("value", [])
            print(f"[OK] Found {len(records)} total attendance records")
            
            # Format records for frontend
            formatted_records = []
            for r in records:
                date_str = r.get(FIELD_DATE)
                checkin = r.get(FIELD_CHECKIN)
                checkout = r.get(FIELD_CHECKOUT)
                duration_str = r.get(FIELD_DURATION, "0")
                
                try:
                    duration_hours = float(duration_str)
                except ValueError:
                    duration_hours = 0
                
                # Attendance classification
                if duration_hours >= 9:
                    status = "P"
                elif 5 <= duration_hours < 9:
                    status = "H"
                else:
                    status = "A"
                
                formatted_records.append({
                    "date": date_str,
                    "checkIn": checkin,
                    "checkOut": checkout,
                    "duration": duration_hours,
                    "duration_text": r.get(FIELD_DURATION_INTEXT),
                    "status": status
                })
            
            print(f"[OK] Successfully formatted {len(formatted_records)} records")
            
            return jsonify({
                "success": True,
                "records": formatted_records,
                "count": len(formatted_records)
            })
        else:
            return jsonify({
                "success": False,
                "error": f"Failed to fetch records: {response.status_code}"
            }), 500
            
    except Exception as e:
        print(f"[ERROR] Error fetching all attendance: {str(e)}")
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


# ================== LEAVE TRACKER ROUTES ==================
@app.route('/')
def index():
    """Home page - can redirect to leave tracker"""
    print("📄 Serving index page")
    return jsonify({
        "message": "Unified Backend Server - API only",
        "hint": "Use the frontend at http://localhost:3000 and API at /api/...",
        "endpoints": ["/ping", "/api/info", "/api/leaves/<employee_id>", "/api/leave-balance/<employee_id>/<leave_type>"]
    }), 200


@app.route('/apply_leave_page')
def apply_leave_page():
    """Apply leave page"""
    print("📄 Serving apply leave page")
    return jsonify({
        "message": "This backend does not serve HTML pages. Use the SPA frontend to apply leave.",
        "frontend": "http://localhost:3000/#/leave-my",
        "api_apply": "POST /apply_leave"
    }), 200


@app.route('/apply_leave', methods=['POST'])
def apply_leave():
    try:
        print("\n" + "=" * 70)
        print("[START] LEAVE APPLICATION REQUEST RECEIVED")
        print("=" * 70)

        if not request.is_json:
            print("   [ERROR] Request is not JSON!")
            return jsonify({"error": "Request must be JSON"}), 400

        print("\n[RECV] Step 1: Receiving request data...")
        data = request.get_json()
        print(f"   [OK] Received JSON data:\n   {data}")

        leave_type = data.get("leave_type")
        start_date = data.get("start_date")
        end_date = data.get("end_date")
        applied_by_raw = data.get("applied_by")
        paid_unpaid = data.get("paid_unpaid", "Paid")
        status = data.get("status", "Pending")
        reason = data.get("reason", "")

        # Format employee ID
        if applied_by_raw:
            if applied_by_raw.isdigit():
                applied_by = format_employee_id(int(applied_by_raw))
            elif applied_by_raw.upper().startswith("EMP"):
                applied_by = applied_by_raw.upper()
            else:
                applied_by = "EMP0001"
        else:
            applied_by = "EMP0001"

        # Validate required fields
        missing_fields = [f for f in ["leave_type", "start_date", "end_date", "applied_by"]
                          if not data.get(f)]
        if missing_fields:
            return jsonify({"error": f"Missing required fields: {', '.join(missing_fields)}"}), 400

        leave_id = generate_leave_id()
        leave_days = calculate_leave_days(start_date, end_date)

        token = get_access_token()
        balance_row = None
        try:
            balance_row = _fetch_leave_balance(token, applied_by)
        except Exception as bal_err:
            print(f"[WARN] Could not fetch leave balance for {applied_by}: {bal_err}")

        paid_flag = (paid_unpaid or "").lower() == "paid"
        lt_norm = (leave_type or "").strip().lower()

        if paid_flag and lt_norm in ("casual leave", "sick leave"):
            if not balance_row:
                balance_row = _ensure_leave_balance_row(token, applied_by)
            available = _get_available_days(balance_row, leave_type)
            print(f"🔎 Available days for {leave_type} = {available}, requested = {leave_days}")
            paid_days = min(float(available or 0), float(leave_days or 0))
            unpaid_days = max(0.0, float(leave_days or 0) - paid_days)

            created_records = []
            primary_leave_id = None

            start_dt = datetime.strptime(start_date, "%Y-%m-%d")
            end_dt = datetime.strptime(end_date, "%Y-%m-%d")

            if paid_days > 0:
                paid_leave_id = leave_id
                paid_end_dt = start_dt + timedelta(days=int(paid_days) - 1)
                record_data_paid = {
                    "crc6f_leaveid": paid_leave_id,
                    "crc6f_leavetype": leave_type,
                    "crc6f_startdate": start_dt.date().isoformat(),
                    "crc6f_enddate": paid_end_dt.date().isoformat(),
                    "crc6f_paidunpaid": "Paid",
                    "crc6f_status": status,
                    "crc6f_totaldays": str(int(paid_days)),
                    "crc6f_employeeid": applied_by,
                    "crc6f_approvedby": "",
                }
                print(f"📦 Dataverse Record Data (Paid): {record_data_paid}")
                created_paid = create_record(LEAVE_ENTITY, record_data_paid)
                created_records.append(created_paid)
                primary_leave_id = paid_leave_id
                try:
                    if paid_days > 0:
                        _decrement_leave_balance(token, balance_row, leave_type, paid_days)
                except Exception as dec_err:
                    print(f"[WARN] Failed to decrement leave balance for {applied_by}: {dec_err}")

            if unpaid_days > 0:
                unpaid_leave_id = generate_leave_id()
                unpaid_start_dt = start_dt + timedelta(days=int(paid_days))
                record_data_unpaid = {
                    "crc6f_leaveid": unpaid_leave_id,
                    "crc6f_leavetype": leave_type,
                    "crc6f_startdate": unpaid_start_dt.date().isoformat(),
                    "crc6f_enddate": end_dt.date().isoformat(),
                    "crc6f_paidunpaid": "Unpaid",
                    "crc6f_status": status,
                    "crc6f_totaldays": str(int(unpaid_days)),
                    "crc6f_employeeid": applied_by,
                    "crc6f_approvedby": "",
                }
                print(f"📦 Dataverse Record Data (Unpaid): {record_data_unpaid}")
                created_unpaid = create_record(LEAVE_ENTITY, record_data_unpaid)
                created_records.append(created_unpaid)
                if primary_leave_id is None:
                    primary_leave_id = unpaid_leave_id

            latest_row = None
            try:
                latest_row = _fetch_leave_balance(token, applied_by) or balance_row
            except Exception:
                latest_row = balance_row
            balances = {
                "Casual Leave": float((latest_row or {}).get("crc6f_cl", 0) or 0),
                "Sick Leave": float((latest_row or {}).get("crc6f_sl", 0) or 0),
                "Comp Off": float((latest_row or {}).get("crc6f_compoff", 0) or 0),
            }
            balances["Total"] = balances["Casual Leave"] + balances["Sick Leave"] + balances["Comp Off"]

            response_data = {
                "message": f"Leave applied successfully for {applied_by}",
                "leave_id": primary_leave_id,
                "leave_days": leave_days,
                "leave_details": created_records[0] if created_records else {},
                "balances": balances,
                "split": {
                    "paid_days": paid_days,
                    "unpaid_days": unpaid_days,
                },
            }

            print("[OK] LEAVE APPLICATION SUCCESSFUL! (split paid/unpaid)\n")
            admin_email = os.getenv("ADMIN_EMAIL")
            employee_name = get_employee_name(applied_by)
            print(employee_name)
            send_email(
                subject=f"[LOG] New Leave Request from {applied_by}",
                recipients=[admin_email],
                body=f"""
        Employee {employee_name} {applied_by} has applied for {leave_type} leave
        from {start_date} to {end_date} ({leave_days} days).

        Paid: {paid_days} day(s)
        Unpaid: {unpaid_days} day(s)

        Reason: {reason or 'Not provided'}

        Please review in HR Tool.
        """)
            return jsonify(response_data), 200

        if paid_flag:
            if not balance_row:
                balance_row = _ensure_leave_balance_row(token, applied_by)
            available = _get_available_days(balance_row, leave_type)
            print(f"🔎 Available days for {leave_type} = {available}, requested = {leave_days}")
            if float(available) < float(leave_days):
                return jsonify({
                    "error": f"Insufficient {leave_type} balance. Available: {available}, requested: {leave_days}",
                    "available": available,
                    "requested": leave_days,
                    "leave_type": leave_type,
                    "employee_id": applied_by
                }), 400

        record_data = {
            "crc6f_leaveid": leave_id,
            "crc6f_leavetype": leave_type,
            "crc6f_startdate": start_date,
            "crc6f_enddate": end_date,
            "crc6f_paidunpaid": paid_unpaid,
            "crc6f_status": status,
            "crc6f_totaldays": str(leave_days),
            "crc6f_employeeid": applied_by,
            "crc6f_approvedby": "",
        }

        print(f"📦 Dataverse Record Data: {record_data}")
        created_record = create_record(LEAVE_ENTITY, record_data)

        try:
            if paid_flag and leave_days > 0:
                _decrement_leave_balance(token, balance_row, leave_type, leave_days)
        except Exception as dec_err:
            print(f"[WARN] Failed to decrement leave balance for {applied_by}: {dec_err}")
        print(f"[OK] Record Created: {created_record}")

        latest_row = None
        try:
            latest_row = _fetch_leave_balance(token, applied_by) or balance_row
        except Exception:
            latest_row = balance_row
        balances = {
            "Casual Leave": float((latest_row or {}).get("crc6f_cl", 0) or 0),
            "Sick Leave": float((latest_row or {}).get("crc6f_sl", 0) or 0),
            "Comp Off": float((latest_row or {}).get("crc6f_compoff", 0) or 0),
        }
        balances["Total"] = balances["Casual Leave"] + balances["Sick Leave"] + balances["Comp Off"]

        response_data = {
            "message": f"Leave applied successfully for {applied_by}",
            "leave_id": leave_id,
            "leave_days": leave_days,
            "leave_details": created_record,
            "balances": balances,
        }

        print("[OK] LEAVE APPLICATION SUCCESSFUL!\n")
        admin_email = os.getenv("ADMIN_EMAIL")
        employee_name = get_employee_name(applied_by)
        print(employee_name)
        send_email(
            subject=f"[LOG] New Leave Request from {applied_by}",
            recipients=[admin_email],
            body=f"""
        Employee {employee_name} {applied_by} has applied for {leave_type} leave
        from {start_date} to {end_date} ({leave_days} days).

        Reason: {reason or 'Not provided'}

        Please review in HR Tool.
        """)
        return jsonify(response_data), 200

    except Exception as e:
        print("\n[ERROR] ERROR OCCURRED IN LEAVE APPLICATION")
        traceback.print_exc()
        return jsonify({
            "error": str(e),
            "traceback": traceback.format_exc()
        }), 500


@app.route('/api/apply-leave', methods=['POST'])
def api_apply_leave():
    """Alias endpoint that mirrors POST /apply_leave for SPA clients."""
    return apply_leave()


@app.route('/api/leaves/<employee_id>', methods=['GET'])
def get_employee_leaves(employee_id):
    """Get all leave records for a specific employee"""
    try:
        print(f"\n{'='*70}")
        print(f"[SEARCH] FETCHING LEAVE HISTORY FOR EMPLOYEE: {employee_id}")
        print(f"{'='*70}")
        
        token = get_access_token()
        inbox_entity = get_inbox_entity_set(token)
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0"
        }
        
        # Normalize employee ID format
        normalized_emp_id = employee_id.upper().strip()
        if normalized_emp_id.isdigit():
            normalized_emp_id = format_employee_id(int(normalized_emp_id))
        
        print(f"   [USER] Normalized Employee ID: {normalized_emp_id}")
        
        # Try fetching by employee_id first
        filter_query = f"?$filter=crc6f_employeeid eq '{normalized_emp_id}'"
        url = f"{RESOURCE}/api/data/v9.2/{LEAVE_ENTITY}{filter_query}"
        
        print(f"   [URL] Sending request to Dataverse: {url}")
        response = requests.get(url, headers=headers)
        
        if response.status_code != 200:
            print(f"[ERROR] Failed to fetch leaves: {response.status_code} {response.text}")
            return jsonify({"success": False, "error": "Failed to fetch leave records"}), 500
        
        records = response.json().get("value", [])
        print(f"   [DATA] Found {len(records)} leave records")
        
        # If no records found, try case-insensitive search
        if len(records) == 0:
            print(f"[SEARCH] No leaves found for {normalized_emp_id}, trying case-insensitive search...")
            try:
                # Try different case variations
                variations = [
                    normalized_emp_id.lower(),
                    normalized_emp_id.title(),
                    employee_id  # original case
                ]
                
                for variation in variations:
                    if variation != normalized_emp_id:
                        filter_query = f"?$filter=crc6f_employeeid eq '{variation}'"
                        url = f"{RESOURCE}/api/data/v9.2/{LEAVE_ENTITY}{filter_query}"
                        response = requests.get(url, headers=headers)
                        
                        if response.status_code == 200:
                            records = response.json().get("value", [])
                            if records:
                                print(f"[OK] Found {len(records)} records with variation: {variation}")
                                break
            except Exception as e:
                print(f"[WARN] Case-insensitive search failed: {str(e)}")
        
        # If still no records and employee_id looks like an email, try to resolve it
        if len(records) == 0 and '@' in employee_id:
            print(f"[SEARCH] No leaves found for {employee_id}, attempting email lookup...")
            try:
                # Fetch employee by email to get actual employee_id
                entity_set = get_employee_entity_set(token)
                field_map = get_field_map(entity_set)
                email_field = field_map.get('email')
                id_field = field_map.get('id')
                
                if email_field and id_field:
                    safe_email = employee_id.replace("'", "''")
                    emp_url = f"{RESOURCE}/api/data/v9.2/{entity_set}?$filter={email_field} eq '{safe_email}'&$select={id_field}"
                    emp_response = requests.get(emp_url, headers=headers)
                    
                    if emp_response.status_code == 200:
                        emp_records = emp_response.json().get("value", [])
                        if emp_records:
                            actual_emp_id = emp_records[0].get(id_field)
                            if actual_emp_id:
                                print(f"[OK] Resolved email {employee_id} to employee ID {actual_emp_id}")
                                # Retry fetching leaves with actual employee_id
                                filter_query = f"?$filter=crc6f_employeeid eq '{actual_emp_id}'"
                                url = f"{RESOURCE}/api/data/v9.2/{LEAVE_ENTITY}{filter_query}"
                                response = requests.get(url, headers=headers)
                                if response.status_code == 200:
                                    records = response.json().get("value", [])
                                    print(f"[DATA] Found {len(records)} records after email resolution")
            except Exception as e:
                print(f"[WARN] Email lookup failed: {str(e)}")
        
        formatted_leaves = []
        
        for r in records:
            formatted_leaves.append({
                "leave_id": r.get("crc6f_leaveid"),
                "leave_type": r.get("crc6f_leavetype"),
                "start_date": r.get("crc6f_startdate"),
                "end_date": r.get("crc6f_enddate"),
                "total_days": r.get("crc6f_totaldays"),
                "paid_unpaid": r.get("crc6f_paidunpaid"),
                "status": r.get("crc6f_status"),
                "approved_by": r.get("crc6f_approvedby"),
                "rejection_reason": r.get("crc6f_rejectionreason"),
                "employee_id": r.get("crc6f_employeeid")
            })
        
        print(f"[OK] Successfully formatted {len(formatted_leaves)} leave records")
        print(f"{'='*70}\n")
        
        return jsonify({
            "success": True,
            "leaves": formatted_leaves,
            "count": len(formatted_leaves)
        })
        
    except Exception as e:
        print(f"[ERROR] Error fetching leaves: {str(e)}")
        return jsonify({"success": False, "error": str(e)}), 500

# ================== PROJECTS MANAGEMENT ROUTES ==================
@app.route("/api/projects", methods=["GET"])
def list_projects():
    """List project headers from Dataverse"""
    try:
        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0",
            "If-None-Match": "null",
        }
        entity_set = get_projects_entity(token)
        select = (
            "$select="
            "crc6f_projectid,crc6f_projectname,crc6f_client,crc6f_manager,"
            "crc6f_projectstatus,crc6f_startdate,crc6f_enddate,"
            "crc6f_estimationcost,crc6f_noofcontributors,crc6f_projectdescription,"
            "crc6f_hr_projectheaderid,createdon"
        )
        url = f"{RESOURCE}/api/data/v9.2/{entity_set}?{select}&$top=5000"
        resp = requests.get(url, headers=headers)
        if resp.status_code != 200:
            return jsonify({"success": False, "error": resp.text}), resp.status_code

        values = resp.json().get("value", [])

        # Optional filters
        q = (request.args.get("search") or "").strip().lower()
        status = (request.args.get("status") or "").strip().lower()
        sort = (request.args.get("sort") or "recent").strip().lower()

        def match(v):
            if not q:
                return True
            return q in str(v or "").lower()

        items = []
        for r in values:
            item = {
                "crc6f_projectid": r.get("crc6f_projectid"),
                "crc6f_projectname": r.get("crc6f_projectname"),
                "crc6f_client": r.get("crc6f_client"),
                "crc6f_manager": r.get("crc6f_manager"),
                "crc6f_projectstatus": r.get("crc6f_projectstatus"),
                "crc6f_startdate": r.get("crc6f_startdate"),
                "crc6f_enddate": r.get("crc6f_enddate"),
                "crc6f_estimationcost": r.get("crc6f_estimationcost"),
                "crc6f_noofcontributors": r.get("crc6f_noofcontributors"),
                "crc6f_projectdescription": r.get("crc6f_projectdescription"),
                "crc6f_hr_projectheaderid": r.get("crc6f_hr_projectheaderid"),
                "createdon": r.get("createdon"),
            }
            if q and not (match(item["crc6f_projectid"]) or match(item["crc6f_projectname"]) or match(item["crc6f_client"])):
                continue
            if status and str(item.get("crc6f_projectstatus") or "").strip().lower() != status:
                continue
            items.append(item)

        if sort == "name":
            items.sort(key=lambda x: (str(x.get("crc6f_projectname") or "").lower(), str(x.get("crc6f_projectid") or "")))
        elif sort == "status":
            items.sort(key=lambda x: (str(x.get("crc6f_projectstatus") or "").lower(), str(x.get("crc6f_projectname") or "").lower()))
        else:
            items.sort(key=lambda x: str(x.get("createdon") or ""), reverse=True)

        return jsonify({"success": True, "projects": items})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/projects", methods=["POST"])
def create_project():
    try:
        token = get_access_token()
        entity_set = get_projects_entity(token)
        data = request.get_json(force=True) or {}

        # Require Project ID & Name minimally
        pid = (data.get("crc6f_projectid") or "").strip()
        if not pid:
            pid = generate_project_id()
        pname = (data.get("crc6f_projectname") or "").strip()
        if not pid or not pname:
            return jsonify({"success": False, "error": "Project ID and Project Name are required"}), 400

        # Uniqueness check on crc6f_projectid
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0",
        }
        safe = pid.replace("'", "''")
        url = f"{RESOURCE}/api/data/v9.2/{entity_set}?$select=crc6f_projectid&$filter=crc6f_projectid eq '{safe}'&$top=1"
        chk = requests.get(url, headers=headers)
        if chk.status_code == 200 and chk.json().get("value"):
            return jsonify({"success": False, "error": "Project ID already exists"}), 409

        payload = {
            "crc6f_projectid": pid,
            "crc6f_projectname": pname,
            "crc6f_client": data.get("crc6f_client"),
            "crc6f_manager": data.get("crc6f_manager"),
            "crc6f_projectstatus": data.get("crc6f_projectstatus"),
            "crc6f_startdate": data.get("crc6f_startdate"),
            "crc6f_enddate": data.get("crc6f_enddate"),
            "crc6f_estimationcost": data.get("crc6f_estimationcost"),
            "crc6f_noofcontributors": data.get("crc6f_noofcontributors"),
            "crc6f_projectdescription": data.get("crc6f_projectdescription"),
        }
        created = create_record(entity_set, payload)
        return jsonify({"success": True, "project": created}), 201
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/projects/<record_id>", methods=["PATCH"])
def update_project(record_id):
    try:
        token = get_access_token()
        entity_set = get_projects_entity(token)
        data = request.get_json(force=True) or {}
        payload = {}
        for k in [
            "crc6f_projectid",
            "crc6f_projectname",
            "crc6f_client",
            "crc6f_manager",
            "crc6f_projectstatus",
            "crc6f_startdate",
            "crc6f_enddate",
            "crc6f_estimationcost",
            "crc6f_noofcontributors",
            "crc6f_projectdescription",
        ]:
            if k in data:
                payload[k] = data.get(k)
        update_record(entity_set, record_id, payload)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/projects/<record_id>", methods=["DELETE"])
def delete_project(record_id):
    try:
        token = get_access_token()
        entity_set = get_projects_entity(token)
        delete_record(entity_set, record_id)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/leave-balance/<employee_id>/<leave_type>', methods=['GET'])
def get_leave_balance(employee_id, leave_type):
    """Return available leave balance for an employee and leave type.
    Supported leave_type values: 'Casual Leave', 'Sick Leave', 'Comp Off' (case-insensitive).
    """
    import requests
    from dataverse_helper import get_access_token
    try:
        # Normalize employee id (support EMP### or numeric)
        emp = (employee_id or '').strip().upper()
        if emp.isdigit():
            emp = f"EMP{int(emp):03d}"

        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0",
        }

        # Probe candidate entity sets and FK field names to be resilient
        candidates = [
            "crc6f_hr_leavemangements",
            "crc6f_hr_leavemangement",
            "crc6f_leave_mangement",
            "crc6f_leave_mangements",
        ]
        fk_fields = ["crc6f_employeeid", "crc6f_empid"]

        record = None
        last_status = None
        last_text = None
        # Try multiple employee id variants to avoid case/format mismatches
        id_variants = []
        try:
            orig = (employee_id or '').strip()
            # Add EMP 3-digit and 4-digit patterns
            emp3 = emp
            emp4 = emp
            try:
                if orig.isdigit():
                    emp3 = f"EMP{int(orig):03d}"
                    emp4 = f"EMP{int(orig):04d}"
                elif orig.upper().startswith("EMP"):
                    num = ''.join([c for c in orig if c.isdigit()])
                    if num:
                        emp3 = f"EMP{int(num):03d}"
                        emp4 = f"EMP{int(num):04d}"
            except Exception:
                pass
            id_variants = [emp3, emp4, emp, emp.lower(), orig, orig.upper(), orig.lower()]
            # Deduplicate preserving order
            seen = set()
            id_variants = [x for x in id_variants if not (x in seen or seen.add(x))]
        except Exception:
            id_variants = [emp]

        for entity in candidates:
            for fk in fk_fields:
                # Try exact matches on variants
                for val in id_variants:
                    safe_val = str(val).replace("'", "''")
                    url = f"{BASE_URL}/{entity}?$filter={fk} eq '{safe_val}'&$top=1"
                    resp = requests.get(url, headers=headers)
                    last_status, last_text = resp.status_code, resp.text
                    if resp.status_code == 200:
                        vals = resp.json().get("value", [])
                        if vals:
                            record = vals[0]
                            try:
                                print(f"[OK] Leave balance match: entity={entity}, fk={fk}, value='{val}'")
                            except Exception:
                                pass
                            break
                if record:
                    break
                # Try OData tolower() equality if supported
                try:
                    lower_val = (emp or '').lower().replace("'", "''")
                    url_lower = f"{BASE_URL}/{entity}?$filter=tolower({fk}) eq '{lower_val}'&$top=1"
                    resp2 = requests.get(url_lower, headers=headers)
                    last_status, last_text = resp2.status_code, resp2.text
                    if resp2.status_code == 200:
                        vals2 = resp2.json().get("value", [])
                        if vals2:
                            record = vals2[0]
                            try:
                                print(f"[OK] Leave balance match (tolower): entity={entity}, fk={fk}")
                            except Exception:
                                pass
                            break
                except Exception:
                    pass
            if record:
                break

        # Resolve target field using the discovered record (schema-aware)
        def resolve_field_for_get(row: dict, lt_str: str) -> str:
            lt_low = (lt_str or '').strip().lower()
            if lt_low in ("casual leave", "cl"):
                for c in ("crc6f_cl", "crc6f_casualleave", "crc6f_casual"):
                    if c in row: return c
                return "crc6f_cl"
            if lt_low in ("sick leave", "sl"):
                for c in ("crc6f_sl", "crc6f_sickleave", "crc6f_sick", "crc6f_sickleaves"):
                    if c in row: return c
                return "crc6f_sl"
            if lt_low in ("compensatory off", "comp off", "compoff", "co"):
                for c in ("crc6f_compoff", "crc6f_comp_off", "crc6f_compensatoryoff", "crc6f_compensatory_off"):
                    if c in row: return c
                return "crc6f_compoff"
            for c in ("crc6f_total", "crc6f_overall", "crc6f_totalleave"):
                if c in row: return c
            return "crc6f_total"
        field = resolve_field_for_get(record or {}, leave_type)

        if not record:
            # Gracefully return zero if no row found for employee
            return jsonify({
                "success": True,
                "employee_id": emp,
                "leave_type": leave_type,
                "available": 0
            }), 200

        available = float(record.get(field, 0) or 0)
        return jsonify({
            "success": True,
            "employee_id": emp,
            "leave_type": leave_type,
            "available": available
        }), 200
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/leave-balance', methods=['GET'])
def get_leave_balance_query():
    """Fallback endpoint supporting query params: ?employee_id=EMP001&leave_type=Casual%20Leave"""
    try:
        employee_id = request.args.get('employee_id', '')
        leave_type = request.args.get('leave_type', '')
        if not employee_id or not leave_type:
            return jsonify({"success": False, "error": "employee_id and leave_type are required"}), 400
        # Delegate to the path handler to keep behavior consistent
        return get_leave_balance(employee_id, leave_type)
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/leave-balance/all/<employee_id>', methods=['GET'])
def get_all_leave_balances(employee_id):
    """Return all leave balances (CL, SL, Comp Off) for an employee with annual quota, consumed (from history), and available"""
    try:
        print(f"\n{'='*70}")
        print(f"[SEARCH] FETCHING ALL LEAVE BALANCES FOR EMPLOYEE: {employee_id}")
        print(f"{'='*70}")
        
        # Normalize employee id
        emp = (employee_id or '').strip().upper()
        if emp.isdigit():
            emp = f"EMP{int(emp):03d}"
        
        token = get_access_token()
        inbox_entity = get_inbox_entity_set(token)
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0"
        }
        
        # ============================================================
        # CALCULATE ANNUAL QUOTA BASED ON EMPLOYEE EXPERIENCE (DOJ)
        # ============================================================
        print(f"[DATA] Calculating annual leave quota based on employee experience for {emp}...")
        
        # Fetch employee DOJ from employee master table
        entity_set = get_employee_entity_set(token)
        field_map = get_field_map(entity_set)
        
        # Fetch employee record to get DOJ
        safe_emp = emp.replace("'", "''")
        emp_filter = f"?$filter={field_map['id']} eq '{safe_emp}'"
        emp_url = f"{RESOURCE}/api/data/v9.2/{entity_set}{emp_filter}"
        emp_response = requests.get(emp_url, headers=headers)
        
        # Default quotas for Type 3 (0-1 years experience)
        cl_annual = 3
        sl_annual = 3
        co_annual = 0   # Comp off doesn't have fixed annual quota
        
        if emp_response.status_code == 200:
            emp_records = emp_response.json().get("value", [])
            if emp_records:
                emp_record = emp_records[0]
                doj_value = emp_record.get(field_map['doj'])
                
                print(f"   [DATE] Employee DOJ: {doj_value}")
                
                # Calculate experience from DOJ
                if doj_value:
                    try:
                        from datetime import datetime
                        # Parse DOJ - handle multiple formats
                        doj_date = None
                        if isinstance(doj_value, str):
                            # Try MM/DD/YYYY format first
                            if '/' in doj_value:
                                parts = doj_value.split('/')
                                if len(parts) == 3:
                                    doj_date = datetime(int(parts[2]), int(parts[0]), int(parts[1]))
                            # Try YYYY-MM-DD format
                            elif '-' in doj_value:
                                doj_date = datetime.fromisoformat(doj_value.split('T')[0])
                        
                        if doj_date:
                            current_date = datetime.now()
                            experience_years = (current_date - doj_date).days / 365.25
                            experience_years = max(0, int(experience_years))
                            
                            print(f"   [DATA] Calculated Experience: {experience_years} years")
                            
                            # Determine allocation based on experience
                            # Type 1: 3+ years -> CL=6, SL=6, Total=12
                            # Type 2: 2+ years -> CL=4, SL=4, Total=8
                            # Type 3: <2 years -> CL=3, SL=3, Total=6
                            if experience_years >= 3:
                                cl_annual = 6
                                sl_annual = 6
                                print(f"   [OK] Allocation Type 1 (3+ years): CL={cl_annual}, SL={sl_annual}")
                            elif experience_years >= 2:
                                cl_annual = 4
                                sl_annual = 4
                                print(f"   [OK] Allocation Type 2 (2+ years): CL={cl_annual}, SL={sl_annual}")
                            else:
                                cl_annual = 3
                                sl_annual = 3
                                print(f"   [OK] Allocation Type 3 (<2 years): CL={cl_annual}, SL={sl_annual}")
                    except Exception as e:
                        print(f"   [WARN] Error calculating experience: {e}")
                        print(f"   Using default Type 3 allocation: CL={cl_annual}, SL={sl_annual}")
                else:
                    print(f"   [WARN] No DOJ found, using default Type 3 allocation: CL={cl_annual}, SL={sl_annual}")
            else:
                print(f"   [WARN] Employee record not found, using default Type 3 allocation: CL={cl_annual}, SL={sl_annual}")
        else:
            print(f"   [WARN] Failed to fetch employee record, using default Type 3 allocation: CL={cl_annual}, SL={sl_annual}")
        
        # ============================================================
        # CALCULATE CONSUMED FROM ACTUAL LEAVE HISTORY (REAL-TIME)
        # Only APPROVED paid leaves should reduce the balance
        # ============================================================
        print(f"[DATA] Fetching leave history for {emp} to calculate consumed leaves...")
        
        # Fetch leave records with Approved status (Pending shouldn't reduce balances)
        safe_emp = emp.replace("'", "''")
        filter_query = f"?$filter=crc6f_employeeid eq '{safe_emp}' and crc6f_status eq 'Approved'"
        leave_url = f"{RESOURCE}/api/data/v9.2/{LEAVE_ENTITY}{filter_query}&$select=crc6f_leavetype,crc6f_totaldays,crc6f_paidunpaid,crc6f_status"
        
        leave_response = requests.get(leave_url, headers=headers)
        
        cl_consumed = 0.0
        sl_consumed = 0.0
        co_consumed = 0.0
        
        if leave_response.status_code == 200:
            leave_records = leave_response.json().get("value", [])
            print(f"[FETCH] Found {len(leave_records)} leave records (Approved/Pending/Cancelled)")
            
            for record in leave_records:
                leave_type = (record.get("crc6f_leavetype") or "").strip()
                total_days = float(record.get("crc6f_totaldays") or 0)
                paid_unpaid = (record.get("crc6f_paidunpaid") or "").strip().lower()
                status = (record.get("crc6f_status") or "").strip()
                status_low = status.lower()
                
                lt_low = leave_type.lower()
                
                # Count PAID leaves only when status is Approved
                if paid_unpaid == "paid" and total_days > 0 and status_low == "approved":
                    # Casual Leave: support both full name and short code CL
                    if "casual" in lt_low or lt_low in ("cl", "casual leave"):
                        cl_consumed += total_days
                        print(f"   [OK] Casual Leave: +{total_days} days ({status})")
                    # Sick Leave: support both full name and short code SL
                    elif "sick" in lt_low or lt_low in ("sl", "sick leave"):
                        sl_consumed += total_days
                        print(f"   [OK] Sick Leave: +{total_days} days ({status})")
                    # Comp Off: support CO / Comp Off variants
                    elif "comp" in lt_low or lt_low in ("co", "comp off", "compoff", "compensatory off"):
                        co_consumed += total_days
                        print(f"   [OK] Comp Off: +{total_days} days ({status})")
        else:
            print(f"[WARN] Could not fetch leave history: {leave_response.status_code}")
        
        print(f"\n[DATA] REAL-TIME CONSUMED CALCULATION (including Pending/Cancelled):")
        print(f"   Casual Leave Consumed: {cl_consumed}")
        print(f"   Sick Leave Consumed: {sl_consumed}")
        print(f"   Comp Off Consumed: {co_consumed}")
        
        # ============================================================
        # CALCULATE AVAILABLE = ANNUAL QUOTA - CONSUMED (BASELINE)
        # ============================================================
        cl_available = max(0, cl_annual - cl_consumed)
        sl_available = max(0, sl_annual - sl_consumed)
        co_available = max(0, co_annual - co_consumed)  # Comp off available (earned comp offs)

        # ------------------------------------------------------------
        # OVERRIDE WITH DATAVERSE LEAVE-BALANCE ROW (crc6f_cl/sl/compoff)
        # So that the "Available" shown in UI matches the Dataverse table
        # exactly for CL/SL/CO. We then recompute Consumed = Annual - Available.
        # ------------------------------------------------------------
        try:
            balance_row = _fetch_leave_balance(token, emp)
        except Exception as bal_err:
            balance_row = None
            print(f"[WARN] Failed to fetch leave-balance row for {emp} in all-balances: {bal_err}")

        if balance_row:
            try:
                cl_db = _get_available_days(balance_row, "Casual Leave")
                sl_db = _get_available_days(balance_row, "Sick Leave")
                co_db = _get_available_days(balance_row, "Comp Off")
                print(f"[DATA] Using Dataverse balance overrides: CL={cl_db}, SL={sl_db}, CO={co_db}")

                # Use Dataverse values as canonical "Available" counts
                cl_available = max(0.0, float(cl_db or 0))
                sl_available = max(0.0, float(sl_db or 0))
                co_available = max(0.0, float(co_db or 0))

                # Recompute consumed from annual quota so cards stay consistent
                cl_consumed = max(0.0, float(cl_annual) - cl_available)
                sl_consumed = max(0.0, float(sl_annual) - sl_available)
                # Keep co_consumed from history, but ensure non-negative
                co_consumed = max(0.0, float(co_consumed))
            except Exception as bal2_err:
                print(f"[WARN] Failed to apply Dataverse overrides in all-balances: {bal2_err}")

        print(f"\n[DATA] CALCULATED AVAILABLE BALANCES (after overrides if any):")
        print(f"   Casual Leave Available: {cl_available} (Quota: {cl_annual}, Consumed: {cl_consumed})")
        print(f"   Sick Leave Available: {sl_available} (Quota: {sl_annual}, Consumed: {sl_consumed})")
        print(f"   Comp Off Available: {co_available}")

        # Calculate totals
        total_available = cl_available + sl_available + co_available
        actual_total = cl_annual + sl_annual  # Total quota based on allocation type
        
        balances = [
            {
                "type": "Casual Leave",
                "annual_quota": cl_annual,
                "consumed": cl_consumed,
                "available": cl_available
            },
            {
                "type": "Sick Leave",
                "annual_quota": sl_annual,
                "consumed": sl_consumed,
                "available": sl_available
            },
            {
                "type": "Comp off",
                "annual_quota": co_annual,
                "consumed": co_consumed,
                "available": co_available
            },
            {
                "type": "Total",
                "annual_quota": cl_annual + sl_annual + co_annual,
                "consumed": cl_consumed + sl_consumed + co_consumed,
                "available": total_available
            },
            {
                "type": "Actual Total",
                "annual_quota": actual_total,
                "consumed": 0,
                "available": actual_total
            }
        ]
        
        print(f"\n[OK] FINAL LEAVE BALANCES:")
        for b in balances:
            print(f"   {b['type']}: Annual={b['annual_quota']}, Consumed={b['consumed']}, Available={b['available']}")
        print(f"{'='*70}\n")
        
        return jsonify({
            "success": True,
            "employee_id": emp,
            "balances": balances,
            "total_available": total_available,
            "actual_total": actual_total
        }), 200
        
    except Exception as e:
        print(f"[ERROR] Error fetching all leave balances: {str(e)}")
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/test-dataverse', methods=['GET'])
def test_dataverse_connection():
    """Test endpoint to verify Dataverse connectivity"""
    try:
        token = get_access_token()
        entity_set = get_employee_entity_set(token)
        test_record = {
            "crc6f_employeeid": "TEST001",
            "crc6f_firstname": "Test",
            "crc6f_lastname": "User",
            "crc6f_email": "test@example.com",
            "crc6f_leaveid": generate_leave_id(),
            "crc6f_approvedby": "System"
        }
        result = create_record(LEAVE_ENTITY, test_record)
        return jsonify({"success": True, "dataverse_result": result}), 200
    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500

@app.route('/api/debug/create-test-intern', methods=['POST'])
def debug_create_test_intern():
    """Create a test employee with Employee Flag = Intern and a matching intern record."""
    try:
        token = get_access_token()
        emp_entity = get_employee_entity_set(token)
        field_map = get_field_map(emp_entity)

        employee_id = generate_employee_id()
        first_name = "Test"
        last_name = "Intern"
        email = f"test.intern+{employee_id.lower()}@example.com"

        emp_payload = {}
        if field_map.get("id"):
            emp_payload[field_map["id"]] = employee_id
        if field_map.get("fullname"):
            emp_payload[field_map["fullname"]] = f"{first_name} {last_name}".strip()
        else:
            if field_map.get("firstname"):
                emp_payload[field_map["firstname"]] = first_name
            if field_map.get("lastname"):
                emp_payload[field_map["lastname"]] = last_name
        if field_map.get("email"):
            emp_payload[field_map["email"]] = email
        if field_map.get("designation"):
            emp_payload[field_map["designation"]] = "Intern"
        if field_map.get("active"):
            emp_payload[field_map["active"]] = "Active"
        if field_map.get("employee_flag"):
            emp_payload[field_map["employee_flag"]] = "Intern"

        created_emp = create_record(emp_entity, emp_payload)

        intern_id = f"INT-{employee_id}"
        intern_payload = {
            INTERN_FIELDS["intern_id"]: intern_id,
            INTERN_FIELDS["employee_id"]: employee_id,
        }
        created_intern = create_record(INTERN_ENTITY, intern_payload)

        formatted_intern = None
        try:
            record = _fetch_intern_record_by_id(token, intern_id, include_system=True)
            if record:
                formatted_intern = _format_intern_record(record)
        except Exception:
            formatted_intern = None

        return jsonify({
            "success": True,
            "employee_entity": emp_entity,
            "employee_id": employee_id,
            "intern_id": intern_id,
            "employee_payload": emp_payload,
            "employee_created": created_emp,
            "intern_payload": intern_payload,
            "intern_created": created_intern,
            "intern_formatted": formatted_intern,
        }), 201
    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/backfill-leave-balances', methods=['POST'])
def backfill_leave_balances():
    """Backfill leave balance records for employees that don't have them"""
    try:
        token = get_access_token()
        entity_set = get_employee_entity_set(token)
        field_map = get_field_map(entity_set)
        
        # Get all employees
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0"
        }
        
        emp_url = f"{BASE_URL}/{entity_set}"
        emp_resp = requests.get(emp_url, headers=headers)
        emp_resp.raise_for_status()
        employees = emp_resp.json().get("value", [])
        
        # Get existing leave balance records
        leave_url = f"{BASE_URL}/{LEAVE_BALANCE_ENTITY}"
        leave_resp = requests.get(leave_url, headers=headers)
        leave_resp.raise_for_status()
        existing_balances = leave_resp.json().get("value", [])
        existing_emp_ids = {lb.get("crc6f_employeeid") for lb in existing_balances}
        
        created_count = 0
        skipped_count = 0
        errors = []
        
        for emp in employees:
            emp_id = emp.get(field_map.get("id"))
            if not emp_id:
                continue
                
            if emp_id in existing_emp_ids:
                print(f"   ⏭️ Skipping {emp_id} - already has leave balance")
                skipped_count += 1
                continue
            
            try:
                # Get DOJ and calculate experience
                doj_val = emp.get(field_map.get("doj"))
                experience = 0
                if doj_val:
                    experience = calculate_experience(doj_val)
                
                # Get leave allocation
                cl, sl, total, allocation_type = get_leave_allocation_by_experience(experience)
                actual_total = cl + sl
                
                leave_payload = {
                    "crc6f_employeeid": emp_id,
                    "crc6f_cl": str(cl),
                    "crc6f_sl": str(sl),
                    "crc6f_compoff": "0",
                    "crc6f_total": str(total),
                    "crc6f_actualtotal": str(actual_total),
                    "crc6f_leaveallocationtype": allocation_type
                }
                
                create_record(LEAVE_BALANCE_ENTITY, leave_payload)
                print(f"   [OK] Created leave balance for {emp_id} - {allocation_type} (Exp: {experience} years)")
                created_count += 1
            except Exception as e:
                error_msg = f"{emp_id}: {str(e)}"
                print(f"   [ERROR] Failed: {error_msg}")
                errors.append(error_msg)
        
        return jsonify({
            "success": True,
            "created": created_count,
            "skipped": skipped_count,
            "errors": errors if errors else None,
            "message": f"Created {created_count} leave balance records, skipped {skipped_count} existing"
        }), 200
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500

@app.route('/api/test-login-leave-tables', methods=['GET'])
def test_login_leave_tables():
    """Test endpoint to verify login and leave balance tables are accessible"""
    try:
        token = get_access_token()
        results = {}
        
        # Test 1: Check login table
        try:
            login_table = get_login_table(token)
            headers = {
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "OData-MaxVersion": "4.0",
                "OData-Version": "4.0"
            }
            url = f"{BASE_URL}/{login_table}?$top=1"
            resp = requests.get(url, headers=headers)
            results["login_table"] = {
                "table_name": login_table,
                "status": resp.status_code,
                "accessible": resp.status_code == 200,
                "sample_count": len(resp.json().get("value", [])) if resp.status_code == 200 else 0
            }
        except Exception as e:
            results["login_table"] = {"error": str(e)}
        
        # Test 2: Check leave balance table
        try:
            headers = {
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "OData-MaxVersion": "4.0",
                "OData-Version": "4.0"
            }
            url = f"{BASE_URL}/{LEAVE_BALANCE_ENTITY}?$top=1"
            resp = requests.get(url, headers=headers)
            results["leave_balance_table"] = {
                "table_name": LEAVE_BALANCE_ENTITY,
                "status": resp.status_code,
                "accessible": resp.status_code == 200,
                "sample_count": len(resp.json().get("value", [])) if resp.status_code == 200 else 0
            }
        except Exception as e:
            results["leave_balance_table"] = {"error": str(e)}
        
        # Test 3: Try creating a test login record
        try:
            login_table = get_login_table(token)
            test_login = {
                "crc6f_username": "test_user_delete_me@test.com",
                "crc6f_password": _hash_password("Test@123"),
                "crc6f_accesslevel": "L1",
                "crc6f_userid": "USER-999",
                "crc6f_employeename": "Test User",
                "crc6f_user_status": "Active",
                "crc6f_loginattempts": "0"
            }
            create_result = create_record(login_table, test_login)
            results["test_login_creation"] = {"success": True, "result": create_result}
        except Exception as e:
            results["test_login_creation"] = {"success": False, "error": str(e)}
        
        # Test 4: Try creating a test leave balance record
        try:
            test_leave = {
                "crc6f_employeeid": "TEST999",
                "crc6f_cl": "6",
                "crc6f_sl": "6",
                "crc6f_compoff": "0",
                "crc6f_total": "12",
                "crc6f_actualtotal": "12",
                "crc6f_leaveallocationtype": "Type 1"
            }
            create_result = create_record(LEAVE_BALANCE_ENTITY, test_leave)
            results["test_leave_creation"] = {"success": True, "result": create_result}
        except Exception as e:
            results["test_leave_creation"] = {"success": False, "error": str(e)}
        
        return jsonify({"success": True, "tests": results}), 200
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/leaves/approve/<leave_id>', methods=['POST'])
def approve_leave(leave_id):
    """Approve a leave request (admin only)"""
    try:
        print(f"\n{'='*70}")
        print(f"[OK] APPROVE LEAVE REQUEST: {leave_id}")
        print(f"{'='*70}")
        
        data = request.get_json() or {}
        approved_by = data.get('approved_by', 'EMP001')  # Admin employee ID
        
        # Normalize admin ID
        if approved_by.isdigit():
            approved_by = format_employee_id(int(approved_by))
        elif approved_by.upper().startswith("EMP"):
            approved_by = approved_by.upper()
        
        token = get_access_token()
        inbox_entity = get_inbox_entity_set(token)
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0"
        }
        
        # Find the leave record
        safe_leave_id = leave_id.replace("'", "''")
        filter_query = f"?$filter=crc6f_leaveid eq '{safe_leave_id}'"
        url = f"{RESOURCE}/api/data/v9.2/{LEAVE_ENTITY}{filter_query}"
        
        print(f"   [SEARCH] Searching for leave: {url}")
        response = requests.get(url, headers=headers)
        
        if response.status_code != 200:
            print(f"   [ERROR] Failed to find leave record: {response.status_code}")
            return jsonify({"success": False, "error": "Leave record not found"}), 404
        
        records = response.json().get("value", [])
        if not records:
            print(f"   [ERROR] No leave record found with ID: {leave_id}")
            return jsonify({"success": False, "error": "Leave record not found"}), 404
        
        record = records[0]
        record_id = record.get("crc6f_table14id")
        
        if not record_id:
            print(f"   [ERROR] No primary key found in record")
            return jsonify({"success": False, "error": "Invalid leave record"}), 500
        
        # Update the leave status to "Approved"
        update_data = {
            "crc6f_status": "Approved",
            "crc6f_approvedby": approved_by
        }
        
        print(f"   [LOG] Updating leave record {record_id} with status: Approved")
        updated_record = update_record(LEAVE_ENTITY, record_id, update_data)
        
        print(f"[OK] Leave {leave_id} approved successfully by {approved_by}")
        # get mail apporved leave
        start_date = record.get("crc6f_startdate")
        end_date = record.get("crc6f_enddate")

        employee_id = record.get("crc6f_employeeid")
        employee_email = get_employee_email(employee_id)
        employee_name = get_employee_name(employee_id)
        print(employee_email,employee_id)

        if employee_email:
            send_email(
                subject=f"[OK] Leave Approved for {employee_id}",
                recipients=[employee_email],
                body=f"Hello{employee_name} {employee_id}, your leave from {start_date} to {end_date} has been approved by {approved_by}."
            )
        else:
            print(f"[WARN] Could not send mail — no email found for {employee_id}")

        print(f"{'='*70}\n")
        
        return jsonify({
            "success": True,
            "message": f"Leave {leave_id} approved successfully",
            "leave_id": leave_id,
            "approved_by": approved_by,
            "updated_record": updated_record
        }), 200
        
    except Exception as e:
        print(f"[ERROR] Error approving leave: {str(e)}")
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/leaves/reject/<leave_id>', methods=['POST'])
def reject_leave(leave_id):
    """Reject a leave request (admin only) with optional reason"""
    try:
        print(f"\n{'='*70}")
        print(f"[ERROR] REJECT LEAVE REQUEST: {leave_id}")
        print(f"{'='*70}")
        
        data = request.get_json() or {}
        rejected_by = data.get('rejected_by', 'EMP001')  # Admin employee ID
        rejection_reason = data.get('reason', '')  # Optional rejection reason
        
        # Normalize admin ID
        if rejected_by.isdigit():
            rejected_by = format_employee_id(int(rejected_by))
        elif rejected_by.upper().startswith("EMP"):
            rejected_by = rejected_by.upper()
        
        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0"
        }
        
        # Find the leave record
        safe_leave_id = leave_id.replace("'", "''")
        filter_query = f"?$filter=crc6f_leaveid eq '{safe_leave_id}'"
        url = f"{RESOURCE}/api/data/v9.2/{LEAVE_ENTITY}{filter_query}"
        
        print(f"   [SEARCH] Searching for leave: {url}")
        response = requests.get(url, headers=headers)
        
        if response.status_code != 200:
            print(f"   [ERROR] Failed to find leave record: {response.status_code}")
            return jsonify({"success": False, "error": "Leave record not found"}), 404
        
        records = response.json().get("value", [])
        if not records:
            print(f"   [ERROR] No leave record found with ID: {leave_id}")
            return jsonify({"success": False, "error": "Leave record not found"}), 404
        
        record = records[0]
        record_id = record.get("crc6f_table14id")
        employee_id = record.get("crc6f_employeeid")
        leave_type = record.get("crc6f_leavetype")
        total_days = float(record.get("crc6f_totaldays", 0))
        paid_unpaid = record.get("crc6f_paidunpaid", "Unpaid")
        
        if not record_id:
            print(f"   [ERROR] No primary key found in record")
            return jsonify({"success": False, "error": "Invalid leave record"}), 500
        
        # Update the leave status to "Rejected"
        # Note: Using crc6f_approvedby for both approval and rejection since there's no separate rejected_by field
        update_data = {
            "crc6f_status": "Rejected",
            "crc6f_approvedby": rejected_by
        }
        
        # Add rejection reason if provided
        if rejection_reason:
            update_data["crc6f_rejectionreason"] = rejection_reason
            print(f"   💬 Rejection reason stored: {rejection_reason}")
        
        print(f"   [LOG] Updating leave record {record_id} with status: Rejected")
        
        updated_record = update_record(LEAVE_ENTITY, record_id, update_data)
        
        # If the leave was paid and had been deducted, restore the balance
        if paid_unpaid.lower() == "paid" and total_days > 0 and employee_id:
            try:
                print(f"   [PROC] Restoring {total_days} days of {leave_type} to {employee_id}")
                balance_row = _fetch_leave_balance(token, employee_id)
                if balance_row:
                    # Increment the leave balance since leave was rejected
                    balance_record_id = balance_row.get("crc6f_hr_leavemangementid")
                    if balance_record_id:
                        # Determine which field to update
                        leave_type_lower = leave_type.lower()
                        balance_update = {}
                        
                        if "casual" in leave_type_lower:
                            current_balance = float(balance_row.get("crc6f_cl", 0) or 0)
                            balance_update["crc6f_cl"] = current_balance + total_days
                        elif "sick" in leave_type_lower:
                            current_balance = float(balance_row.get("crc6f_sl", 0) or 0)
                            balance_update["crc6f_sl"] = current_balance + total_days
                        elif "comp" in leave_type_lower:
                            current_balance = float(balance_row.get("crc6f_compoff", 0) or 0)
                            balance_update["crc6f_compoff"] = current_balance + total_days
                        
                        if balance_update:
                            entity_set = LEAVE_BALANCE_ENTITY_RESOLVED or LEAVE_BALANCE_ENTITY
                            update_record(entity_set, balance_record_id, balance_update)
                            print(f"   [OK] Balance restored: {balance_update}")
            except Exception as restore_err:
                print(f"   [WARN] Failed to restore balance: {restore_err}")
        
        print(f"[OK] Leave {leave_id} rejected successfully by {rejected_by}")
        # mail reject leave
        start_date = record.get("crc6f_startdate")
        end_date = record.get("crc6f_enddate")

        employee_id = record.get("crc6f_employeeid")
        employee_email = get_employee_email(employee_id)
        employee_name = get_employee_name(employee_id)
        print(employee_email,employee_id)

        if employee_email:
            send_email(
                subject=f"[OK] Leave Approved for {employee_id}",
                recipients=[employee_email],
                body=f"Hello {employee_name} {employee_id}, your leave from {start_date} to {end_date} has been approved by {rejected_by}."
            )
        else:
            print(f"[WARN] Could not send mail — no email found for {employee_id}")

        print(f"{'='*70}\n")
        
        return jsonify({
            "success": True,
            "message": f"Leave {leave_id} rejected successfully",
            "leave_id": leave_id,
            "rejected_by": rejected_by,
            "reason": rejection_reason,
            "updated_record": updated_record
        }), 200
        
    except Exception as e:
        print(f"[ERROR] Error rejecting leave: {str(e)}")
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/leaves/pending', methods=['GET'])
def get_pending_leaves():
    """Get all pending leave requests (for admin review)"""
    try:
        print(f"\n{'='*70}")
        print(f"[FETCH] FETCHING ALL PENDING LEAVE REQUESTS")
        print(f"{'='*70}")
        
        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0"
        }
        
        # Fetch all pending leaves
        filter_query = "?$filter=crc6f_status eq 'Pending'"
        url = f"{RESOURCE}/api/data/v9.2/{LEAVE_ENTITY}{filter_query}"
        
        print(f"   [URL] Request URL: {url}")
        response = requests.get(url, headers=headers)
        
        if response.status_code != 200:
            print(f"   [ERROR] Failed to fetch pending leaves: {response.status_code}")
            print("   [WARN] Falling back to empty pending-leave list to keep UI responsive")
            return jsonify({
                "success": True,
                "leaves": [],
                "count": 0,
                "warning": "Pending leaves unavailable (Dataverse error)"
            }), 200
        
        records = response.json().get("value", [])
        print(f"   [DATA] Found {len(records)} pending leave requests")
        
        formatted_leaves = []
        for r in records:
            formatted_leaves.append({
                "leave_id": r.get("crc6f_leaveid"),
                "leave_type": r.get("crc6f_leavetype"),
                "start_date": r.get("crc6f_startdate"),
                "end_date": r.get("crc6f_enddate"),
                "total_days": r.get("crc6f_totaldays"),
                "status": r.get("crc6f_status"),
                "paid_unpaid": r.get("crc6f_paidunpaid"),
                "approved_by": r.get("crc6f_approvedby"),
                "rejection_reason": r.get("crc6f_rejectionreason"),
                "employee_id": r.get("crc6f_employeeid")
            })
        
        print(f"[OK] Successfully fetched {len(formatted_leaves)} pending leaves")
        print(f"{'='*70}\n")
        
        return jsonify({
            "success": True,
            "leaves": formatted_leaves,
            "count": len(formatted_leaves)
        }), 200
        
    except Exception as e:
        print(f"[ERROR] Error fetching pending leaves: {str(e)}")
        traceback.print_exc()
        print("[WARN] Returning empty pending-leave list due to backend failure")
        return jsonify({
            "success": True,
            "leaves": [],
            "count": 0,
            "warning": "Pending leaves unavailable (backend error)"
        }), 200


# ================== UTILITY ROUTES ==================
@app.route('/ping', methods=['GET'])
def ping():
    """Health check endpoint"""
    return jsonify({
        "message": "Unified Backend Server is running [OK]",
        "services": ["attendance", "leave_tracker", "asset_management", "employee_master"],
        "timestamp": datetime.now().isoformat()
    }), 200


@app.route('/api/info', methods=['GET'])
def api_info():
    """API information endpoint"""
    return jsonify({
        "server": "Unified HR Management Backend",
        "version": "2.0.0",
        "endpoints": {
            "attendance": {
                "checkin": "POST /api/checkin",
                "checkout": "POST /api/checkout",
                "status": "GET /api/status/<employee_id>",
                "monthly": "GET /api/attendance/<employee_id>/<year>/<month>"
            },
            "leave": {
                "apply": "POST /apply_leave",
                "history": "GET /api/leaves/<employee_id>",
                "balance": "GET /api/leave-balance/<employee_id>/<leave_type>",
                "test": "GET /test_connection"
            },
            "employees": {
                "list": "GET /api/employees",
                "create": "POST /api/employees",
                "bulk_upload": "POST /api/employees/bulk"
            },
            "assets": {
                "list": "GET /assets",
                "create": "POST /assets",
                "update": "PATCH /assets/update/<asset_id>",
                "delete": "DELETE /assets/delete/<asset_id>"
            },
            "utility": {
                "ping": "GET /ping",
                "info": "GET /api/info"
            }
        }
    }), 200


@app.route('/api/leave-balance/raw/<employee_id>', methods=['GET'])
def debug_leave_balance_raw(employee_id):
    """Diagnostic: return the raw leave-balance row for an employee.
    Useful to confirm column names and primary id when updates don't stick.
    """
    try:
        token = get_access_token()
        row = _fetch_leave_balance(token, employee_id)
        return jsonify({
            "success": True,
            "employee_id": employee_id,
            "entity_set": LEAVE_BALANCE_ENTITY_RESOLVED or LEAVE_BALANCE_ENTITY,
            "row": row or {}
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ================== EMPLOYEE MASTER ROUTES ==================
@app.route('/api/employees', methods=['GET'])
def list_employees():
    try:
        print(f"\n{'='*60}")
        print(f"[FETCH] LIST EMPLOYEES REQUEST")
        print(f"{'='*60}")
        token = get_access_token()
        entity_set = get_employee_entity_set(token)
        field_map = get_field_map(entity_set)
        print(f"   [ORG] Entity Set: {entity_set}")
        print(f"   🗺️ Field Map: {field_map}")
        print(f"   [DATE] DOJ Field: {field_map.get('doj')}")
        print(f"   [WARN] DEBUGGING: About to process employee records...")
        import sys
        sys.stdout.flush()
        
        # pagination params
        page = int(request.args.get('page', 1))
        page_size = int(request.args.get('pageSize', 5))
        if page < 1:
            page = 1
        if page_size < 1:
            page_size = 5
        skip = (page - 1) * page_size
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0"
        }
        
        # Build $select from available fields in this entity
        select_list = [field_map[k] for k in ['id', 'fullname', 'firstname', 'lastname', 'email', 'contact', 'address', 'department', 'designation', 'doj', 'active', 'primary'] if field_map.get(k)]
        if field_map.get('employee_flag'):
            select_list.append(field_map['employee_flag'])
        
        # Only include alternate email fields for crc6f_employees table (not crc6f_table12s)
        if entity_set == "crc6f_employees":
            email_alts = ['crc6f_officialemail', 'crc6f_emailaddress', 'emailaddress', 'officialemail', 'crc6f_mail', 'crc6f_quotahours']
            for alt in email_alts:
                if alt not in select_list:
                    select_list.append(alt)
        select_fields = f"$select={','.join(select_list)}"
        print(f"   [FETCH] DOJ field mapping: {field_map.get('doj')}")
        print(f"   [FETCH] Select fields: {select_fields}")
        # Fetch all records (or a large number) to support pagination
        # Using a high limit to get all records since Dataverse doesn't support $skip well
        fetch_count = 5000  # Fetch up to 5000 records (adjust if you have more employees)
        top = f"$top={fetch_count}"
        # Order by creation date descending to show newest first
        orderby = f"$orderby=createdon desc"
        url = f"{RESOURCE}/api/data/v9.2/{entity_set}?{select_fields}&{top}&{orderby}"
        print(f"   [URL] Requesting: {url}")
        resp = requests.get(url, headers=headers)
        print(f"   [DATA] Response Status: {resp.status_code}")
        if resp.status_code != 200:
            # If 400, try a simpler request without $count/$orderby which can fail on some orgs
            if resp.status_code == 400:
                simple_url = f"{RESOURCE}/api/data/v9.2/{entity_set}?{select_fields}&$top={fetch_count}"
                simple_headers = {
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/json",
                    "OData-MaxVersion": "4.0",
                    "OData-Version": "4.0"
                }
                simple_resp = requests.get(simple_url, headers=simple_headers)
                print(f"   [PROC] Fallback response status: {simple_resp.status_code}")
                if simple_resp.status_code == 200:
                    body = simple_resp.json()
                    all_records = body.get("value", [])
                    print(f"   [DATA] Found {len(all_records)} total records in Dataverse")
                    # Slice for requested page
                    start_idx = skip
                    end_idx = start_idx + page_size
                    records = all_records[start_idx:end_idx]
                    items = []
                    def _pick_email(rec: dict, field_map: dict):
                        # Primary
                        val = rec.get(field_map.get('email')) if field_map.get('email') else None
                        def _is_email(v):
                            return isinstance(v, str) and '@' in v and '.' in v
                        if _is_email(val):
                            return val
                        # Common alternates
                        for k in ['crc6f_officialemail', 'crc6f_emailaddress', 'emailaddress', 'officialemail', 'crc6f_mail', 'crc6f_quotahours']:
                            v = rec.get(k)
                            if _is_email(v):
                                return v
                        # Scan any field for an email-like string
                        for k, v in rec.items():
                            if _is_email(v):
                                return v
                        return val or ''

                    for r in records:
                        # Extract name fields based on table structure
                        if field_map['fullname']:
                            fullname = r.get(field_map['fullname'], '')
                            parts = fullname.split(' ', 1)
                            first_name = parts[0] if parts else ''
                            last_name = parts[1] if len(parts) > 1 else ''
                        else:
                            first_name = r.get(field_map['firstname'], '')
                            last_name = r.get(field_map['lastname'], '')
                        
                        # Read values directly from Dataverse fields (no swap needed)
                        contact_from_db = r.get(field_map['contact'])
                        address_from_db = r.get(field_map['address'])
                        
                        # Try multiple possible DOJ field names
                        doj_value = r.get(field_map['doj'])
                        original_doj_field = field_map['doj']
                        print(f"   [SEARCH] Processing employee {r.get(field_map['id'])}, DOJ field: {original_doj_field}, value: {doj_value}")
                        
                        if not doj_value or doj_value == "Power BI Developer" or isinstance(doj_value, str) and not any(char.isdigit() for char in doj_value):
                            # Try alternative field names - comprehensive list
                            possible_doj_fields = [
                                'crc6f_doj',
                                'crc6f_dateofjoining', 
                                'crc6f_joiningdate',
                                'crc6f_joindate',
                                'crc6f_date_of_joining',
                                'crc6f_joining_date',
                                'crc6f_startdate',
                                'crc6f_hiredate',
                                'crc6f_employmentstartdate'
                            ]
                            
                            print(f"   [WARN] DOJ field '{original_doj_field}' returned invalid value: {doj_value}")
                            print(f"   [SEARCH] Searching alternative fields in record...")
                            
                            for field_name in possible_doj_fields:
                                if field_name in r:
                                    test_value = r.get(field_name)
                                    print(f"      Checking {field_name}: {test_value}")
                                    # Check if this looks like a date (contains numbers, dashes, or slashes)
                                    if test_value and isinstance(test_value, str) and (
                                        any(char.isdigit() for char in test_value) and 
                                        ('-' in test_value or '/' in test_value or 'T' in test_value)
                                    ):
                                        doj_value = test_value
                                        print(f"   [OK] Found DOJ in field: {field_name} = {doj_value}")
                                        break
                                    elif test_value and not isinstance(test_value, str):
                                        # Could be a date object
                                        doj_value = test_value
                                        print(f"   [OK] Found DOJ object in field: {field_name} = {doj_value}")
                                        break
                        
                        # Debug DOJ values for first few records
                        if len(items) < 3:
                            print(f"   [SEARCH] Employee {r.get(field_map['id'])} DOJ debug:")
                            print(f"      DOJ field name: {field_map['doj']}")
                            print(f"      DOJ raw value: {doj_value}")
                            print(f"      DOJ type: {type(doj_value)}")
                            print(f"      All record keys: {list(r.keys())[:10]}...")  # Show first 10 keys
                        
                        items.append({
                            "employee_id": r.get(field_map['id']),
                            "record_guid": r.get(field_map.get('primary')) if field_map.get('primary') else None,
                            "first_name": first_name,
                            "last_name": last_name,
                            "email": _pick_email(r, field_map),
                            "contact_number": contact_from_db,
                            "address": address_from_db,
                            "department": r.get(field_map['department']),
                            "designation": r.get(field_map['designation']),
                            "doj": doj_value,
                            "active": r.get(field_map['active']),
                            "employee_flag": r.get(field_map.get('employee_flag'))
                        })
                    return jsonify({
                        "success": True,
                        "employees": items,
                        "count": len(items),
                        "total": len(all_records),
                        "page": page,
                        "pageSize": page_size,
                        "note": "Client-side pagination (no $skip support)",
                        "entitySet": entity_set
                    })
            # Bubble up Dataverse error details for debugging
            try:
                err_body = resp.json()
            except Exception:
                err_body = resp.text
            return jsonify({
                "success": False,
                "error": f"Failed to fetch employees: {resp.status_code}",
                "details": err_body,
                "requestUrl": url,
                "entitySet": entity_set
            }), 500
        body = resp.json()
        all_records = body.get("value", [])
        print(f"   [OK] Successfully retrieved {len(all_records)} records from Dataverse")
        total_count = len(all_records)  # Total fetched so far
        
        # Slice records for the requested page (client-side pagination)
        start_idx = skip
        end_idx = start_idx + page_size
        records = all_records[start_idx:end_idx]
        
        items = []
        def _pick_email(rec: dict, field_map: dict):
            # Primary
            val = rec.get(field_map.get('email')) if field_map.get('email') else None
            def _is_email(v):
                return isinstance(v, str) and '@' in v and '.' in v
            if _is_email(val):
                return val
            # Common alternates
            for k in ['crc6f_officialemail', 'crc6f_emailaddress', 'emailaddress', 'officialemail', 'crc6f_mail', 'crc6f_quotahours']:
                v = rec.get(k)
                if _is_email(v):
                    return v
            # Scan any field for an email-like string
            for k, v in rec.items():
                if _is_email(v):
                    return v
            return val or ''

        for idx, r in enumerate(records):
            # Extract name fields based on table structure
            if field_map['fullname']:
                fullname = r.get(field_map['fullname'], '')
                parts = fullname.split(' ', 1)
                first_name = parts[0] if parts else ''
                last_name = parts[1] if len(parts) > 1 else ''
            else:
                first_name = r.get(field_map['firstname'], '')
                last_name = r.get(field_map['lastname'], '')
            
            # Read values directly from Dataverse fields (no swap needed)
            contact_from_db = r.get(field_map['contact'])
            address_from_db = r.get(field_map['address'])
            
            if idx < 2:  # Log first 2 records for debugging
                print(f"[SEARCH] DEBUG - Employee {idx + 1} retrieval:")
                print(f"   Dataverse {field_map['contact']} = {contact_from_db}")
                print(f"   Dataverse {field_map['address']} = {address_from_db}")
            
            items.append({
                "employee_id": r.get(field_map['id']),
                "record_guid": r.get(field_map.get('primary')) if field_map.get('primary') else None,
                "first_name": first_name,
                "last_name": last_name,
                "email": _pick_email(r, field_map),
                "contact_number": contact_from_db,
                "address": address_from_db,
                "department": r.get(field_map['department']),
                "designation": r.get(field_map['designation']),
                "doj": r.get(field_map['doj']),
                "active": r.get(field_map['active']),
                "employee_flag": r.get(field_map.get('employee_flag'))
            })
        print(f"   [SEND] Returning {len(items)} items for page {page}")
        print(f"{'='*60}\n")
        return jsonify({
            "success": True,
            "employees": items,
            "count": len(items),
            "total": total_count,
            "page": page,
            "pageSize": page_size,
            "entitySet": entity_set
        })
    except Exception as e:
        print(f"   [ERROR] ERROR: {str(e)}")
        import traceback
        traceback.print_exc()
        print(f"{'='*60}\n")
        msg = str(e) or ""
        if "login.microsoftonline.com" in msg or "NameResolutionError" in msg:
            print("   [WARN] Azure AD/Dataverse unreachable. Returning empty employee list for fallback.")
            try:
                page_size = int(request.args.get('pageSize', 5))
            except Exception:
                page_size = 5
            return jsonify({
                "success": True,
                "employees": [],
                "count": 0,
                "total": 0,
                "page": 1,
                "pageSize": page_size,
                "note": "Azure AD/Dataverse unreachable; returning empty list."
            }), 200
        return jsonify({"success": False, "error": str(e)}), 500
# ============================================================
# NEW ROUTE: Get full Employee Master list (No pagination)
# ============================================================
@app.route('/api/employees/all', methods=['GET'])
def get_all_employees():
    """
    Return the complete employee master list for dropdowns, validation, or name lookups.
    Does NOT affect the existing paginated list_employees() function.
    """
    try:
        print(f"\n{'='*60}")
        print("[FETCH] FETCHING FULL EMPLOYEE MASTER LIST (NO PAGINATION)")
        print(f"{'='*60}")

        # --- Auth + Metadata
        token = get_access_token()
        entity_set = get_employee_entity_set(token)
        field_map = get_field_map(entity_set)

        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0"
        }

        # --- Fetch up to 5000 employees safely
        fetch_count = 5000
        select_list = [
            field_map[k]
            for k in ['id', 'fullname', 'firstname', 'lastname',
                      'email', 'department', 'designation', 'active']
            if field_map.get(k)
        ]

        select_fields = f"$select={','.join(select_list)}"
        url = f"{RESOURCE}/api/data/v9.2/{entity_set}?{select_fields}&$top={fetch_count}&$orderby=createdon desc"

        print(f"[URL] Fetching from Dataverse: {url}")
        resp = requests.get(url, headers=headers)
        print(f"[DATA] Dataverse status: {resp.status_code}")

        if resp.status_code != 200:
            print(f"[ERROR] Dataverse error: {resp.text}")
            return jsonify({
                "success": False,
                "error": f"Failed to fetch employees ({resp.status_code})",
                "details": resp.text
            }), 500

        data = resp.json()
        records = data.get("value", [])
        print(f"[OK] Retrieved {len(records)} employee records")

        employees = []
        for rec in records:
            # --- Extract name fields correctly
            if field_map.get('fullname'):
                fullname = rec.get(field_map['fullname'], '').strip()
                parts = fullname.split(' ', 1)
                first_name = parts[0] if parts else ''
                last_name = parts[1] if len(parts) > 1 else ''
            else:
                first_name = rec.get(field_map.get('firstname'), '')
                last_name = rec.get(field_map.get('lastname'), '')

            employees.append({
                "employee_id": rec.get(field_map.get('id')),
                "first_name": first_name,
                "last_name": last_name,
                "email": rec.get(field_map.get('email')),
                "department": rec.get(field_map.get('department')),
                "designation": rec.get(field_map.get('designation')),
                "active": rec.get(field_map.get('active')),
            })

        print(f"[SEND] Returning {len(employees)} total employees")
        print(f"{'='*60}\n")

        return jsonify({
            "success": True,
            "count": len(employees),
            "employees": employees
        }), 200

    except Exception as e:
        print(f"[ERROR] ERROR in /api/employees/all: {str(e)}")
        import traceback
        traceback.print_exc()
        print(f"{'='*60}\n")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/employees', methods=['POST'])
def create_employee():
    try:
        token = get_access_token()
        entity_set = get_employee_entity_set(token)
        field_map = get_field_map(entity_set)
        data = request.get_json(force=True)
        
        # Build payload based on table structure
        payload = {}
        
        employee_id = (data.get("employee_id") or "").strip()
        first_name = data.get("first_name", "")
        last_name = data.get("last_name", "")
        email = data.get("email", "")
        designation = data.get("designation", "")
        doj = data.get("doj")
        contact_number = data.get("contact_number", "")
        employee_flag = (data.get("employee_flag") or "Employee").strip() or "Employee"

        # ==================== EXTERNAL DATA UPLOAD CATCH ====================
        # Let Dataverse auto-number when no employee_id supplied
        auto_generated_id = False
        if not employee_id:
            print(f"\n[PROC] No employee_id supplied — generating new ID")
            employee_id = generate_employee_id()
            auto_generated_id = True
            print(f"   [ID] Generated Employee ID: {employee_id}")
        else:
            auto_generated_id = True

        # Check for duplicate email or contact number
        if email:
            safe_email = email.strip().replace("'", "''")
            check_url = f"{BASE_URL}/{entity_set}?$filter=crc6f_email eq '{safe_email}'"
            check_response = requests.get(check_url, headers={"Authorization": f"Bearer {token}"})
            if check_response.status_code == 200:
                existing = check_response.json().get('value', [])
                if existing:
                    print(f"[WARN] Duplicate email found: {email}")
                    return jsonify({"success": False, "error": f"Employee with email {email} already exists"}), 400
        
        if contact_number:
            safe_contact = contact_number.strip().replace("'", "''")
            check_url = f"{BASE_URL}/{entity_set}?$filter=crc6f_contactnumber eq '{safe_contact}'"
            check_response = requests.get(check_url, headers={"Authorization": f"Bearer {token}"})
            if check_response.status_code == 200:
                existing = check_response.json().get('value', [])
                if existing:
                    print(f"[WARN] Duplicate contact number found: {contact_number}")
                    return jsonify({"success": False, "error": f"Employee with contact number {contact_number} already exists"}), 400
        # ==================== END EXTERNAL DATA UPLOAD CATCH ====================
        
        if field_map['id'] and employee_id:
            payload[field_map['id']] = employee_id
        
        # Handle name fields
        if field_map['fullname']:
            # Combine first and last name into fullname
            payload[field_map['fullname']] = f"{first_name} {last_name}".strip()
        else:
            if field_map['firstname']:
                payload[field_map['firstname']] = first_name
            if field_map['lastname']:
                payload[field_map['lastname']] = last_name
        
        # Other fields
        if field_map['email']:
            payload[field_map['email']] = email
        if field_map['contact']:
            payload[field_map['contact']] = data.get("contact_number")
        if field_map['address']:
            payload[field_map['address']] = data.get("address")
        if field_map['department']:
            payload[field_map['department']] = data.get("department")
        if field_map['designation']:
            payload[field_map['designation']] = designation
        if field_map['doj']:
            payload[field_map['doj']] = doj
        if field_map['active']:
            # Convert boolean to string format expected by Dataverse
            active_value = data.get("active")
            if isinstance(active_value, bool):
                payload[field_map['active']] = "Active" if active_value else "Inactive"
            else:
                # Handle string values
                payload[field_map['active']] = "Active" if str(active_value).lower() in ['true', '1', 'active'] else "Inactive"
        
        # Employee flag (e.g., Intern / Employee)
        if field_map.get('employee_flag') and employee_flag:
            payload[field_map['employee_flag']] = employee_flag

        # Calculate and add experience (years from DOJ to current date)
        if field_map.get('experience') and doj:
            experience = calculate_experience(doj)
            payload[field_map['experience']] = str(experience)
            print(f"   [DATA] Set experience: {experience} years")
        
        # Set quota hours to 9 for all employees
        if field_map.get('quota_hours'):
            payload[field_map['quota_hours']] = "9"
            print(f"   [ALARM] Set quota hours: 9")
        
        created = create_record(entity_set, payload)
        
        # Auto-create login record for the new employee
        if email:
            try:
                print(f"\n   [USER] Creating login record for {email}")
                
                # Check if login already exists
                login_table = get_login_table(token)
                headers_check = {
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/json",
                    "OData-MaxVersion": "4.0",
                    "OData-Version": "4.0"
                }
                safe_email = email.strip().replace("'", "''")
                check_url = f"{BASE_URL}/{login_table}?$top=1&$filter=crc6f_username eq '{safe_email}'"
                resp_check = requests.get(check_url, headers=headers_check)
                
                login_exists = False
                if resp_check.status_code == 200:
                    existing_logins = resp_check.json().get("value", [])
                    login_exists = len(existing_logins) > 0
                    if login_exists:
                        print(f"   ℹ️ Login already exists for {email}, skipping creation")
                
                if not login_exists:
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
                    
                    print(f"   [LOG] Login payload: {login_payload}")
                    result = create_record(login_table, login_payload)
                    print(f"   [OK] Login created: {email} | Access Level: {access_level} | User ID: {user_id}")
                    print(f"   [FETCH] Create result: {result}")
                    
                    # Send login credentials email for external uploads
                    if auto_generated_id:
                        print(f"\n[MAIL] Sending login credentials email for external upload...")
                        credentials = {
                            'username': email,
                            'password': default_password
                        }
                        employee_data = {
                            'email': email,
                            'firstname': first_name,
                            'lastname': last_name,
                            'employee_id': employee_id
                        }
                        send_login_credentials_email(employee_data, credentials)
                        print(f"[OK] Login credentials email sent to {email}")
            except Exception as login_err:
                print(f"   [ERROR] Failed to create login record: {login_err}")
                import traceback
                traceback.print_exc()
                # Don't fail employee creation if login creation fails
        
        # Auto-create leave balance record for the new employee
        if employee_id:
            try:
                print(f"\n   [FETCH] Creating leave balance for {employee_id}")
                
                # Calculate experience if DOJ is provided
                experience = 0
                if doj:
                    experience = calculate_experience(doj)
                
                # Get leave allocation based on experience
                cl, sl, total, allocation_type = get_leave_allocation_by_experience(experience)
                actual_total = cl + sl  # Actual total = CL + SL (no comp off initially)
                
                print(f"   [DATA] Experience: {experience} years -> {allocation_type}")
                print(f"   [FETCH] Leave allocation: CL={cl}, SL={sl}, Total Quota={total}")
                
                leave_payload = {
                    "crc6f_employeeid": employee_id,
                    "crc6f_cl": str(cl),
                    "crc6f_sl": str(sl),
                    "crc6f_compoff": "0",
                    "crc6f_total": str(total),
                    "crc6f_actualtotal": str(actual_total),
                    "crc6f_leaveallocationtype": allocation_type
                }
                
                print(f"   [LOG] Leave balance payload: {leave_payload}")
                print(f"   -> Target table: {LEAVE_BALANCE_ENTITY}")
                result = create_record(LEAVE_BALANCE_ENTITY, leave_payload)
                print(f"   [OK] Leave balance created for {employee_id}")
                print(f"   [FETCH] Create result: {result}")
            except Exception as leave_err:
                print(f"   [ERROR] Failed to create leave balance: {leave_err}")
                import traceback
                traceback.print_exc()
                # Don't fail employee creation if leave balance creation fails
        
        return jsonify({"success": True, "employee": created, "entitySet": entity_set}), 201
    except Exception as e:
        print(f"   [ERROR] Error creating employee: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


# ================== INTERN ROUTES ==================
def _build_intern_select_fields(include_system=False):
    base = {v for v in INTERN_FIELDS.values() if v}
    if include_system:
        base.update({"createdon", "modifiedon"})
    else:
        base.add("createdon")
    return sorted(base)


@app.route('/api/interns', methods=['GET'])
def list_interns():
    """List interns from Dataverse with simple pagination."""
    try:
        page = max(1, int(request.args.get('page', 1)))
        page_size = max(1, int(request.args.get('pageSize', 10)))
        skip = (page - 1) * page_size

        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0",
        }
        # 1) Resolve which employees are marked as "Intern" in the master table
        intern_employee_ids = None
        intern_employee_records = []

        try:
            emp_entity = get_employee_entity_set(token)
            field_map = get_field_map(emp_entity)
            emp_id_field = field_map.get("id") or "crc6f_employeeid"

            emp_headers = {
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "OData-MaxVersion": "4.0",
                "OData-Version": "4.0",
            }

            # Fetch all employees where crc6f_employeeflag = 'Intern'
            emp_select_fields = {emp_id_field, "crc6f_employeeflag", "createdon"}
            primary_field = field_map.get("primary")
            if primary_field:
                emp_select_fields.add(primary_field)
            emp_select = "$select=" + ",".join(emp_select_fields)
            emp_filter = "$filter=crc6f_employeeflag eq 'Intern'"
            emp_url = f"{RESOURCE}/api/data/v9.2/{emp_entity}?{emp_select}&$top=5000&{emp_filter}"

            emp_resp = requests.get(emp_url, headers=emp_headers, timeout=30)
            if emp_resp.status_code == 200:
                intern_employee_ids = set()
                for er in emp_resp.json().get("value", []):
                    flag_val = (er.get("crc6f_employeeflag") or "").strip().lower()
                    if flag_val == "intern":
                        emp_id_val = _normalize_employee_id(er.get(emp_id_field))
                        if emp_id_val:
                            intern_employee_ids.add(emp_id_val)
                            intern_employee_records.append({
                                "employee_id": emp_id_val,
                                "created_on": er.get("createdon"),
                            })
            else:
                print(f"[WARN] Failed to fetch employees with Intern flag: {emp_resp.status_code} {emp_resp.text}")
                intern_employee_ids = None

        except Exception as emp_err:
            print(f"[WARN] Error while resolving Intern employees: {emp_err}")
            intern_employee_ids = None

        # 2) Fetch intern details table and keep only rows whose employee exists in the Intern set
        select_fields = _build_intern_select_fields()
        select_clause = ','.join(select_fields)
        fetch_count = 5000
        url = f"{RESOURCE}/api/data/v9.2/{INTERN_ENTITY}?$select={select_clause}&$top={fetch_count}&$orderby=createdon desc"

        resp = requests.get(url, headers=headers, timeout=30)
        if resp.status_code != 200:
            return jsonify({
                "success": False,
                "error": f"Failed to fetch interns: {resp.status_code}",
                "details": resp.text
            }), 500

        raw_records = resp.json().get("value", [])

        # If we successfully loaded intern employee IDs, filter records by that set
        if intern_employee_ids is not None:
            all_records = []
            existing_ids = set()
            for rec in raw_records:
                emp_id_val = _normalize_employee_id(rec.get(INTERN_FIELDS['employee_id']))
                if emp_id_val and emp_id_val in intern_employee_ids:
                    all_records.append(rec)
                    existing_ids.add(emp_id_val)

            # Add synthetic entries for flagged employees that don't yet have intern detail rows
            for flagged in intern_employee_records:
                fid = flagged.get("employee_id")
                if not fid or fid in existing_ids:
                    continue
                synthetic = {
                    INTERN_FIELDS['intern_id']: fid,
                    INTERN_FIELDS['employee_id']: fid,
                    "createdon": flagged.get("created_on") or datetime.utcnow().isoformat()
                }
                all_records.append(synthetic)
        else:
            # Fallback: no employee-filter available, keep all intern records
            all_records = list(raw_records)

        total_count = len(all_records)
        records = all_records[skip: skip + page_size]

        interns = []
        for rec in records:
            interns.append({
                "intern_id": rec.get(INTERN_FIELDS['intern_id']),
                "employee_id": rec.get(INTERN_FIELDS['employee_id']),
                "record_id": rec.get(INTERN_FIELDS['primary']) or rec.get('crc6f_hr_interndetailsid'),
                "created_on": rec.get('createdon'),
            })

        return jsonify({
            "success": True,
            "interns": interns,
            "count": len(interns),
            "total": total_count,
            "page": page,
            "pageSize": page_size
        }), 200
    except Exception as e:
        print(f"[ERROR] list_interns failed: {e}")
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/interns/<intern_id>', methods=['GET'])
def get_intern_detail(intern_id):
    """Fetch a single intern record with phase breakdown."""
    try:
        token = get_access_token()
        record = _fetch_intern_record_by_id(token, intern_id, include_system=True)
        
        # If no intern record found, check if this is an employee flagged as Intern
        if not record:
            try:
                entity_set = get_employee_entity_set(token)
                field_map = get_field_map(entity_set)
                emp_id_field = field_map.get("id") or "crc6f_employeeid"
                
                emp_headers = {
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/json",
                    "OData-MaxVersion": "4.0",
                    "OData-Version": "4.0",
                }
                
                safe_id = (intern_id or '').replace("'", "''")
                emp_filter = f"$filter={emp_id_field} eq '{safe_id}' and crc6f_employeeflag eq 'Intern'"
                emp_url = f"{RESOURCE}/api/data/v9.2/{entity_set}?{emp_filter}&$top=1"
                
                emp_resp = requests.get(emp_url, headers=emp_headers, timeout=30)
                if emp_resp.status_code == 200:
                    emp_records = emp_resp.json().get("value", [])
                    if emp_records:
                        emp_rec = emp_records[0]
                        record = {
                            INTERN_FIELDS['intern_id']: intern_id,
                            INTERN_FIELDS['employee_id']: intern_id,
                            "createdon": emp_rec.get("createdon"),
                            "_synthetic": True
                        }
            except Exception as emp_check_err:
                print(f"[WARN] Failed to check employee flag for {intern_id}: {emp_check_err}")
        
        if not record:
            return jsonify({"success": False, "error": "Intern not found"}), 404
        formatted = _format_intern_record(record)

        # Attach basic employee master details for sidebar card
        try:
            emp_id = formatted.get("employee_id")
            if emp_id:
                entity_set = get_employee_entity_set(token)
                field_map = get_field_map(entity_set)
                select_extra = []
                for key in ["email", "contact", "address", "department", "designation", "doj", "fullname", "firstname", "lastname"]:
                    logical = field_map.get(key)
                    if logical:
                        select_extra.append(logical)

                emp_record = _fetch_employee_by_employee_id(token, emp_id, select_fields=select_extra)
                if emp_record:
                    full_name = ""
                    first_name = ""
                    last_name = ""
                    if field_map.get("fullname"):
                        full_name = emp_record.get(field_map["fullname"], "") or ""
                        parts = full_name.split(" ", 1)
                        first_name = parts[0] if parts else ""
                        last_name = parts[1] if len(parts) > 1 else ""
                    else:
                        first_name = emp_record.get(field_map.get("firstname"), "") or ""
                        last_name = emp_record.get(field_map.get("lastname"), "") or ""
                        full_name = f"{first_name} {last_name}".strip()

                    employee_details = {
                        "employee_id": emp_record.get(field_map.get("id")),
                        "first_name": first_name,
                        "last_name": last_name,
                        "full_name": full_name,
                        "email": emp_record.get(field_map.get("email")),
                        "contact_number": emp_record.get(field_map.get("contact")),
                        "address": emp_record.get(field_map.get("address")),
                        "designation": emp_record.get(field_map.get("designation")),
                        "department": emp_record.get(field_map.get("department")),
                        "doj": emp_record.get(field_map.get("doj")),
                    }
                    formatted["employee"] = employee_details
        except Exception as emp_err:
            print(f"[WARN] Failed to enrich intern {intern_id} with employee details: {emp_err}")

        return jsonify({"success": True, "intern": formatted}), 200
    except Exception as e:
        print(f"[ERROR] get_intern_detail failed: {e}")
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/interns/<intern_id>', methods=['PATCH', 'PUT'])
def update_intern(intern_id):
    """Update an existing intern record's phase fields in Dataverse."""
    try:
        data = request.get_json(force=True) or {}
        if not data:
            return jsonify({"success": False, "error": "No fields provided for update"}), 400

        token = get_access_token()
        record = _fetch_intern_record_by_id(token, intern_id, include_system=True)
        
        # If no intern record exists, check if this is an employee flagged as Intern
        # and auto-create the intern record before updating
        if not record:
            try:
                entity_set = get_employee_entity_set(token)
                field_map = get_field_map(entity_set)
                emp_id_field = field_map.get("id") or "crc6f_employeeid"
                
                emp_headers = {
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/json",
                    "OData-MaxVersion": "4.0",
                    "OData-Version": "4.0",
                }
                
                safe_id = (intern_id or '').replace("'", "''")
                emp_filter = f"$filter={emp_id_field} eq '{safe_id}' and crc6f_employeeflag eq 'Intern'"
                emp_url = f"{RESOURCE}/api/data/v9.2/{entity_set}?{emp_filter}&$top=1"
                
                emp_resp = requests.get(emp_url, headers=emp_headers, timeout=30)
                if emp_resp.status_code == 200:
                    emp_records = emp_resp.json().get("value", [])
                    if emp_records:
                        create_payload = {
                            INTERN_FIELDS['intern_id']: intern_id,
                            INTERN_FIELDS['employee_id']: intern_id,
                        }
                        create_url = f"{RESOURCE}/api/data/v9.2/{INTERN_ENTITY}"
                        create_headers = {
                            "Authorization": f"Bearer {token}",
                            "Content-Type": "application/json",
                            "Accept": "application/json",
                            "Prefer": "return=representation"
                        }
                        create_resp = requests.post(create_url, headers=create_headers, json=create_payload, timeout=30)
                        if create_resp.status_code in (200, 201, 204):
                            record = _fetch_intern_record_by_id(token, intern_id, include_system=True)
                            print(f"[INFO] Auto-created intern record for flagged employee {intern_id}")
            except Exception as auto_create_err:
                print(f"[WARN] Failed to auto-create intern record for {intern_id}: {auto_create_err}")
        
        if not record:
            return jsonify({"success": False, "error": "Intern not found"}), 404

        record_id = record.get(INTERN_FIELDS['primary']) or record.get('crc6f_hr_interndetailsid')
        if not record_id:
            return jsonify({"success": False, "error": "Unable to resolve intern record ID"}), 500

        payload = {}
        for friendly, logical in INTERN_FIELDS.items():
            if friendly in ("primary", "created_by"):
                continue
            if logical and friendly in data:
                value = data.get(friendly)
                if value not in (None, ""):
                    payload[logical] = value

        if not payload:
            return jsonify({"success": False, "error": "No valid fields to update"}), 400

        update_record(INTERN_ENTITY, record_id, payload)

        updated = _fetch_intern_record_by_id(token, intern_id, include_system=True)
        formatted = _format_intern_record(updated) if updated else None
        return jsonify({"success": True, "intern": formatted}), 200
    except Exception as e:
        print(f"[ERROR] update_intern failed: {e}")
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/interns', methods=['POST'])
def create_intern():
    """Create a new intern record in Dataverse."""
    try:
        data = request.get_json(force=True) or {}
        required = ["intern_id", "employee_id"]
        missing = [field for field in required if not data.get(field)]
        if missing:
            return jsonify({"success": False, "error": f"Missing fields: {', '.join(missing)}"}), 400

        payload = {}
        for friendly, logical in INTERN_FIELDS.items():
            if friendly in ("primary", "created_by"):
                continue
            if logical and data.get(friendly) not in (None, ""):
                payload[logical] = data.get(friendly)

        token = get_access_token()
        url = f"{RESOURCE}/api/data/v9.2/{INTERN_ENTITY}"
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Prefer": "return=representation"
        }

        resp = requests.post(url, headers=headers, json=payload, timeout=30)
        if resp.status_code not in (200, 201, 204):
            return jsonify({
                "success": False,
                "error": f"Failed to create intern: {resp.status_code}",
                "details": resp.text
            }), 500

        # Fetch the newly created record for consistency
        record = None
        try:
            record = _fetch_intern_record_by_id(token, data.get('intern_id'), include_system=True)
        except Exception as fetch_err:
            print(f"[WARN] Created intern but failed to refetch details: {fetch_err}")

        return jsonify({
            "success": True,
            "intern": _format_intern_record(record) if record else None
        }), 201
    except Exception as e:
        print(f"[ERROR] create_intern failed: {e}")
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


def _extract_record_id(record: dict, prefer_keys=None) -> str:
    """Best-effort extraction of Dataverse primary GUID field from a record."""
    if not record:
        return None
    prefer_keys = prefer_keys or []
    # Prefer known conventional primary key names
    for k in prefer_keys:
        if k in record and record[k]:
            return record[k]
    # Fallback: pick the first field name that ends with 'id' and looks like a GUID
    for k, v in record.items():
        if isinstance(k, str) and k.lower().endswith('id') and isinstance(v, str) and len(v) >= 30:
            return v
    # Last resort: None
    return None

@app.route('/api/employees/by-name/<name>', methods=['GET'])
def get_employee_by_name(name):
    """
    Fetch Employee ID by Name (case-insensitive search)
    """
    try:
        token = get_access_token()
        entity_set = get_employee_entity_set(token)
        field_map = get_field_map(entity_set)

        # Fallbacks for safety
        id_field = field_map.get("id") or "crc6f_employeeid"
        name_field = field_map.get("fullname") or field_map.get("firstname") or "crc6f_employeename"

        search_name = name.strip().lower()
        print(f"🔍 Searching for employee by name: {search_name}")

        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0"
        }

        # Fetch all names
        url = f"{RESOURCE}/api/data/v9.2/{entity_set}?$select={id_field},{name_field}&$top=5000"
        res = requests.get(url, headers=headers, timeout=20)

        if res.status_code != 200:
            return jsonify({
                "exists": False,
                "error": f"Dataverse request failed ({res.status_code})",
                "details": res.text
            }), 400

        employees = res.json().get("value", [])
        for emp in employees:
            db_name = (emp.get(name_field) or "").strip().lower()
            if db_name == search_name:
                print(f"✅ Found match: {db_name}")
                return jsonify({
                    "exists": True,
                    "employeeId": emp.get(id_field),
                    "employeeName": emp.get(name_field)
                }), 200

        print(f"⚠️ No employee found for name: {search_name}")
        return jsonify({"exists": False, "message": "Employee not found"}), 404

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"exists": False, "error": str(e)}), 500




@app.route('/api/managers/all', methods=['GET'])
def get_all_managers():
    """
    Return all employees whose designation is 'Manager'.
    Used for populating Manager dropdowns in Project Details or Assignments.
    """
    try:
        print(f"\n{'='*60}")
        print("👔 FETCHING ALL MANAGERS FROM EMPLOYEE MASTER")
        print(f"{'='*60}")

        # --- Auth + Metadata
        token = get_access_token()
        entity_set = get_employee_entity_set(token)
        field_map = get_field_map(entity_set)

        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0"
        }

        # --- Build query (filter only 'Manager')
        fetch_count = 5000
        select_list = [
            field_map[k]
            for k in ['id', 'fullname', 'firstname', 'lastname', 'designation']
            if field_map.get(k)
        ]
        select_fields = f"$select={','.join(select_list)}"

        # Dataverse OData filter
        designation_field = field_map.get('designation')
        filter_clause = f"$filter={designation_field} eq 'Manager'"
        url = f"{RESOURCE}/api/data/v9.2/{entity_set}?{select_fields}&{filter_clause}&$top={fetch_count}"

        print(f"🌐 Fetching from Dataverse: {url}")
        resp = requests.get(url, headers=headers)
        print(f"📊 Dataverse status: {resp.status_code}")

        if resp.status_code != 200:
            print(f"❌ Dataverse error: {resp.text}")
            return jsonify({
                "success": False,
                "error": f"Failed to fetch managers ({resp.status_code})",
                "details": resp.text
            }), 500

        data = resp.json()
        records = data.get("value", [])
        print(f"✅ Retrieved {len(records)} manager records")

        managers = []
        for rec in records:
            # Handle full name properly (combine if needed)
            if field_map.get('fullname'):
                fullname = (rec.get(field_map['fullname']) or '').strip()
            else:
                fname = (rec.get(field_map.get('firstname')) or '').strip()
                lname = (rec.get(field_map.get('lastname')) or '').strip()
                fullname = f"{fname} {lname}".strip()

            managers.append({
                "employee_id": rec.get(field_map.get('id')),
                "name": fullname,
                "designation": rec.get(field_map.get('designation'))
            })

        print(f"📤 Returning {len(managers)} managers")
        print(f"{'='*60}\n")

        return jsonify({
            "success": True,
            "count": len(managers),
            "managers": managers
        }), 200

    except Exception as e:
        print(f"❌ ERROR in /api/managers/all: {str(e)}")
        import traceback
        traceback.print_exc()
        print(f"{'='*60}\n")
        return jsonify({"success": False, "error": str(e)}), 500



@app.route('/api/employees/<employee_id>', methods=['PUT'])
def update_employee_api(employee_id):
    try:
        token = get_access_token()
        entity_set = get_employee_entity_set(token)
        field_map = get_field_map(entity_set)
        data = request.get_json(force=True)

        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0"
        }
        # Find the record by business employee id field
        id_field = field_map.get('id') or 'crc6f_employeeid'
        primary_field = field_map.get('primary')
        select_fields = [id_field]
        if primary_field:
            select_fields.append(primary_field)
        select_clause = ','.join(select_fields)
        filter_q = f"?$select={select_clause}&$filter={id_field} eq '{employee_id}'&$top=1"
        url = f"{RESOURCE}/api/data/v9.2/{entity_set}{filter_q}"
        resp = requests.get(url, headers=headers)
        if resp.status_code != 200:
            return jsonify({"success": False, "error": "Failed to find employee for update", "details": resp.text}), 500
        values = resp.json().get('value', [])
        if not values:
            return jsonify({"success": False, "error": "Employee not found"}), 404
        record = values[0]

        # Build update payload using field map
        payload = {}
        if field_map['fullname']:
            first = data.get("first_name", "")
            last = data.get("last_name", "")
            payload[field_map['fullname']] = f"{first} {last}".strip()
        else:
            if field_map['firstname']:
                payload[field_map['firstname']] = data.get("first_name")
            if field_map['lastname']:
                payload[field_map['lastname']] = data.get("last_name")
        if field_map['email']:
            payload[field_map['email']] = data.get("email")
        if field_map['contact']:
            payload[field_map['contact']] = data.get("contact_number")
        if field_map['address']:
            payload[field_map['address']] = data.get("address")
        if field_map['department']:
            payload[field_map['department']] = data.get("department")
        if field_map['designation']:
            payload[field_map['designation']] = data.get("designation")
        if field_map.get('doj'):
            payload[field_map['doj']] = data.get("doj")
        if field_map['active']:
            active_value = data.get("active")
            if isinstance(active_value, bool):
                payload[field_map['active']] = "Active" if active_value else "Inactive"
            else:
                payload[field_map['active']] = "Active" if str(active_value).lower() in ['true', '1', 'active'] else "Inactive"

        # Handle employee flag update
        if field_map.get('employee_flag') and data.get('employee_flag'):
            payload[field_map['employee_flag']] = data.get('employee_flag')

        # Try to extract the primary record id
        prefer_keys = [primary_field, f"{entity_set[:-1]}id", f"{entity_set}id"]  # heuristic
        record_id = _extract_record_id(record, prefer_keys)
        if not record_id:
            return jsonify({"success": False, "error": "Unable to resolve record ID for update"}), 500

        update_record(entity_set, record_id, payload)
        return jsonify({"success": True, "employee": {"employee_id": employee_id}})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/employees/<employee_id>', methods=['DELETE'])
def delete_employee_api(employee_id):
    try:
        if not employee_id or employee_id.lower() == 'null':
            return jsonify({"success": False, "error": "Invalid employee identifier"}), 400

        token = get_access_token()
        entity_set = get_employee_entity_set(token)
        field_map = get_field_map(entity_set)

        # If a Dataverse GUID was supplied, delete directly
        import re
        guid_pattern = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
        if guid_pattern.match(employee_id):
            delete_record(entity_set, employee_id)
            return jsonify({"success": True})

        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0"
        }
        # Find record by business id
        filter_q = f"?$filter={field_map['id']} eq '{employee_id}'&$top=1"
        url = f"{RESOURCE}/api/data/v9.2/{entity_set}{filter_q}"
        resp = requests.get(url, headers=headers)
        if resp.status_code != 200:
            return jsonify({"success": False, "error": "Failed to find employee for deletion", "details": resp.text}), 500
        values = resp.json().get('value', [])
        if not values:
            return jsonify({"success": False, "error": "Employee not found"}), 404
        record = values[0]

        prefer_keys = [field_map.get('primary'), f"{entity_set[:-1]}id", f"{entity_set}id"]
        prefer_keys = [k for k in prefer_keys if k]
        record_id = _extract_record_id(record, prefer_keys)
        if not record_id:
            return jsonify({"success": False, "error": "Unable to resolve record ID for deletion"}), 500

        delete_record(entity_set, record_id)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/employees/last-id', methods=['GET'])
def get_last_employee_id():
    """Get the last/highest employee ID from Dataverse for auto-increment"""
    try:
        token = get_access_token()
        entity_set = get_employee_entity_set(token)
        field_map = get_field_map(entity_set)
        
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0"
        }
        
        # Get all employee IDs ordered by creation date (newest first)
        select_fields = f"$select={field_map['id']}"
        url = f"{BASE_URL}/{entity_set}?{select_fields}&$orderby=createdon desc&$top=100"
        response = requests.get(url, headers=headers)
        
        if response.status_code != 200:
            print(f"[WARN] Could not fetch last employee ID: {response.status_code}")
            return jsonify({"success": False, "error": "Failed to fetch last employee ID"}), 500
        
        records = response.json().get('value', [])
        
        if not records:
            # No employees exist yet, return EMP000
            print("[DATA] No employees found, starting with EMP000")
            return jsonify({
                "success": True,
                "last_id": "EMP000",
                "next_id": "EMP001",
                "next_number": 1
            })
        
        # Extract numeric part from employee IDs
        max_number = 0
        for record in records:
            emp_id = record.get(field_map['id'], '')
            if emp_id and isinstance(emp_id, str) and emp_id.upper().startswith('EMP'):
                try:
                    # Extract number part from EMP001, EMP002, etc.
                    number_str = emp_id.upper().replace('EMP', '').strip()
                    if number_str.isdigit():
                        number = int(number_str)
                        max_number = max(max_number, number)
                except (ValueError, AttributeError):
                    continue
        
        next_number = max_number + 1
        next_id = format_employee_id(next_number)
        
        print(f"[DATA] Last Employee ID: EMP{max_number:03d}, Next: {next_id}")
        
        return jsonify({
            "success": True,
            "last_id": format_employee_id(max_number) if max_number > 0 else "EMP000",
            "next_id": next_id,
            "next_number": next_number
        })
        
    except Exception as e:
        print(f"[ERROR] Error getting last employee ID: {str(e)}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/employees/bulk', methods=['POST'])
def bulk_create_employees():
    """Bulk upload employees from CSV data"""
    try:
        token = get_access_token()
        entity_set = get_employee_entity_set(token)
        field_map = get_field_map(entity_set)
        data = request.get_json(force=True)
        
        employees = data.get('employees', [])
        if not employees:
            return jsonify({"success": False, "error": "No employees provided"}), 400
        
        print(f"\n[SEND] Bulk upload: Processing {len(employees)} employees")
        print(f"Entity Set: {entity_set}")
        print(f"Field Map: {field_map}")
        
        # Get the last employee ID for auto-increment
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0"
        }
        
        # Auto-generate employee IDs if not provided in CSV
        start_number = 1
        select_fields = f"$select={field_map['id']}"
        url = f"{BASE_URL}/{entity_set}?{select_fields}&$orderby=createdon desc&$top=100"
        response = requests.get(url, headers=headers)
        
        if response.status_code == 200:
            records = response.json().get('value', [])
            max_number = 0
            for record in records:
                emp_id = record.get(field_map['id'], '')
                if emp_id and isinstance(emp_id, str) and emp_id.upper().startswith('EMP'):
                    try:
                        number_str = emp_id.upper().replace('EMP', '').strip()
                        if number_str.isdigit():
                            number = int(number_str)
                            max_number = max(max_number, number)
                    except (ValueError, AttributeError):
                        continue
            start_number = max_number + 1
            print(f"[DATA] Starting employee ID generation from: EMP{start_number:04d}")
        
        # Assign auto-generated IDs to employees without IDs
        for idx, emp in enumerate(employees):
            if not emp.get('employee_id') or emp.get('employee_id').strip() == '':
                next_id = format_employee_id(start_number + idx)
                emp['employee_id'] = next_id
                print(f"   Generated ID for employee {idx + 1}: {next_id}")
        
        # Check for duplicate employee IDs in Dataverse
        print("\n[SEARCH] Checking for duplicate employee IDs...")
        try:
            headers = {
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "OData-MaxVersion": "4.0",
                "OData-Version": "4.0"
            }
            
            # Get all existing employee IDs
            url = f"{BASE_URL}/{entity_set}?$select={field_map['id']}"
            response = requests.get(url, headers=headers)
            
            if response.status_code == 200:
                existing_records = response.json().get('value', [])
                existing_ids = set()
                for record in existing_records:
                    emp_id = record.get(field_map['id'])
                    if emp_id:
                        existing_ids.add(str(emp_id).upper())
                
                print(f"[OK] Found {len(existing_ids)} existing employee IDs in Dataverse")
                
                # Check for duplicates in the upload (only check provided IDs, not auto-generated ones)
                csv_ids = [emp.get('employee_id', '').upper() for emp in employees if emp.get('employee_id') and emp.get('employee_id').strip()]
                duplicates = [emp_id for emp_id in csv_ids if emp_id in existing_ids]
                
                if duplicates:
                    print(f"[ERROR] Found {len(duplicates)} duplicate employee IDs: {duplicates}")
                    return jsonify({
                        "success": False,
                        "error": "Duplicate employee IDs found",
                        "duplicates": duplicates,
                        "message": f"Cannot upload: {len(duplicates)} employee ID(s) already exist in the system"
                    }), 400
                
                print("[OK] No duplicates found, proceeding with upload")
            else:
                print(f"[WARN] Could not fetch existing employees (status {response.status_code}), proceeding anyway")
        except Exception as check_err:
            print(f"[WARN] Error checking for duplicates: {str(check_err)}, proceeding anyway")
        
        created_count = 0
        errors = []
        
        # Get the last employee ID for auto-generation
        last_emp_id = None
        try:
            last_id_response = requests.get(f"{RESOURCE}/api/data/v9.2/{entity_set}?$select={field_map['id']}&$orderby={field_map['id']} desc&$top=1", headers=headers)
            if last_id_response.status_code == 200:
                last_records = last_id_response.json().get('value', [])
                if last_records:
                    last_emp_id = last_records[0].get(field_map['id'])
                    print(f"[DATA] Last employee ID in Dataverse: {last_emp_id}")
        except Exception as e:
            print(f"[WARN] Could not fetch last employee ID: {e}")
        
        # Extract numeric part from last ID for auto-increment
        next_id_num = 1
        if last_emp_id:
            import re
            match = re.search(r'(\d+)', str(last_emp_id))
            if match:
                next_id_num = int(match.group(1)) + 1
        
        for idx, emp_data in enumerate(employees):
            try:
                # Build payload based on table structure
                payload = {}
                
                # Handle employee ID - auto-generate if missing
                if field_map['id']:
                    emp_id = emp_data.get("employee_id")
                    if not emp_id or emp_id.strip() == "":
                        # Auto-generate employee ID with 3 digits
                        emp_id = f"EMP{next_id_num:03d}"
                        next_id_num += 1
                        print(f"[PROC] Auto-generated employee ID: {emp_id}")
                    else:
                        print(f"[FETCH] Using provided employee ID: {emp_id}")
                    payload[field_map['id']] = emp_id
                
                # Handle name fields
                if field_map['fullname']:
                    first = emp_data.get("first_name", "")
                    last = emp_data.get("last_name", "")
                    payload[field_map['fullname']] = f"{first} {last}".strip()
                else:
                    if field_map['firstname']:
                        payload[field_map['firstname']] = emp_data.get("first_name")
                    if field_map['lastname']:
                        payload[field_map['lastname']] = emp_data.get("last_name")
                
                # Other fields
                email_val = emp_data.get("email", "")
                designation_val = emp_data.get("designation", "")
                doj_val = emp_data.get("doj")
                first_name = emp_data.get("first_name", "")
                
                if field_map['email']:
                    payload[field_map['email']] = email_val
                if field_map['contact']:
                    payload[field_map['contact']] = emp_data.get("contact_number")
                if field_map['address']:
                    payload[field_map['address']] = emp_data.get("address")
                if field_map['department']:
                    payload[field_map['department']] = emp_data.get("department")
                if field_map['designation']:
                    payload[field_map['designation']] = designation_val
                if field_map['doj']:
                    payload[field_map['doj']] = doj_val
                if field_map['active']:
                    # Convert boolean to string format expected by Dataverse
                    active_value = emp_data.get("active")
                    if isinstance(active_value, bool):
                        payload[field_map['active']] = "Active" if active_value else "Inactive"
                    else:
                        # Handle string values
                        payload[field_map['active']] = "Active" if str(active_value).lower() in ['true', '1', 'active'] else "Inactive"
                
                # Calculate and add experience
                if field_map.get('experience') and doj_val:
                    experience = calculate_experience(doj_val)
                    payload[field_map['experience']] = str(experience)
                
                # Set quota hours to 9
                if field_map.get('quota_hours'):
                    payload[field_map['quota_hours']] = "9"
                
                print(f"\n[LOG] Row {idx + 1}: {emp_data.get('employee_id')} - {emp_data.get('first_name')} {emp_data.get('last_name')}")
                print(f"   Payload: {payload}")
                
                create_record(entity_set, payload)
                print(f"   [OK] Success")
                created_count += 1

                # Auto-create login if email is present and not already created
                try:
                    email_val = (emp_data.get("email") or "").strip()
                    name_val = (f"{emp_data.get('first_name','')} {emp_data.get('last_name','')}").strip()
                    if email_val:
                        # Check if login exists
                        headers_login = {
                            "Authorization": f"Bearer {token}",
                            "Accept": "application/json",
                            "OData-MaxVersion": "4.0",
                            "OData-Version": "4.0"
                        }
                        login_table = get_login_table(token)
                        safe_email = email_val.strip().replace("'", "''")
                        check_url = f"{BASE_URL}/{login_table}?$top=1&$filter=crc6f_username eq '{safe_email}'"
                        resp_check = requests.get(check_url, headers=headers_login)
                        exists = False
                        if resp_check.status_code == 200:
                            recs = resp_check.json().get("value", [])
                            exists = len(recs) > 0
                        if not exists:
                            default_password = os.getenv("DEFAULT_USER_PASSWORD", "Temp@123")
                            hashed = _hash_password(default_password)
                            access_level = determine_access_level(designation_val)
                            user_id = generate_user_id(emp_id, first_name)
                            login_payload = {
                                "crc6f_username": email_val.lower(),
                                "crc6f_password": hashed,
                                "crc6f_user_status": "Active",
                                "crc6f_loginattempts": "0",
                                "crc6f_employeename": name_val or emp_data.get("employee_id"),
                                "crc6f_accesslevel": access_level,
                                "crc6f_userid": user_id
                            }
                            try:
                                create_record(login_table, login_payload)
                                print(f"   [USER] Created login for {email_val} | Access: {access_level} | UserID: {user_id}")
                            except Exception as le:
                                print(f"   [WARN] Failed creating login for {email_val}: {le}")
                except Exception as auto_login_err:
                    print(f"   [WARN] Auto-login creation skipped: {auto_login_err}")
                
                # Auto-create leave balance record for the new employee
                try:
                    if emp_id:
                        print(f"   [FETCH] Creating leave balance for {emp_id}")
                        
                        # Calculate experience if DOJ is provided
                        experience = 0
                        if doj_val:
                            experience = calculate_experience(doj_val)
                        
                        # Get leave allocation based on experience
                        cl, sl, total, allocation_type = get_leave_allocation_by_experience(experience)
                        actual_total = cl + sl  # Actual total = CL + SL (no comp off initially)
                        
                        print(f"   [DATA] Experience: {experience} years -> {allocation_type}")
                        print(f"   [FETCH] Leave allocation: CL={cl}, SL={sl}, Total Quota={total}")
                        
                        leave_payload = {
                            "crc6f_employeeid": emp_id,
                            "crc6f_cl": str(cl),
                            "crc6f_sl": str(sl),
                            "crc6f_compoff": "0",
                            "crc6f_total": str(total),
                            "crc6f_actualtotal": str(actual_total),
                            "crc6f_leaveallocationtype": allocation_type
                        }
                        
                        create_record(LEAVE_BALANCE_ENTITY, leave_payload)
                        print(f"   [OK] Leave balance created for {emp_id}")
                except Exception as leave_err:
                    print(f"   [WARN] Failed to create leave balance for {emp_id}: {leave_err}")
            except Exception as e:
                error_msg = f"Row {idx + 1} ({emp_data.get('employee_id')}): {str(e)}"
                print(f"   [ERROR] Error: {error_msg}")
                errors.append(error_msg)
        
        response = {
            "success": True,
            "count": created_count,
            "total": len(employees),
            "entitySet": entity_set
        }
        
        if errors:
            response["errors"] = errors
            response["message"] = f"Uploaded {created_count} out of {len(employees)} employees. Some records failed."
        else:
            response["message"] = f"Successfully uploaded all {created_count} employees to Dataverse!"
        
        return jsonify(response), 201
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ================== TEAM MANAGEMENT ROUTES ==================
def _build_employee_lookup(token: str, employee_ids: set) -> dict:
    if not employee_ids:
        return {}
    entity_set = get_employee_entity_set(token)
    field_map = get_field_map(entity_set)
    id_field = field_map.get('id')
    if not id_field:
        return {}

    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0"
    }

    select_fields = [id_field]
    for key in ['firstname', 'lastname', 'fullname', 'department']:
        field_name = field_map.get(key)
        if field_name:
            select_fields.append(field_name)
    select_clause = ','.join(dict.fromkeys([f for f in select_fields if f]))

    chunk_size = 30
    records = {}
    ids_list = list({eid for eid in employee_ids if eid})
    for i in range(0, len(ids_list), chunk_size):
        chunk = ids_list[i:i + chunk_size]
        filters = [f"{id_field} eq '{str(e).replace("'", "''")}'" for e in chunk]
        filter_clause = ' or '.join(filters)
        url = f"{RESOURCE}/api/data/v9.2/{entity_set}?$select={select_clause}&$filter={filter_clause}"
        resp = requests.get(url, headers=headers)
        if resp.status_code != 200:
            print(f"[WARN] Failed to fetch employee chunk: {resp.status_code} {resp.text}")
            continue
        for rec in resp.json().get('value', []):
            key = _normalize_employee_id(rec.get(id_field))
            records[key] = {
                "name": _get_employee_display_name(rec, field_map),
                "department": rec.get(field_map.get('department')) if field_map.get('department') else ''
            }
    return records


def _serialize_hierarchy_row(row: dict, emp_lookup: dict) -> dict:
    employee_id = _normalize_employee_id(row.get(HIERARCHY_EMPLOYEE_FIELD))
    manager_id = _normalize_employee_id(row.get(HIERARCHY_MANAGER_FIELD))
    primary_id = _normalize_guid(row.get(HIERARCHY_PRIMARY_FIELD) or row.get('crc6f_hr_hierarchyid') or row.get('crc6f_hierarchyid') or row.get('id'))
    created_by = row.get(HIERARCHY_CREATEDBY_FIELD)

    employee_info = emp_lookup.get(employee_id, {})
    manager_info = emp_lookup.get(manager_id, {})

    return {
        "id": primary_id,
        "employeeId": employee_id,
        "employeeName": employee_info.get('name') or employee_id,
        "employeeDepartment": employee_info.get('department') or '',
        "managerId": manager_id,
        "managerName": manager_info.get('name') or manager_id,
        "managerDepartment": manager_info.get('department') or '',
        "createdBy": created_by
    }


@app.route('/api/team-management/hierarchy', methods=['GET'])
def list_hierarchy():
    try:
        # Try to get a token; if it fails, we'll still serve from local cache
        token = None
        try:
            token = get_access_token()
        except Exception as auth_err:
            print(f"[WARN] Could not get access token, will try local cache: {auth_err}")
        entity = get_hierarchy_entity(token) if token else (HIERARCHY_ENTITY_RESOLVED or HIERARCHY_ENTITY)

        page = max(int(request.args.get('page', 1)), 1)
        page_size = max(min(int(request.args.get('pageSize', 25)), 100), 1)
        search = (request.args.get('search') or '').strip()
        manager_filter = (request.args.get('manager') or '').strip()
        department_filter = (request.args.get('department') or '').strip()
        group_by_manager = request.args.get('groupByManager', 'false').lower() == 'true'

        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0"
        }

        # Base query
        select_fields = [
            HIERARCHY_EMPLOYEE_FIELD,
            HIERARCHY_MANAGER_FIELD,
            HIERARCHY_PRIMARY_FIELD,
            HIERARCHY_CREATEDBY_FIELD
        ]
        select_clause = f"$select={','.join(select_fields)}"

        filters = []
        if manager_filter:
            safe = manager_filter.replace("'", "''")
            filters.append(f"{HIERARCHY_MANAGER_FIELD} eq '{safe}'")
        if department_filter:
            # department filtering requires joining; handle client-side after enrichment
            pass
        if search:
            safe = search.replace("'", "''")
            filters.append(f"contains({HIERARCHY_EMPLOYEE_FIELD}, '{safe}')")

        filter_clause = ''
        if filters:
            filter_clause = f"&$filter={' and '.join(filters)}"

        url = f"{RESOURCE}/api/data/v9.2/{entity}?{select_clause}{filter_clause}&$top=5000"
        print(f"[URL] Hierarchy GET: {url}")
        rows = []
        if token:
            try:
                resp = requests.get(url, headers=headers)
                print(f"   ↩︎ Dataverse status: {resp.status_code}")
                if resp.status_code == 200:
                    rows = resp.json().get('value', [])
                else:
                    print(f"[WARN] Dataverse hierarchy fetch failed: {resp.status_code} {resp.text}")
            except Exception as dv_err:
                print(f"[WARN] Dataverse hierarchy fetch error: {dv_err}")

        # Fallback to local cache if Dataverse returned nothing
        used_fallback = False
        if not rows:
            local_rows = _load_team_hierarchy_local()
            if local_rows:
                print(f"🔁 Using local hierarchy cache with {len(local_rows)} rows")
                # Local rows are already in display format; adapt to serialization path
                # Convert to row dicts compatible with _serialize_hierarchy_row
                rows = [
                    {
                        HIERARCHY_EMPLOYEE_FIELD: r.get('employeeId'),
                        HIERARCHY_MANAGER_FIELD: r.get('managerId'),
                        HIERARCHY_PRIMARY_FIELD: r.get('id') or r.get(HIERARCHY_PRIMARY_FIELD),
                        HIERARCHY_CREATEDBY_FIELD: r.get('createdBy')
                    }
                    for r in local_rows if r.get('employeeId') and r.get('managerId')
                ]
                used_fallback = True
            else:
                # No data anywhere
                print("ℹ️ No hierarchy data available from Dataverse or local cache")
                rows = []

        employee_ids = set()
        for row in rows:
            employee_ids.add(_normalize_employee_id(row.get(HIERARCHY_EMPLOYEE_FIELD)))
            employee_ids.add(_normalize_employee_id(row.get(HIERARCHY_MANAGER_FIELD)))

        emp_lookup = _build_employee_lookup(token, employee_ids) if (not used_fallback and token) else {}
        serialized = [_serialize_hierarchy_row(row, emp_lookup) for row in rows]

        # Post-filter by department (requires enriched data)
        if department_filter:
            dept = department_filter.lower()
            serialized = [r for r in serialized if str(r.get('employeeDepartment', '')).lower() == dept or str(r.get('managerDepartment', '')).lower() == dept]

        if search:
            term = search.lower()
            serialized = [r for r in serialized if term in r['employeeId'].lower() or term in (r['employeeName'] or '').lower()]

        if manager_filter:
            mf = manager_filter.lower()
            serialized = [r for r in serialized if r['managerId'].lower() == mf]

        total = len(serialized)

        if group_by_manager:
            grouped = {}
            for item in serialized:
                key = item['managerId'] or 'UNASSIGNED'
                grouped.setdefault(key, {
                    "managerId": item['managerId'],
                    "managerName": item['managerName'],
                    "managerDepartment": item['managerDepartment'],
                    "members": []
                })
                grouped[key]['members'].append(item)

            groups = list(grouped.values())
            start = (page - 1) * page_size
            end = start + page_size
            page_groups = groups[start:end]
            return jsonify({
                "success": True,
                "items": page_groups,
                "total": len(groups),
                "page": page,
                "pageSize": page_size,
                "grouped": True
            })

        # Regular pagination
        start = (page - 1) * page_size
        end = start + page_size
        paged = serialized[start:end]

        return jsonify({
            "success": True,
            "items": paged,
            "total": total,
            "page": page,
            "pageSize": page_size,
            "grouped": False
        })
    except Exception as e:
        print(f"[ERROR] Error listing hierarchy: {e}")
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/team-management/hierarchy', methods=['POST'])
def create_hierarchy():
    try:
        data = request.get_json(force=True)
        employee_id = _normalize_employee_id(data.get('employeeId'))
        manager_id = _normalize_employee_id(data.get('managerId'))

        if not employee_id or not manager_id:
            return jsonify({"success": False, "error": "Employee ID and Manager ID are required"}), 400
        if employee_id.lower() == manager_id.lower():
            return jsonify({"success": False, "error": "Employee and Manager cannot be the same"}), 400

        token = get_access_token()
        entity = get_hierarchy_entity(token)

        payload = {
            HIERARCHY_EMPLOYEE_FIELD: employee_id,
            HIERARCHY_MANAGER_FIELD: manager_id
        }

        created = None
        record_id = None
        try:
            created = create_record(entity, payload)
            record_id = _normalize_guid(created.get(HIERARCHY_PRIMARY_FIELD) or created.get('id'))
        except Exception as dv_err:
            # If Dataverse create fails, still create a local record so UI is usable
            print(f"[WARN] Dataverse create failed, using local fallback: {dv_err}")
            record_id = str(uuid.uuid4())

        display_row = _compose_hierarchy_display(token=get_access_token(), employee_id=employee_id, manager_id=manager_id, record_id=record_id)
        _upsert_team_hierarchy_local(display_row)

        return jsonify({
            "success": True,
            "id": record_id,
            "employeeId": employee_id,
            "managerId": manager_id
        }), 201
    except Exception as e:
        print(f"[ERROR] Error creating hierarchy: {e}")
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/team-management/hierarchy/<record_id>', methods=['PUT'])
def update_hierarchy(record_id):
    try:
        data = request.get_json(force=True)
        manager_id = _normalize_employee_id(data.get('managerId'))

        if not manager_id:
            return jsonify({"success": False, "error": "Manager ID is required"}), 400

        token = get_access_token()
        entity = get_hierarchy_entity(token)

        # Normalize record id
        normalized_record = _normalize_guid(record_id)

        payload = {
            HIERARCHY_MANAGER_FIELD: manager_id
        }

        try:
            update_record(entity, normalized_record, payload)
        except Exception as dv_err:
            print(f"[WARN] Dataverse update failed, updating local cache: {dv_err}")

        # Update local cache display
        existing = _find_local_hierarchy_record(normalized_record) or {"id": normalized_record}
        employee_id = existing.get('employeeId') or ''
        display_row = _compose_hierarchy_display(token=get_access_token(), employee_id=employee_id, manager_id=manager_id, record_id=normalized_record)
        _upsert_team_hierarchy_local(display_row)

        return jsonify({"success": True})
    except Exception as e:
        print(f"[ERROR] Error updating hierarchy: {e}")
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/team-management/hierarchy/<record_id>', methods=['DELETE'])
def delete_hierarchy(record_id):
    try:
        token = get_access_token()
        entity = get_hierarchy_entity(token)
        normalized_record = _normalize_guid(record_id)

        try:
            delete_record(entity, normalized_record)
        except Exception as dv_err:
            print(f"[WARN] Dataverse delete failed, removing from local cache: {dv_err}")

        _delete_team_hierarchy_local(normalized_record)

        return jsonify({"success": True})
    except Exception as e:
        print(f"[ERROR] Error deleting hierarchy: {e}")
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


# ================== ASSET MANAGEMENT ROUTES ==================
# ================== ASSET MANAGEMENT ROUTES ==================
@app.route("/assets", methods=["GET"])
def fetch_assets():
    try:
        data = get_all_assets()
        return jsonify(data), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/assets", methods=["POST"])
def add_asset():
    try:
        data = request.json
        result = create_asset(data)
        # create_asset might return (dict, status) tuple for validation errors
        if isinstance(result, tuple):
            return jsonify(result[0]), result[1]
        return jsonify(result), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# Update by asset id (crc6f_assetid)
@app.route("/assets/update/<asset_id>", methods=["PATCH"])
def edit_asset(asset_id):
    try:
        data = request.json
        result = update_asset_by_assetid(asset_id, data)
        return jsonify(result), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# Delete by asset id
@app.route("/assets/delete/<asset_id>", methods=["DELETE"])
def remove_asset(asset_id):
    try:
        result = delete_asset_by_assetid(asset_id)
        return jsonify(result), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ================== CLIENTS MANAGEMENT ROUTES ==================
@app.route("/api/clients", methods=["GET"])
def list_clients():
    try:
        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0",
        }
        select = (
            "$select="
            "crc6f_clientid,crc6f_clientname,crc6f_companyname,crc6f_email,crc6f_phone,"
            "crc6f_address,crc6f_country,crc6f_hr_clientsid,createdby,createdon"
        )
        entity_set = get_clients_entity(token)
        url = f"{RESOURCE}/api/data/v9.2/{entity_set}?{select}&$top=5000"
        resp = requests.get(url, headers=headers)
        if resp.status_code != 200:
            return jsonify({"success": False, "error": resp.text}), resp.status_code

        values = resp.json().get("value", [])

        # Filters
        q = (request.args.get("search") or "").strip().lower()
        country = (request.args.get("country") or "").strip().lower()
        company = (request.args.get("company") or "").strip().lower()
        sort = (request.args.get("sort") or "recent").strip().lower()
        page = int(request.args.get("page", 1) or 1)
        page_size = int(request.args.get("pageSize", 25) or 25)

        def match(v):
            if not q:
                return True
            s = str(v or "").lower()
            return q in s

        items = []
        for r in values:
            item = {
                "crc6f_clientid": r.get("crc6f_clientid"),
                "crc6f_clientname": r.get("crc6f_clientname"),
                "crc6f_companyname": r.get("crc6f_companyname"),
                "crc6f_email": r.get("crc6f_email"),
                "crc6f_phone": r.get("crc6f_phone"),
                "crc6f_address": r.get("crc6f_address"),
                "crc6f_country": r.get("crc6f_country"),
                "crc6f_hr_clientsid": r.get("crc6f_hr_clientsid"),
                "createdby": r.get("createdby"),
                "createdon": r.get("createdon"),
            }
            if q:
                if not (
                    match(item["crc6f_clientid"]) or match(item["crc6f_clientname"]) or match(item["crc6f_companyname"])  # noqa: E501
                ):
                    continue
            if country and str(item.get("crc6f_country") or "").strip().lower() != country:
                continue
            if company and str(item.get("crc6f_companyname") or "").strip().lower() != company:
                continue
            items.append(item)

        # Sorting
        if sort == "name":
            items.sort(key=lambda x: (str(x.get("crc6f_clientname") or "").lower(), str(x.get("crc6f_clientid") or "")))
        elif sort == "country":
            items.sort(key=lambda x: (str(x.get("crc6f_country") or "").lower(), str(x.get("crc6f_clientname") or "").lower()))
        else:  # recent
            items.sort(key=lambda x: str(x.get("createdon") or ""), reverse=True)

        total = len(items)
        start = max(0, (page - 1) * page_size)
        end = start + page_size
        page_items = items[start:end]

        return jsonify({
            "success": True,
            "clients": page_items,
            "total": total,
            "page": page,
            "pageSize": page_size,
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/clients", methods=["POST"])
def create_client():
    try:
        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0",
        }
        data = request.get_json(force=True) or {}
        client_id = (data.get("crc6f_clientid") or "").strip()
        if not client_id:
            return jsonify({"success": False, "error": "Client ID is required"}), 400

        # Uniqueness check
        safe = client_id.replace("'", "''")
        entity_set = get_clients_entity(token)
        url = f"{RESOURCE}/api/data/v9.2/{entity_set}?$select=crc6f_clientid&$filter=crc6f_clientid eq '{safe}'&$top=1"
        chk = requests.get(url, headers=headers)
        if chk.status_code == 200 and chk.json().get("value"):
            return jsonify({"success": False, "error": "Client ID already exists"}), 409

        payload = {
            "crc6f_clientid": client_id,
            "crc6f_clientname": data.get("crc6f_clientname"),
            "crc6f_companyname": data.get("crc6f_companyname"),
            "crc6f_email": data.get("crc6f_email"),
            "crc6f_phone": data.get("crc6f_phone"),
            "crc6f_address": data.get("crc6f_address"),
            "crc6f_country": data.get("crc6f_country"),
        }
        created = create_record(entity_set, payload)
        return jsonify({"success": True, "client": created}), 201
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/clients/<record_id>", methods=["PATCH"])
def update_client(record_id):
    try:
        payload = {}
        data = request.get_json(force=True) or {}
        for k in [
            "crc6f_clientid",
            "crc6f_clientname",
            "crc6f_companyname",
            "crc6f_email",
            "crc6f_phone",
            "crc6f_address",
            "crc6f_country",
        ]:
            if k in data:
                payload[k] = data.get(k)
        token = get_access_token()
        entity_set = get_clients_entity(token)
        ok = update_record(entity_set, record_id, payload)
        return jsonify({"success": True, "client": {"crc6f_hr_clientsid": record_id}})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/clients/<record_id>", methods=["DELETE"])
def delete_client(record_id):
    try:
        token = get_access_token()
        entity_set = get_clients_entity(token)
        ok = delete_record(entity_set, record_id)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/clients/next-id", methods=["GET"])
def get_next_client_id():
    try:
        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0",
        }
        entity_set = get_clients_entity(token)
        url = f"{RESOURCE}/api/data/v9.2/{entity_set}?$select=crc6f_clientid&$orderby=createdon desc&$top=200"
        resp = requests.get(url, headers=headers)
        if resp.status_code != 200:
            return jsonify({"success": False, "error": "Failed to fetch clients"}), 500
        values = resp.json().get("value", [])
        max_n = 0
        for r in values:
            cid = r.get("crc6f_clientid") or ""
            if isinstance(cid, str) and cid.upper().startswith("CL"):
                try:
                    n = int(''.join([c for c in cid[2:] if c.isdigit()]) or "0")
                    if n > max_n:
                        max_n = n
                except Exception:
                    pass
        next_num = max_n + 1
        next_id = f"CL{next_num:03d}"
        return jsonify({"success": True, "next_id": next_id})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500
# ================== SIMPLE CLIENT NAME FETCH (for dropdowns) ==================
@app.route("/api/clients/names", methods=["GET"])
def get_all_clients():
    """
    Lightweight endpoint to fetch only client names and IDs
    for dropdown selection in project creation/edit forms.
    """
    try:
        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0",
        }

        entity_set = get_clients_entity(token)
        # Only fetching necessary fields
        select = "$select=crc6f_clientname,crc6f_hr_clientsid"
        url = f"{RESOURCE}/api/data/v9.2/{entity_set}?{select}&$top=5000"
        resp = requests.get(url, headers=headers)
        if resp.status_code != 200:
            return jsonify({"success": False, "error": resp.text}), resp.status_code

        values = resp.json().get("value", [])
        clients = [
            {
                "crc6f_clientname": c.get("crc6f_clientname"),
                "crc6f_hr_clientsid": c.get("crc6f_hr_clientsid"),
            }
            for c in values
            if c.get("crc6f_clientname")
        ]

        return jsonify({
            "success": True,
            "clients": clients,
            "total": len(clients),
        }), 200

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

# ================== HOLIDAY MANAGEMENT ROUTES ==================
@app.route("/api/holidays", methods=["GET"])
def get_holidays():
    """Fetch all holidays from Dataverse"""
    try:
        print("[RECV] Fetching holidays from Dataverse...")
        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0"
        }

        # Fetch all records with ordering by date
        url = f"{RESOURCE}/api/data/v9.2/{HOLIDAY_ENTITY}?$select=crc6f_date,crc6f_holidayname,crc6f_hr_holidaysid&$orderby=crc6f_date asc"
        print(f"🔗 Request URL: {url}")
        
        response = requests.get(url, headers=headers)
        print(f"[DATA] Response status: {response.status_code}")

        if response.status_code != 200:
            error_msg = f"Failed to fetch: {response.text}"
            print(f"[ERROR] {error_msg}")
            return jsonify({"error": error_msg}), response.status_code

        data = response.json().get("value", [])
        print(f"[OK] Fetched {len(data)} holidays from Dataverse")

        return jsonify(data), 200

    except Exception as e:
        print(f"[ERROR] Error in GET holidays: {str(e)}")
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/holidays", methods=["POST"])
def create_holiday():
    """Add a new holiday"""
    try:
        print("\n" + "=" * 70)
        print("➕ CREATING NEW HOLIDAY")
        print("=" * 70)
        
        data = request.get_json()
        print(f"[RECV] Received data: {data}")

        new_record = {
            "crc6f_date": data.get("crc6f_date"),
            "crc6f_holidayname": data.get("crc6f_holidayname"),
        }

        print(f"[LOG] Creating holiday: {new_record}")
        result = create_record(HOLIDAY_ENTITY, new_record)
        print(f"[OK] Holiday created successfully")
        print("=" * 70 + "\n")
        
        return jsonify(result), 201

    except Exception as e:
        print(f"[ERROR] Error in CREATE holiday: {str(e)}")
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/holidays/<holiday_id>", methods=["PATCH"])
def update_holiday(holiday_id):
    """Edit an existing holiday"""
    try:
        print("\n" + "=" * 70)
        print(f"✏️ UPDATING HOLIDAY: {holiday_id}")
        print("=" * 70)
        
        data = request.get_json()
        print(f"[RECV] Update data: {data}")
        
        update_data = {
            "crc6f_date": data.get("crc6f_date"),
            "crc6f_holidayname": data.get("crc6f_holidayname"),
        }

        success = update_record(HOLIDAY_ENTITY, holiday_id, update_data)
        if success:
            print(f"[OK] Holiday {holiday_id} updated successfully")
            print("=" * 70 + "\n")
            return jsonify({"message": "Holiday updated successfully"}), 200
        else:
            print(f"[ERROR] Failed to update holiday {holiday_id}")
            return jsonify({"error": "Failed to update"}), 400

    except Exception as e:
        print(f"[ERROR] Error in UPDATE holiday: {str(e)}")
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/holidays/<holiday_id>", methods=["DELETE"])
def delete_holiday(holiday_id):
    """Delete a holiday record"""
    try:
        print("\n" + "=" * 70)
        print(f"[DEL] DELETING HOLIDAY: {holiday_id}")
        print("=" * 70)
        
        success = delete_record(HOLIDAY_ENTITY, holiday_id)
        if success:
            print(f"[OK] Holiday {holiday_id} deleted successfully")
            print("=" * 70 + "\n")
            return jsonify({"message": "Holiday deleted successfully"}), 200
        else:
            print(f"[ERROR] Failed to delete holiday {holiday_id}")
            return jsonify({"error": "Failed to delete"}), 400

    except Exception as e:
        print(f"[ERROR] Error in DELETE holiday: {str(e)}")
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ================== DELETED EMPLOYEES CSV MANAGEMENT ==================
DELETED_EMPLOYEES_CSV = "Deleted_employees.csv"

@app.route('/api/deleted-employees/append', methods=['POST'])
def append_deleted_employees():
    """Append deleted employees to CSV file"""
    try:
        import csv
        
        data = request.json
        employees = data.get('employees', [])
        
        if not employees:
            return jsonify({"success": False, "error": "No employees provided"}), 400
        
        # Check if file exists
        file_exists = os.path.isfile(DELETED_EMPLOYEES_CSV)
        
        # Open file in append mode
        with open(DELETED_EMPLOYEES_CSV, 'a', newline='', encoding='utf-8') as csvfile:
            fieldnames = ['employee_id', 'first_name', 'last_name', 'email', 'contact_number', 
                         'address', 'department', 'designation', 'doj', 'active']
            writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
            
            # Write header only if file is new
            if not file_exists:
                writer.writeheader()
                print(f"[OK] Created new file: {DELETED_EMPLOYEES_CSV}")
            
            # Write employee records
            for emp in employees:
                writer.writerow({
                    'employee_id': emp.get('employee_id', ''),
                    'first_name': emp.get('first_name', ''),
                    'last_name': emp.get('last_name', ''),
                    'email': emp.get('email', ''),
                    'contact_number': emp.get('contact_number', ''),
                    'address': emp.get('address', ''),
                    'department': emp.get('department', ''),
                    'designation': emp.get('designation', ''),
                    'doj': emp.get('doj', ''),
                    'active': str(emp.get('active', 'false')).lower()
                })
        
        print(f"[OK] Appended {len(employees)} employees to {DELETED_EMPLOYEES_CSV}")
        
        return jsonify({
            "success": True,
            "message": f"Appended {len(employees)} employees to deleted employees CSV",
            "count": len(employees)
        })
        
    except Exception as e:
        print(f"[ERROR] Error appending to deleted employees CSV: {str(e)}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/deleted-employees', methods=['GET'])
def get_deleted_employees():
    """Fetch all deleted employees from CSV"""
    try:
        import csv
        
        if not os.path.isfile(DELETED_EMPLOYEES_CSV):
            return jsonify({
                "success": True,
                "employees": [],
                "count": 0,
                "message": "No deleted employees file found"
            })
        
        employees = []
        with open(DELETED_EMPLOYEES_CSV, 'r', newline='', encoding='utf-8') as csvfile:
            reader = csv.DictReader(csvfile)
            for row in reader:
                employees.append({
                    'employee_id': row.get('employee_id', ''),
                    'first_name': row.get('first_name', ''),
                    'last_name': row.get('last_name', ''),
                    'email': row.get('email', ''),
                    'contact_number': row.get('contact_number', ''),
                    'address': row.get('address', ''),
                    'department': row.get('department', ''),
                    'designation': row.get('designation', ''),
                    'doj': row.get('doj', ''),
                    'active': row.get('active', 'false').lower() == 'true'
                })
        
        print(f"[DATA] Fetched {len(employees)} deleted employees from CSV")
        
        return jsonify({
            "success": True,
            "employees": employees,
            "count": len(employees)
        })
        
    except Exception as e:
        print(f"[ERROR] Error reading deleted employees CSV: {str(e)}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/deleted-employees/restore', methods=['POST'])
def restore_deleted_employees():
    """Restore selected employees from CSV back to Dataverse and remove from CSV"""
    try:
        import csv
        
        data = request.json
        employee_ids = data.get('employee_ids', [])
        
        if not employee_ids:
            return jsonify({"success": False, "error": "No employee IDs provided"}), 400
        
        if not os.path.isfile(DELETED_EMPLOYEES_CSV):
            return jsonify({"success": False, "error": "No deleted employees file found"}), 404
        
        # Read all employees from CSV
        all_employees = []
        employees_to_restore = []
        
        with open(DELETED_EMPLOYEES_CSV, 'r', newline='', encoding='utf-8') as csvfile:
            reader = csv.DictReader(csvfile)
            for row in reader:
                emp_id = row.get('employee_id', '')
                if emp_id in employee_ids:
                    employees_to_restore.append(row)
                else:
                    all_employees.append(row)
        
        # Restore employees to Dataverse
        token = get_access_token()
        entity_set = get_employee_entity_set(token)
        field_map = FIELD_MAPS.get(entity_set, FIELD_MAPS["crc6f_table12s"])
        
        restored_count = 0
        errors = []
        
        for emp in employees_to_restore:
            try:
                payload = {}
                
                # Employee ID
                if field_map['id']:
                    payload[field_map['id']] = emp.get('employee_id')
                
                # Name fields
                if field_map['fullname']:
                    payload[field_map['fullname']] = f"{emp.get('first_name', '')} {emp.get('last_name', '')}".strip()
                else:
                    if field_map['firstname']:
                        payload[field_map['firstname']] = emp.get('first_name')
                    if field_map['lastname']:
                        payload[field_map['lastname']] = emp.get('last_name')
                
                # Other fields
                if field_map['email']:
                    payload[field_map['email']] = emp.get('email')
                if field_map['contact']:
                    payload[field_map['contact']] = emp.get('contact_number')
                if field_map['address']:
                    payload[field_map['address']] = emp.get('address')
                if field_map['department']:
                    payload[field_map['department']] = emp.get('department')
                if field_map['designation']:
                    payload[field_map['designation']] = emp.get('designation')
                if field_map['doj']:
                    payload[field_map['doj']] = emp.get('doj')
                if field_map['active']:
                    payload[field_map['active']] = "Active" if emp.get('active', 'false').lower() == 'true' else "Inactive"
                
                create_record(entity_set, payload)
                restored_count += 1
                print(f"[OK] Restored: {emp.get('employee_id')}")
                
            except Exception as e:
                error_msg = f"{emp.get('employee_id')}: {str(e)}"
                errors.append(error_msg)
                print(f"[ERROR] Failed to restore {emp.get('employee_id')}: {str(e)}")
        
        # Rewrite CSV with remaining employees
        with open(DELETED_EMPLOYEES_CSV, 'w', newline='', encoding='utf-8') as csvfile:
            fieldnames = ['employee_id', 'first_name', 'last_name', 'email', 'contact_number', 
                         'address', 'department', 'designation', 'doj', 'active']
            writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(all_employees)
        
        print(f"[OK] Restored {restored_count} employees. {len(all_employees)} remaining in CSV")
        
        response = {
            "success": True,
            "restored": restored_count,
            "remaining": len(all_employees),
            "message": f"Successfully restored {restored_count} employee(s)"
        }
        
        if errors:
            response["errors"] = errors
            response["message"] += f". {len(errors)} failed."
        
        return jsonify(response)
        
    except Exception as e:
        print(f"[ERROR] Error restoring employees: {str(e)}")
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/deleted-employees/clear', methods=['DELETE'])
def clear_deleted_employees():
    """Clear all deleted employees from CSV"""
    try:
        if os.path.isfile(DELETED_EMPLOYEES_CSV):
            os.remove(DELETED_EMPLOYEES_CSV)
            print(f"[OK] Deleted file: {DELETED_EMPLOYEES_CSV}")
            return jsonify({
                "success": True,
                "message": "Deleted employees CSV cleared"
            })
        else:
            return jsonify({
                "success": True,
                "message": "No deleted employees file to clear"
            })
    except Exception as e:
        print(f"[ERROR] Error clearing deleted employees CSV: {str(e)}")
        return jsonify({"success": False, "error": str(e)}), 500


# ================== LEAVE UPDATE/CANCEL ROUTES ==================
@app.route('/api/leaves/cancel/<leave_id>', methods=['PATCH'])
def cancel_leave(leave_id):
    """Cancel a pending leave request"""
    try:
        print(f"\n{'='*70}")
        print(f"[DEL] CANCELING LEAVE REQUEST: {leave_id}")
        print(f"{'='*70}")
        
        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0"
        }
        
        # Find the leave record
        safe_leave_id = leave_id.replace("'", "''")
        filter_query = f"?$filter=crc6f_leaveid eq '{safe_leave_id}'"
        url = f"{RESOURCE}/api/data/v9.2/{LEAVE_ENTITY}{filter_query}"
        
        response = requests.get(url, headers=headers)
        
        if response.status_code != 200:
            return jsonify({"success": False, "error": "Leave record not found"}), 404
        
        records = response.json().get("value", [])
        if not records:
            return jsonify({"success": False, "error": "Leave record not found"}), 404
        
        record = records[0]
        record_id = record.get("crc6f_table14id")
        current_status = record.get("crc6f_status", "").lower()
        
        # Only allow canceling pending leaves
        if current_status != "pending":
            return jsonify({"success": False, "error": f"Cannot cancel {current_status} leave. Only pending leaves can be canceled."}), 400
        
        # Update status to Canceled
        update_data = {"crc6f_status": "Canceled"}
        update_record(LEAVE_ENTITY, record_id, update_data)
        
        # Restore leave balance if it was a paid leave
        employee_id = record.get("crc6f_employeeid")
        leave_type = record.get("crc6f_leavetype")
        total_days = float(record.get("crc6f_totaldays", 0))
        paid_unpaid = record.get("crc6f_paidunpaid", "Unpaid")
        
        if paid_unpaid.lower() == "paid" and total_days > 0 and employee_id:
            try:
                balance_row = _fetch_leave_balance(token, employee_id)
                if balance_row:
                    balance_record_id = balance_row.get("crc6f_hr_leavemangementid")
                    if balance_record_id:
                        leave_type_lower = leave_type.lower()
                        balance_update = {}
                        
                        # Get current balances for all leave types
                        current_cl = float(balance_row.get("crc6f_cl", 0) or 0)
                        current_sl = float(balance_row.get("crc6f_sl", 0) or 0)
                        current_co = float(balance_row.get("crc6f_compoff", 0) or 0)
                        
                        # Update the specific leave type balance
                        if "casual" in leave_type_lower:
                            current_cl = current_cl + total_days
                            balance_update["crc6f_cl"] = str(current_cl)
                        elif "sick" in leave_type_lower:
                            current_sl = current_sl + total_days
                            balance_update["crc6f_sl"] = str(current_sl)
                        elif "comp" in leave_type_lower:
                            current_co = current_co + total_days
                            balance_update["crc6f_compoff"] = str(current_co)
                        
                        # Recalculate total balance
                        new_total = current_cl + current_sl + current_co
                        balance_update["crc6f_total"] = str(new_total)
                        
                        if balance_update:
                            entity_set = LEAVE_BALANCE_ENTITY_RESOLVED or LEAVE_BALANCE_ENTITY
                            update_record(entity_set, balance_record_id, balance_update)
                            print(f"   [OK] Balance restored: {balance_update}")
                            print(f"   [DATA] New total balance: {new_total}")
            except Exception as restore_err:
                print(f"   [WARN] Failed to restore balance: {restore_err}")
        
        print(f"[OK] Leave {leave_id} canceled successfully")
        print(f"{'='*70}\n")
        
        # Fetch updated balances to return in response
        response_data = {
            "success": True,
            "message": f"Leave {leave_id} canceled successfully"
        }
        
        # If balance was restored, fetch and include updated balances
        if paid_unpaid.lower() == "paid" and total_days > 0 and employee_id:
            try:
                updated_balance_row = _fetch_leave_balance(token, employee_id)
                if updated_balance_row:
                    response_data["updated_balances"] = {
                        "casual_leave": float(updated_balance_row.get("crc6f_cl", 0) or 0),
                        "sick_leave": float(updated_balance_row.get("crc6f_sl", 0) or 0),
                        "comp_off": float(updated_balance_row.get("crc6f_compoff", 0) or 0),
                        "total": float(updated_balance_row.get("crc6f_total", 0) or 0)
                    }
                    print(f"   [DATA] Updated balances included in response: {response_data['updated_balances']}")
            except Exception as fetch_err:
                print(f"   [WARN] Could not fetch updated balances for response: {fetch_err}")
        
        return jsonify(response_data), 200
        
    except Exception as e:
        print(f"[ERROR] Error canceling leave: {str(e)}")
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/leaves/update/<leave_id>', methods=['PATCH'])
def update_leave(leave_id):
    """Update a pending leave request"""
    try:
        print(f"\n{'='*70}")
        print(f"✏️ UPDATING LEAVE REQUEST: {leave_id}")
        print(f"{'='*70}")
        
        data = request.json
        leave_type = data.get('leave_type')
        start_date = data.get('start_date')
        end_date = data.get('end_date')
        total_days = data.get('total_days')
        paid_unpaid = data.get('paid_unpaid')
        
        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0"
        }
        
        # Find the leave record
        safe_leave_id = leave_id.replace("'", "''")
        filter_query = f"?$filter=crc6f_leaveid eq '{safe_leave_id}'"
        url = f"{RESOURCE}/api/data/v9.2/{LEAVE_ENTITY}{filter_query}"
        
        response = requests.get(url, headers=headers)
        
        if response.status_code != 200:
            return jsonify({"success": False, "error": "Leave record not found"}), 404
        
        records = response.json().get("value", [])
        if not records:
            return jsonify({"success": False, "error": "Leave record not found"}), 404
        
        record = records[0]
        record_id = record.get("crc6f_table14id")
        current_status = record.get("crc6f_status", "").lower()
        
        # Only allow updating pending leaves
        if current_status != "pending":
            return jsonify({"success": False, "error": f"Cannot update {current_status} leave. Only pending leaves can be updated."}), 400
        
        # Build update data
        update_data = {}
        if leave_type:
            update_data["crc6f_leavetype"] = leave_type
        if start_date:
            update_data["crc6f_startdate"] = start_date
        if end_date:
            update_data["crc6f_enddate"] = end_date
        if total_days is not None:
            update_data["crc6f_totaldays"] = total_days
        if paid_unpaid:
            update_data["crc6f_paidunpaid"] = paid_unpaid
        
        # Update the record
        update_record(LEAVE_ENTITY, record_id, update_data)
        
        print(f"[OK] Leave {leave_id} updated successfully")
        print(f"   Updated fields: {list(update_data.keys())}")
        print(f"{'='*70}\n")
        
        return jsonify({
            "success": True,
            "message": f"Leave {leave_id} updated successfully",
            "updated_fields": list(update_data.keys())
        }), 200
        
    except Exception as e:
        print(f"[ERROR] Error updating leave: {str(e)}")
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/employee-leave-allocation/<employee_id>', methods=['PUT'])
def update_employee_leave_allocation(employee_id):
    """
    Update leave allocation for a specific employee.
    Allows manual override of calculated leave quotas.
    """
    try:
        print(f"\n{'='*70}")
        print(f"✏️ UPDATING LEAVE ALLOCATION FOR EMPLOYEE: {employee_id}")
        print(f"{'='*70}")
        
        # Get request data
        data = request.get_json()
        casual_leave = data.get('casualLeave')
        sick_leave = data.get('sickLeave')
        
        if casual_leave is None or sick_leave is None:
            return jsonify({"success": False, "error": "casualLeave and sickLeave are required"}), 400
        
        # Validate values
        try:
            casual_leave = float(casual_leave)
            sick_leave = float(sick_leave)
            if casual_leave < 0 or sick_leave < 0:
                return jsonify({"success": False, "error": "Leave values must be non-negative"}), 400
        except ValueError:
            return jsonify({"success": False, "error": "Invalid leave values"}), 400
        
        total_quota = casual_leave + sick_leave
        
        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0"
        }
        
        # Normalize employee ID
        emp_id = (employee_id or '').strip().upper()
        if emp_id.isdigit():
            emp_id = f"EMP{int(emp_id):03d}"
        
        print(f"[DATA] New allocation: CL={casual_leave}, SL={sick_leave}, Total={total_quota}")
        
        # Check if record exists in leave management table
        safe_emp = emp_id.replace("'", "''")
        balance_filter = f"?$filter=crc6f_employeeid eq '{safe_emp}'"
        balance_url = f"{RESOURCE}/api/data/v9.2/crc6f_hr_leavemangements{balance_filter}"
        balance_response = requests.get(balance_url, headers=headers)
        
        balance_data = {
            "crc6f_employeeid": emp_id,
            "crc6f_cl": str(casual_leave),
            "crc6f_sl": str(sick_leave),
            "crc6f_total": str(total_quota)
        }
        
        if balance_response.status_code == 200:
            existing_records = balance_response.json().get("value", [])
            
            if existing_records:
                # Update existing record
                record_id = existing_records[0].get("crc6f_hr_leavemangementid")
                if record_id:
                    update_url = f"{RESOURCE}/api/data/v9.2/crc6f_hr_leavemangements({record_id})"
                    update_response = requests.patch(update_url, headers=headers, json=balance_data)
                    
                    if update_response.status_code in [200, 204]:
                        print(f"[OK] Successfully updated leave allocation for {emp_id}")
                        print(f"{'='*70}\n")
                        return jsonify({
                            "success": True,
                            "message": f"Leave allocation updated for {emp_id}",
                            "employee_id": emp_id,
                            "casualLeave": casual_leave,
                            "sickLeave": sick_leave,
                            "totalQuota": total_quota
                        }), 200
                    else:
                        error_detail = update_response.text
                        print(f"[ERROR] Failed to update: {update_response.status_code} - {error_detail}")
                        return jsonify({"success": False, "error": f"Failed to update: {error_detail}"}), 500
            else:
                # Create new record
                create_url = f"{RESOURCE}/api/data/v9.2/crc6f_hr_leavemangements"
                create_response = requests.post(create_url, headers=headers, json=balance_data)
                
                if create_response.status_code in [200, 201, 204]:
                    print(f"[OK] Successfully created leave allocation for {emp_id}")
                    print(f"{'='*70}\n")
                    return jsonify({
                        "success": True,
                        "message": f"Leave allocation created for {emp_id}",
                        "employee_id": emp_id,
                        "casualLeave": casual_leave,
                        "sickLeave": sick_leave,
                        "totalQuota": total_quota
                    }), 200
                else:
                    error_detail = create_response.text
                    print(f"[ERROR] Failed to create: {create_response.status_code} - {error_detail}")
                    return jsonify({"success": False, "error": f"Failed to create: {error_detail}"}), 500
        else:
            print(f"[ERROR] Failed to check existing record: {balance_response.status_code}")
            return jsonify({"success": False, "error": "Failed to check existing record"}), 500
            
    except Exception as e:
        print(f"[ERROR] Error updating leave allocation: {str(e)}")
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/sync-leave-allocations', methods=['POST'])
def sync_leave_allocations():
    """
    Sync leave allocations to crc6f_hr_leavemangement table based on employee experience.
    Creates or updates records for all employees with their calculated leave quotas.
    """
    try:
        print(f"\n{'='*70}")
        print(f"[PROC] SYNCING LEAVE ALLOCATIONS TO DATAVERSE")
        print(f"{'='*70}")
        
        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0"
        }
        
        # Fetch all employees
        entity_set = get_employee_entity_set(token)
        field_map = get_field_map(entity_set)
        emp_url = f"{RESOURCE}/api/data/v9.2/{entity_set}"
        emp_response = requests.get(emp_url, headers=headers)
        
        if emp_response.status_code != 200:
            return jsonify({"success": False, "error": "Failed to fetch employees"}), 500
        
        employees = emp_response.json().get("value", [])
        print(f"[DATA] Found {len(employees)} employees to process")
        
        synced_count = 0
        errors = []
        
        for emp_record in employees:
            try:
                emp_id = emp_record.get(field_map['id'])
                if not emp_id:
                    continue
                
                doj_value = emp_record.get(field_map['doj'])
                
                # Calculate experience and allocation
                cl_annual = 3  # Default Type 3
                sl_annual = 3
                allocation_type = "Type 3"
                
                if doj_value:
                    try:
                        from datetime import datetime
                        doj_date = None
                        if isinstance(doj_value, str):
                            if '/' in doj_value:
                                parts = doj_value.split('/')
                                if len(parts) == 3:
                                    doj_date = datetime(int(parts[2]), int(parts[0]), int(parts[1]))
                            elif '-' in doj_value:
                                doj_date = datetime.fromisoformat(doj_value.split('T')[0])
                        
                        if doj_date:
                            current_date = datetime.now()
                            experience_years = int((current_date - doj_date).days / 365.25)
                            
                            if experience_years >= 3:
                                cl_annual = 6
                                sl_annual = 6
                                allocation_type = "Type 1"
                            elif experience_years >= 2:
                                cl_annual = 4
                                sl_annual = 4
                                allocation_type = "Type 2"
                    except Exception as e:
                        print(f"   [WARN] Error calculating experience for {emp_id}: {e}")
                
                total_quota = cl_annual + sl_annual
                
                print(f"\n[USER] Processing {emp_id}: {allocation_type} (CL={cl_annual}, SL={sl_annual}, Total={total_quota})")
                
                # Check if record exists in leave management table
                safe_emp = emp_id.replace("'", "''")
                balance_filter = f"?$filter=crc6f_employeeid eq '{safe_emp}'"
                balance_url = f"{RESOURCE}/api/data/v9.2/crc6f_hr_leavemangements{balance_filter}"
                balance_response = requests.get(balance_url, headers=headers)
                
                balance_data = {
                    "crc6f_employeeid": emp_id,
                    "crc6f_cl": str(cl_annual),
                    "crc6f_sl": str(sl_annual),
                    "crc6f_total": str(total_quota)
                    # Note: crc6f_compoff is omitted as it may have different type or not be required
                }
                
                if balance_response.status_code == 200:
                    existing_records = balance_response.json().get("value", [])
                    
                    if existing_records:
                        # Update existing record
                        record_id = existing_records[0].get("crc6f_hr_leavemangementid")
                        if record_id:
                            update_url = f"{RESOURCE}/api/data/v9.2/crc6f_hr_leavemangements({record_id})"
                            update_response = requests.patch(update_url, headers=headers, json=balance_data)
                            
                            if update_response.status_code in [200, 204]:
                                print(f"   [OK] Updated existing record for {emp_id}")
                                synced_count += 1
                            else:
                                error_detail = update_response.text
                                error_msg = f"Failed to update {emp_id}: {update_response.status_code} - {error_detail}"
                                print(f"   [ERROR] {error_msg}")
                                errors.append(error_msg)
                    else:
                        # Create new record
                        create_url = f"{RESOURCE}/api/data/v9.2/crc6f_hr_leavemangements"
                        create_response = requests.post(create_url, headers=headers, json=balance_data)
                        
                        if create_response.status_code in [200, 201, 204]:
                            print(f"   [OK] Created new record for {emp_id}")
                            synced_count += 1
                        else:
                            error_detail = create_response.text
                            error_msg = f"Failed to create {emp_id}: {create_response.status_code} - {error_detail}"
                            print(f"   [ERROR] {error_msg}")
                            errors.append(error_msg)
                else:
                    error_msg = f"Failed to check existing record for {emp_id}"
                    print(f"   [ERROR] {error_msg}")
                    errors.append(error_msg)
                    
            except Exception as e:
                error_msg = f"Error processing {emp_id}: {str(e)}"
                print(f"   [ERROR] {error_msg}")
                errors.append(error_msg)
        
        print(f"\n{'='*70}")
        print(f"[OK] SYNC COMPLETE: {synced_count}/{len(employees)} employees synced")
        if errors:
            print(f"[WARN] Errors: {len(errors)}")
        print(f"{'='*70}\n")
        
        return jsonify({
            "success": True,
            "synced_count": synced_count,
            "total_employees": len(employees),
            "errors": errors if errors else None
        }), 200
        
    except Exception as e:
        print(f"[ERROR] Error syncing leave allocations: {str(e)}")
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500

# -----------------------------------------
# [FETCH] Attendance Submission to Inbox API
# -----------------------------------------
@app.route('/api/attendance/submit', methods=['POST'])
@app.route('/api/attendance/submit-to-inbox', methods=['POST'])
def submit_attendance_to_inbox():
    """Submit attendance report to admin inbox for approval"""
    try:
        print(f"\n{'='*70}")
        print("[SEND] ATTENDANCE SUBMISSION TO INBOX REQUEST")
        print(f"{'='*70}")

        data = request.get_json()
        employee_id = data.get('employee_id')
        year = data.get('year')
        month = data.get('month')

        if not all([employee_id, year, month]):
            return jsonify({"success": False, "error": "employee_id, year, and month are required"}), 400

        # Normalize employee ID
        emp_id = (employee_id or '').strip().upper()
        if emp_id.isdigit():
            emp_id = f"EMP{int(emp_id):03d}"

        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0"
        }

        # Marker id and date for record
        marker_id = _submission_marker_id(emp_id, year, month)
        marker_date = f"{year:04d}-{month:02d}-01"

        # Check if marker already exists
        filter_q = (f"?$filter={FIELD_EMPLOYEE_ID} eq '{emp_id}' "
                    f"and {FIELD_ATTENDANCE_ID_CUSTOM} eq '{marker_id}'")
        url_check = f"{RESOURCE}/api/data/v9.2/{ATTENDANCE_ENTITY}{filter_q}"
        resp_check = requests.get(url_check, headers=headers)
        if resp_check.status_code == 200 and resp_check.json().get('value'):
            return jsonify({"success": False, "error": "Attendance report already submitted for this month"}), 400

        # Create marker record in attendance table
        payload = {
            FIELD_EMPLOYEE_ID: emp_id,
            FIELD_DATE: marker_date,
            FIELD_ATTENDANCE_ID_CUSTOM: marker_id,
            FIELD_DURATION_INTEXT: _submission_payload_text(emp_id, year, month, "pending"),
        }

        created = create_record(ATTENDANCE_ENTITY, payload)

        print(f"[OK] Attendance submission marker created for {emp_id} ({year}-{month})")
        print(f"{'='*70}\n")

        return jsonify({
            "success": True,
            "message": f"Attendance report submitted for {month}/{year}",
            "marker": marker_id,
        }), 200

    except Exception as e:
        print(f"[ERROR] Error submitting attendance to inbox: {str(e)}")
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/attendance/submission-status/<employee_id>/<int:year>/<int:month>', methods=['GET'])
def get_attendance_submission_status(employee_id, year, month):
    """Check if attendance has been submitted for a specific month"""
    try:
        # Normalize employee ID
        emp_id = (employee_id or '').strip().upper()
        if emp_id.isdigit():
            emp_id = f"EMP{int(emp_id):03d}"

        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0"
        }

        marker_id = _submission_marker_id(emp_id, year, month)
        filter_q = (f"?$filter={FIELD_EMPLOYEE_ID} eq '{emp_id}' "
                    f"and {FIELD_ATTENDANCE_ID_CUSTOM} eq '{marker_id}'")
        url = f"{RESOURCE}/api/data/v9.2/{ATTENDANCE_ENTITY}{filter_q}"
        r = requests.get(url, headers=headers)
        if r.status_code == 200:
            vals = r.json().get('value', [])
            if vals:
                raw = vals[0].get(FIELD_DURATION_INTEXT) or ''
                meta = _parse_submission_intext(raw)
                return jsonify({"success": True, "submitted": True, "status": meta.get('status','pending')}), 200

        return jsonify({
            "success": True,
            "submitted": False
        }), 200

    except Exception as e:
        print(f"[ERROR] Error checking submission status: {str(e)}")
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


# -----------------------------------------
# [FETCH] Attendance Submission Admin API (using attendance table markers)
# -----------------------------------------
@app.route('/api/attendance/submissions', methods=['GET'])
def list_attendance_submissions():
    try:
        status_filter = (request.args.get('status') or '').strip().lower()  # pending|approved|rejected
        emp_id = (request.args.get('employee_id') or '').strip().upper()
        year = request.args.get('year')
        month = request.args.get('month')

        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0"
        }

        # Fetch markers: startswith(attendanceid,'SUBMIT-')
        base_filter = "startswith({0},'SUBMIT-')".format(FIELD_ATTENDANCE_ID_CUSTOM)
        if emp_id:
            base_filter += f" and {FIELD_EMPLOYEE_ID} eq '{emp_id}'"
        url = f"{RESOURCE}/api/data/v9.2/{ATTENDANCE_ENTITY}?$filter={base_filter}&$orderby={FIELD_DATE} desc"
        resp = requests.get(url, headers=headers)
        if resp.status_code != 200:
            return jsonify({"success": False, "error": f"Failed to fetch markers: {resp.status_code}"}), 500
        values = resp.json().get('value', [])

        items = []
        for row in values:
            aid = row.get(FIELD_ATTENDANCE_ID_CUSTOM) or ''
            if not aid.startswith('SUBMIT-'):
                continue
            # Extract emp, y, m from marker id SUBMIT-EMPxxx-YYYY-MM
            parts = aid.split('-')
            if len(parts) >= 4:
                marker_emp = parts[1]
                marker_year = int(parts[2]) if parts[2].isdigit() else None
                marker_month = int(parts[3]) if parts[3].isdigit() else None
            else:
                marker_emp = row.get(FIELD_EMPLOYEE_ID)
                marker_year = marker_month = None

            raw = row.get(FIELD_DURATION_INTEXT) or ''
            st = 'pending'
            reason = ''
            try:
                import json
                meta = json.loads(raw)
                st = (meta.get('status') or 'pending').lower()
                reason = meta.get('rejection_reason') or ''
            except Exception:
                pass

            if status_filter and st != status_filter:
                continue
            if year and marker_year and int(year) != marker_year:
                continue
            if month and marker_month and int(month) != marker_month:
                continue

            # Build base item
            item_obj = {
                "marker_id": aid,
                "employee_id": marker_emp or row.get(FIELD_EMPLOYEE_ID),
                "year": marker_year,
                "month": marker_month,
                "status": st,
                "rejection_reason": reason,
                "created_date": row.get(FIELD_DATE)
            }

            # Enrich with monthly aggregates if we know year/month/employee
            try:
                emp_for_q = item_obj["employee_id"]
                y, m = item_obj.get("year"), item_obj.get("month")
                if emp_for_q and y and m:
                    # Compute first/last day strings
                    from calendar import monthrange
                    first_day = f"{y:04d}-{m:02d}-01"
                    last_day = f"{y:04d}-{m:02d}-{monthrange(y, m)[1]:02d}"
                    # Attendance: count records with ATD- id within month
                    att_filter = (
                        f"?$filter={FIELD_EMPLOYEE_ID} eq '{emp_for_q}' and "
                        f"{FIELD_DATE} ge {first_day} and {FIELD_DATE} le {last_day} and "
                        f"startswith({FIELD_ATTENDANCE_ID_CUSTOM},'ATD-')"
                    )
                    att_url = f"{RESOURCE}/api/data/v9.2/{ATTENDANCE_ENTITY}{att_filter}"
                    att_resp = requests.get(att_url, headers=headers)
                    days_checked_in = 0
                    if att_resp.status_code == 200:
                        days_checked_in = len(att_resp.json().get('value', []))

                    # Leaves: list overlapping this month and aggregate by type
                    # Overlap condition: startdate <= last_day AND enddate >= first_day
                    lv_filter = (
                        f"?$filter=crc6f_employeeid eq '{emp_for_q}' and "
                        f"crc6f_startdate le {last_day} and crc6f_enddate ge {first_day}"
                    )
                    lv_url = f"{RESOURCE}/api/data/v9.2/{LEAVE_ENTITY}{lv_filter}"
                    lv_resp = requests.get(lv_url, headers=headers)
                    halfdays = 0
                    leave_types = {}
                    if lv_resp.status_code == 200:
                        for lr in lv_resp.json().get('value', []):
                            lt = (lr.get('crc6f_leavetype') or '').strip()
                            td = lr.get('crc6f_totaldays')
                            try:
                                td_f = float(td)
                            except Exception:
                                td_f = 0.0
                            if abs(td_f - 0.5) < 1e-6:
                                halfdays += 1
                            if lt:
                                leave_types[lt] = leave_types.get(lt, 0.0) + td_f
                    # Attach
                    item_obj["days_checked_in"] = days_checked_in
                    item_obj["halfdays"] = halfdays
                    # Convert leave_types to array for frontend readability
                    item_obj["leave_types"] = [{"type": k, "days": v} for k, v in leave_types.items()]
            except Exception as enrich_err:
                try:
                    print("[WARN] Failed to enrich submission item:", enrich_err)
                except Exception:
                    pass

            items.append(item_obj)

        return jsonify({"success": True, "items": items, "count": len(items)})
    except Exception as e:
        print("[ERROR] Error listing attendance submissions:", e)
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/attendance/submissions/<marker_id>/approve', methods=['POST'])
def approve_attendance_submission(marker_id):
    try:
        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0"
        }
        safe_marker = marker_id.replace("'", "''")
        url = f"{RESOURCE}/api/data/v9.2/{ATTENDANCE_ENTITY}?$top=1&$filter={FIELD_ATTENDANCE_ID_CUSTOM} eq '{safe_marker}'"
        r = requests.get(url, headers=headers)
        vals = r.json().get('value', []) if r.status_code == 200 else []
        if not vals:
            return jsonify({"success": False, "error": "Submission marker not found"}), 404
        row = vals[0]
        emp = row.get(FIELD_EMPLOYEE_ID)
        # Parse year/month from marker id
        parts = marker_id.split('-')
        y = int(parts[2]) if len(parts) >= 4 and parts[2].isdigit() else datetime.now().year
        m = int(parts[3]) if len(parts) >= 4 and parts[3].isdigit() else datetime.now().month
        payload = {FIELD_DURATION_INTEXT: _submission_payload_text(emp, y, m, 'approved')}
        record_id = row.get(FIELD_RECORD_ID) or row.get('id')
        update_record(ATTENDANCE_ENTITY, record_id, payload)
        return jsonify({"success": True, "message": "Attendance submission approved"})
    except Exception as e:
        print("[ERROR] Error approving attendance submission:", e)
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/attendance/submissions/<marker_id>/reject', methods=['POST'])
def reject_attendance_submission(marker_id):
    try:
        data = request.get_json() or {}
        reason = data.get('reason', '')
        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0"
        }
        safe_marker = marker_id.replace("'", "''")
        url = f"{RESOURCE}/api/data/v9.2/{ATTENDANCE_ENTITY}?$top=1&$filter={FIELD_ATTENDANCE_ID_CUSTOM} eq '{safe_marker}'"
        r = requests.get(url, headers=headers)
        vals = r.json().get('value', []) if r.status_code == 200 else []
        if not vals:
            return jsonify({"success": False, "error": "Submission marker not found"}), 404
        row = vals[0]
        emp = row.get(FIELD_EMPLOYEE_ID)
        parts = marker_id.split('-')
        y = int(parts[2]) if len(parts) >= 4 and parts[2].isdigit() else datetime.now().year
        m = int(parts[3]) if len(parts) >= 4 and parts[3].isdigit() else datetime.now().month
        payload = {FIELD_DURATION_INTEXT: _submission_payload_text(emp, y, m, 'rejected', reason)}
        record_id = row.get(FIELD_RECORD_ID) or row.get('id')
        update_record(ATTENDANCE_ENTITY, record_id, payload)
        return jsonify({"success": True, "message": "Attendance submission rejected"})
    except Exception as e:
        print("[ERROR] Error rejecting attendance submission:", e)
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


# ==================== ONBOARDING MODULE ====================
# Configuration
ONBOARDING_ENTITY = "crc6f_hr_onboardings"  # Dataverse table for onboarding
ONBOARDING_ENTITY_CANDIDATES = [
    "crc6f_hr_onboardings",
    "crc6f_hr_onboarding",
]
ONBOARDING_ENTITY_RESOLVED = None

# Progress Log table (audit trail per stage)
PROGRESS_LOG_ENTITY = "crc6f_hr_onboardingprogresslogs"
PROGRESS_LOG_ENTITY_CANDIDATES = [
    "crc6f_hr_onboardingprogresslogs",
    "crc6f_hr_onboardingprogresslog",
]
PROGRESS_LOG_ENTITY_RESOLVED = None

def get_onboarding_entity_set(token):
    """Auto-resolve the correct onboarding entity set name."""
    global ONBOARDING_ENTITY_RESOLVED
    if ONBOARDING_ENTITY_RESOLVED:
        return ONBOARDING_ENTITY_RESOLVED
    
    for candidate in ONBOARDING_ENTITY_CANDIDATES:
        try:
            test_url = f"{BASE_URL}/{candidate}?$top=1"
            response = requests.get(test_url, headers={"Authorization": f"Bearer {token}"})
            if response.status_code == 200:
                ONBOARDING_ENTITY_RESOLVED = candidate
                print(f"[OK] Resolved onboarding entity: {candidate}")
                return candidate
        except:
            continue

def get_progress_log_entity_set(token):
    """Resolve the HR_Onboarding Progress Log entity set name."""
    global PROGRESS_LOG_ENTITY_RESOLVED
    if PROGRESS_LOG_ENTITY_RESOLVED:
        return PROGRESS_LOG_ENTITY_RESOLVED
    for candidate in PROGRESS_LOG_ENTITY_CANDIDATES:
        try:
            test_url = f"{BASE_URL}/{candidate}?$top=1"
            response = requests.get(test_url, headers={"Authorization": f"Bearer {token}"})
            if response.status_code == 200:
                PROGRESS_LOG_ENTITY_RESOLVED = candidate
                return candidate
        except Exception:
            continue
    return PROGRESS_LOG_ENTITY

def _now_iso():
    try:
        return datetime.utcnow().isoformat() + "Z"
    except Exception:
        return datetime.now().isoformat()

def create_progress_log_row(token, onboarding_id, stage_name, stage_number=None, ts=None, notes=None):
    """Best-effort: insert a row in the progress log table. Never raises."""
    try:
        entity_set = get_progress_log_entity_set(token)
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        payload = {
            "crc6f_stagename": stage_name,
            "crc6f_completedat": ts or _now_iso(),
        }
        if stage_number is not None:
            payload["crc6f_stagenumber"] = stage_number
        if notes:
            payload["crc6f_notes"] = notes
        url = f"{BASE_URL}/{entity_set}"
        # Prefer lookup bind if available
        try:
            onboarding_entity = get_onboarding_entity_set(token)
            bind_payload = dict(payload)
            bind_payload[f"crc6f_onboardingid@odata.bind"] = f"/{onboarding_entity}({onboarding_id})"
            resp = requests.post(url, headers=headers, json=bind_payload, timeout=15)
            if resp.status_code in (200, 201, 204):
                return
        except Exception:
            pass
        # Fallback to simple field assignment
        try:
            payload_fallback = dict(payload)
            payload_fallback["crc6f_onboardingid"] = onboarding_id
            requests.post(url, headers=headers, json=payload_fallback, timeout=15)
        except Exception:
            pass
    except Exception:
        pass

def fetch_latest_progress_timestamps(token, onboarding_id):
    """Return a sparse dict mapping UI fields to latest timestamps for each stage."""
    rows = []
    try:
        entity_set = get_progress_log_entity_set(token)
        if not entity_set:
            return {}
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        safe_id = str(onboarding_id).replace("'", "''")
        # Try lookup-value filter first, then fallback to plain field filter
        urls = [
            f"{BASE_URL}/{entity_set}?$select=crc6f_stagename,crc6f_stagenumber,crc6f_completedat,crc6f_progresssteps,crc6f_timestamps,crc6f_refid&$filter=_crc6f_onboardingid_value eq '{safe_id}'&$orderby=crc6f_completedat desc&$top=200",
            f"{BASE_URL}/{entity_set}?$select=crc6f_stagename,crc6f_stagenumber,crc6f_completedat,crc6f_progresssteps,crc6f_timestamps,crc6f_refid&$filter=_crc6f_onboardingid_value eq guid'{safe_id}'&$orderby=crc6f_completedat desc&$top=200",
            f"{BASE_URL}/{entity_set}?$select=crc6f_stagename,crc6f_stagenumber,crc6f_completedat,crc6f_progresssteps,crc6f_timestamps,crc6f_refid&$filter=crc6f_onboardingid eq '{safe_id}'&$orderby=crc6f_completedat desc&$top=200",
            f"{BASE_URL}/{entity_set}?$select=crc6f_stagename,crc6f_stagenumber,crc6f_completedat,crc6f_progresssteps,crc6f_timestamps,crc6f_refid&$filter=crc6f_onboardingid eq guid'{safe_id}'&$orderby=crc6f_completedat desc&$top=200",
        ]
        for url in urls:
            try:
                resp = requests.get(url, headers=headers, timeout=20)
                if resp.status_code == 200:
                    rows = resp.json().get("value", [])
                    if rows:
                        break
                elif resp.status_code == 404:
                    # Table doesn't exist yet, return empty
                    return {}
            except Exception:
                continue
    except Exception as e:
        print(f"[WARN] fetch_latest_progress_timestamps error: {e}")
        rows = []

    mapping = {}
    stage_map = {
        1: "personal_updated_at",
        2: "interview_updated_at",
        3: "mail_updated_at",
        4: "document_updated_at",
        5: "completed_at",
    }

    for r in rows:
        ts = r.get("crc6f_completedat") or r.get("crc6f_timestamps")
        if not ts:
            continue

        key = None
        ref = r.get("crc6f_stagenumber") or r.get("crc6f_refid")

        try:
            if ref is not None:
                key = stage_map.get(int(ref))
        except Exception:
            key = None

        if not key:
            stage = (r.get("crc6f_stagename") or r.get("crc6f_progresssteps") or "").lower()
            if "personal" in stage:
                key = "personal_updated_at"
            elif "schedule" in stage or "interview" in stage:
                key = "interview_updated_at"
            elif "offer" in stage or "mail" in stage:
                key = "mail_updated_at"
            elif "document" in stage or "verification" in stage:
                key = "document_updated_at"
            elif "onboarding" in stage or "complete" in stage:
                key = "completed_at"

        if key and key not in mapping:
            mapping[key] = ts
        if len(mapping) >= len(stage_map):
            break
    return mapping
    
    # Fallback to default
    ONBOARDING_ENTITY_RESOLVED = ONBOARDING_ENTITY
    return ONBOARDING_ENTITY

def _fill_stage_ts_fallbacks(formatted_item: dict, raw_record: dict):
    """Fill missing stage timestamps from existing fields when logs are absent.
    Uses createdon/modifiedon/interview_date/doj to approximate.
    """
    try:
        created_on = raw_record.get('createdon') or raw_record.get('CreatedOn')
        modified_on = raw_record.get('modifiedon') or raw_record.get('ModifiedOn')

        # Stage 1: Personal Information
        if not formatted_item.get('personal_updated_at'):
            formatted_item['personal_updated_at'] = created_on or formatted_item.get('doj')

        # Stage 2: Scheduling Interview
        if not formatted_item.get('interview_updated_at') and formatted_item.get('interview_date'):
            formatted_item['interview_updated_at'] = formatted_item['interview_date']

        # Stage 3: Offer Acceptance
        mr = (formatted_item.get('mail_reply') or '').strip()
        if not formatted_item.get('mail_updated_at') and mr and mr.lower() != 'pending':
            formatted_item['mail_updated_at'] = modified_on

        # Stage 4: Onboarding (DOJ-based timestamp)
        if not formatted_item.get('completed_at') and formatted_item.get('doj'):
            formatted_item['completed_at'] = formatted_item.get('doj')

        # Stage 5: Physical Document Verification
        if not formatted_item.get('document_updated_at') and (formatted_item.get('document_status') or '').lower() == 'verified':
            formatted_item['document_updated_at'] = modified_on

    except Exception:
        pass

def generate_employee_id():
    """Generate sequential Employee ID in format EMP### by inspecting existing records."""
    try:
        token = get_access_token()
        entity_set = get_employee_entity_set(token)
        field_map = get_field_map(entity_set)
        id_field = field_map.get('id') or 'crc6f_employeeid'

        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0"
        }

        url = f"{RESOURCE}/api/data/v9.2/{entity_set}?$select={id_field}&$orderby=createdon desc&$top=200"
        response = requests.get(url, headers=headers, timeout=15)

        max_num = 0
        if response.status_code == 200:
            rows = response.json().get('value', [])
            for row in rows:
                raw_id = str(row.get(id_field) or '').strip().upper()
                if not raw_id:
                    continue
                if not raw_id.startswith('EMP'):
                    continue
                match = re.search(r"(\d+)$", raw_id)
                if not match:
                    continue
                try:
                    num = int(match.group(1))
                    if num > max_num:
                        max_num = num
                except ValueError:
                    continue
        else:
            print(f"[WARN] Could not fetch existing employee IDs (status {response.status_code}): {response.text[:120]}")

        next_num = max_num + 1
        return format_employee_id(next_num)
    except Exception as e:
        print(f"[WARN] Error generating employee ID: {e}")
        return format_employee_id(1)

def generate_login_credentials(email, firstname, lastname):
    """Generate login credentials for new employee"""
    import random
    import string
    
    # Username = email
    username = email
    
    # Generate random password (8 characters)
    password = ''.join(random.choices(string.ascii_letters + string.digits, k=8))
    
    return {
        'username': username,
        'password': password,
        'temp_password': True
    }

def send_offer_letter_email(candidate_data):
    """Send offer letter email to candidate"""
    try:
        subject = "[SUCCESS] Congratulations on Your Offer from VTab Pvt. Ltd.!"
        recipient = candidate_data.get('email')
        firstname = candidate_data.get('firstname', '')
        lastname = candidate_data.get('lastname', '')
        designation = candidate_data.get('designation', '')
        department = candidate_data.get('department', '')
        doj = candidate_data.get('doj', '')
        
        body = f"""Dear {firstname} {lastname},

Congratulations!

We are delighted to offer you the position of {designation} in the {department} department at VTab Pvt. Ltd.

We are excited to have you join our team and look forward to your contributions.

Please reply to this email with "Yes" to confirm your acceptance of this offer.

If you have any questions, please don't hesitate to reach out.

Best Regards,
HR Team
VTab Pvt. Ltd.
"""

        # Use existing mail system – plain text only (no HTML template)
        success = send_email(subject, [recipient], body)
        return success
    except Exception as e:
        print(f"[WARN] Error sending offer letter: {e}")
        return False

def send_interview_rejection_email(candidate_data):
    """Send interview rejection email to candidate"""
    try:
        subject = "[INFO] Interview Update from VTab Pvt. Ltd."
        recipient = candidate_data.get('email')
        firstname = candidate_data.get('firstname', '')
        lastname = candidate_data.get('lastname', '')
        designation = candidate_data.get('designation', '')
        department = candidate_data.get('department', '')

        body = f"""
Dear {firstname} {lastname},

Thank you for taking the time to interview for the {designation} role in the {department} department at VTab Pvt. Ltd.

After careful consideration, we regret to inform you that we will not be moving forward with your application at this time. We truly appreciate your interest in VTab and the effort you put into the interview process.

We will keep your profile on file and reach out should a suitable opportunity arise in the future. We wish you every success in your career search.

Regards,
HR Team
VTab Pvt. Ltd.
        """

        html = f"""
        <html>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <div style="max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
                <h2 style="color: #ef4444;">Interview Update</h2>
                <p>Dear <strong>{firstname} {lastname}</strong>,</p>
                <p>Thank you for taking the time to interview for the <strong>{designation}</strong> role in the <strong>{department}</strong> department at <strong>VTab Pvt. Ltd.</strong></p>
                <p>After careful consideration, we regret to inform you that we will not be moving forward with your application at this time.</p>
                <p>We sincerely appreciate your interest in VTab and the effort you invested throughout the process. We will retain your profile for any future opportunities that match your skills.</p>
                <p>We wish you the very best in your career journey.</p>
                <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">
                <p style="color: #666; font-size: 14px;">
                    Regards,<br>
                    <strong>HR Team</strong><br>
                    VTab Pvt. Ltd.
                </p>
            </div>
        </body>
        </html>
        """

        return send_email(subject, [recipient], body)
    except Exception as e:
        print(f"[WARN] Error sending rejection email: {e}")
        return False

def send_login_credentials_email(employee_data, credentials):
    """Send login credentials to new employee"""
    try:
        subject = "Welcome to VTab Pvt. Ltd. - Your Login Credentials"
        recipient = employee_data.get('email')
        firstname = employee_data.get('firstname', '')
        lastname = employee_data.get('lastname', '')
        emp_id = employee_data.get('employee_id', '')
        username = credentials.get('username')
        password = credentials.get('password')
        
        body = f"""
Dear {firstname} {lastname},

Welcome to VTab Pvt. Ltd.! [SUCCESS]

Your employee account has been created successfully.

Employee ID: {emp_id}
Username: {username}
Temporary Password: {password}

Please login to the HR portal and change your password immediately.

Portal URL: [Your Portal URL]

If you have any issues logging in, please contact the IT support team.

Best Regards,
HR Team
VTab Pvt. Ltd.
        """
        
        html = f"""
        <html>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <div style="max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
                <h2 style="color: #00A7C0;">Welcome to VTab Pvt. Ltd.! [SUCCESS]</h2>
                <p>Dear <strong>{firstname} {lastname}</strong>,</p>
                <p>Your employee account has been created successfully.</p>
                <div style="background: #f9fafb; padding: 15px; border-left: 4px solid #00A7C0; margin: 20px 0;">
                    <p style="margin: 5px 0;"><strong>Employee ID:</strong> {emp_id}</p>
                    <p style="margin: 5px 0;"><strong>Username:</strong> {username}</p>
                    <p style="margin: 5px 0;"><strong>Temporary Password:</strong> {password}</p>
                </div>
                <p><strong>[WARN] Please login to the HR portal and change your password immediately.</strong></p>
                <p>If you have any issues logging in, please contact the IT support team.</p>
                <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">
                <p style="color: #666; font-size: 14px;">
                    Best Regards,<br>
                    <strong>HR Team</strong><br>
                    VTab Pvt. Ltd.
                </p>
            </div>
        </body>
        </html>
        """
        
        success = send_email(subject, [recipient], body)
        return success
    except Exception as e:
        print(f"[WARN] Error sending login credentials: {e}")
        return False

# ==================== STATIC UPLOADS SERVE ====================
@app.route('/uploads/<path:filename>', methods=['GET'])
def serve_upload(filename):
    try:
        # Ensure directory exists
        os.makedirs(UPLOADS_DIR, exist_ok=True)
        from flask import send_from_directory
        return send_from_directory(UPLOADS_DIR, filename, as_attachment=False)
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 404

# ==================== ONBOARDING API ROUTES ====================

@app.route('/api/onboarding', methods=['GET'])
def list_onboarding_records():
    """Get all onboarding records with optional search"""
    try:
        token = get_access_token()
        entity_set = get_onboarding_entity_set(token)
        search_query = request.args.get('search', '').strip()
        
        select_fields = [
            'crc6f_hr_onboardingid', 'crc6f_firstname', 'crc6f_lastname', 'crc6f_email', 'crc6f_contactno',
            'crc6f_address', 'crc6f_department', 'crc6f_designation', 'crc6f_doj', 'crc6f_progresssteps',
            'crc6f_interviewstatus', 'crc6f_interviewdate', 'crc6f_offerpmail', 'crc6f_offerpmailreply',
            'crc6f_documentsstatus', 'crc6f_documentsuploaded', 'crc6f_onboardingid', 'crc6f_convertedtoemployee',
            'createdon', 'modifiedon'
        ]
        url = f"{BASE_URL}/{entity_set}?$select={','.join(select_fields)}"
        if search_query:
            # Search by firstname, lastname, or email
            url += f"&$filter=contains(crc6f_firstname, '{search_query}') or contains(crc6f_lastname, '{search_query}') or contains(crc6f_email, '{search_query}')"
        
        response = requests.get(url, headers={"Authorization": f"Bearer {token}"})
        
        if response.status_code == 200:
            records = response.json().get('value', [])
            # Map Dataverse fields to frontend format
            formatted_records = []
            for record in records:
                item = {
                    'id': record.get('crc6f_hr_onboardingid'),
                    'firstname': record.get('crc6f_firstname'),
                    'lastname': record.get('crc6f_lastname'),
                    'email': record.get('crc6f_email'),
                    'contact': record.get('crc6f_contactno'),  # Fixed: contactno
                    'address': record.get('crc6f_address'),
                    'department': record.get('crc6f_department'),
                    'designation': record.get('crc6f_designation'),
                    'doj': record.get('crc6f_doj'),
                    'progress_step': record.get('crc6f_progresssteps', 'Personal Information'),  # Fixed: progresssteps
                    'interview_status': record.get('crc6f_interviewstatus'),
                    'interview_date': record.get('crc6f_interviewdate'),
                    'mail_status': record.get('crc6f_offerpmail'),  # Fixed: offerpmail
                    'mail_reply': record.get('crc6f_offerpmailreply'),  # Fixed: offerpmailreply
                    'document_status': record.get('crc6f_documentsstatus'),  # Fixed: documentsstatus
                    'document_urls': record.get('crc6f_documentsuploaded'),  # Fixed: documentsuploaded
                    'employee_id': record.get('crc6f_onboardingid'),  # Fixed: onboardingid
                    'converted_to_master': record.get('crc6f_convertedtoemployee', False),  # Fixed: convertedtoemployee
                    'created_at': record.get('createdon'),
                    'updated_at': record.get('modifiedon')
                }
                try:
                    if item.get('id'):
                        ts_map = fetch_latest_progress_timestamps(token, item['id'])
                        item.update(ts_map)
                except Exception as e:
                    print(f"[WARN] Could not fetch timestamps for {item.get('id')}: {e}")
                # Always try to fill fallbacks from raw record
                try:
                    _fill_stage_ts_fallbacks(item, record)
                except Exception:
                    pass
                formatted_records.append(item)

            return jsonify({'success': True, 'records': formatted_records}), 200
        else:
            return jsonify({'success': False, 'message': 'Failed to fetch onboarding records'}), 500
    except Exception as e:
        print(f"[ERROR] Error fetching onboarding records: {e}")
        traceback.print_exc()
        return jsonify({'success': False, 'message': str(e)}), 500

@app.route('/api/onboarding/<record_id>', methods=['GET'])
def get_onboarding_record(record_id):
    """Get a single onboarding record by ID"""
    try:
        token = get_access_token()
        entity_set = get_onboarding_entity_set(token)

        url = f"{BASE_URL}/{entity_set}({record_id})"
        response = requests.get(url, headers={"Authorization": f"Bearer {token}"})

        if response.status_code == 200:
            record = response.json()
            doc_urls = []
            try:
                file_metadata = record.get('crc6f_documentsuploaded')
                if file_metadata:
                    if isinstance(file_metadata, dict):
                        filename = file_metadata.get('name', 'document')
                        doc_urls = [filename]
                    elif isinstance(file_metadata, str):
                        doc_urls = [file_metadata]
            except Exception as e:
                print(f"[WARN] Could not parse document metadata: {e}")
                doc_urls = []
            formatted_record = {
                'id': record.get('crc6f_hr_onboardingid'),
                'firstname': record.get('crc6f_firstname'),
                'lastname': record.get('crc6f_lastname'),
                'email': record.get('crc6f_email'),
                'contact': record.get('crc6f_contactno'),  # Fixed: contactno
                'address': record.get('crc6f_address'),
                'department': record.get('crc6f_department'),
                'designation': record.get('crc6f_designation'),
                'doj': record.get('crc6f_doj'),
                'progress_step': record.get('crc6f_progresssteps', 'Personal Information'),  # Fixed: progresssteps
                'interview_status': record.get('crc6f_interviewstatus'),
                'interview_date': record.get('crc6f_interviewdate'),
                'mail_status': record.get('crc6f_offerpmail'),  # Fixed: offerpmail
                'mail_reply': record.get('crc6f_offerpmailreply'),  # Fixed: offerpmailreply
                'document_status': record.get('crc6f_documentsstatus'),  # Fixed: documentsstatus
                'document_urls': doc_urls,  # Fixed: documentsuploaded
                'employee_id': record.get('crc6f_onboardingid'),  # Fixed: onboardingid
                'converted_to_master': record.get('crc6f_convertedtoemployee', False),  # Fixed: convertedtoemployee
                'created_at': record.get('createdon'),
                'updated_at': record.get('modifiedon')
            }
            try:
                if formatted_record.get('id'):
                    ts_map = fetch_latest_progress_timestamps(token, formatted_record['id'])
                    formatted_record.update(ts_map)
            except Exception as e:
                print(f"[WARN] Could not fetch timestamps for {formatted_record.get('id')}: {e}")
            # Fallbacks from raw record
            try:
                _fill_stage_ts_fallbacks(formatted_record, record)
            except Exception:
                pass
            return jsonify({'success': True, 'record': formatted_record}), 200
        else:
            return jsonify({'success': False, 'message': 'Record not found'}), 404
    except Exception as e:
        print(f"[ERROR] Error fetching onboarding record: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500

@app.route('/api/onboarding/<record_id>', methods=['DELETE'])
def delete_onboarding_record(record_id):
    """Delete an onboarding record and its progress logs (best-effort)."""
    try:
        if not record_id or str(record_id).lower() == 'null':
            return jsonify({'success': False, 'message': 'Invalid onboarding identifier'}), 400

        token = get_access_token()
        entity_set = get_onboarding_entity_set(token)

        # Best-effort: delete associated progress logs first
        try:
            pl_set = get_progress_log_entity_set(token)
            headers = {
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "OData-MaxVersion": "4.0",
                "OData-Version": "4.0",
            }
            safe_id = str(record_id).replace("'", "''")
            urls = [
                f"{BASE_URL}/{pl_set}?$filter=_crc6f_onboardingid_value eq '{safe_id}'&$top=500",
                f"{BASE_URL}/{pl_set}?$filter=_crc6f_onboardingid_value eq guid'{safe_id}'&$top=500",
                f"{BASE_URL}/{pl_set}?$filter=crc6f_onboardingid eq '{safe_id}'&$top=500",
                f"{BASE_URL}/{pl_set}?$filter=crc6f_onboardingid eq guid'{safe_id}'&$top=500",
            ]
            values = []
            for u in urls:
                try:
                    resp = requests.get(u, headers=headers, timeout=20)
                    if resp.status_code == 200:
                        values = resp.json().get('value', [])
                        if values:
                            break
                except Exception:
                    continue
            # Delete each progress log row by its primary key
            prefer_keys = [f"{pl_set[:-1]}id", f"{pl_set}id"]
            for row in values:
                try:
                    log_id = _extract_record_id(row, prefer_keys)
                    if log_id:
                        delete_record(pl_set, log_id)
                except Exception:
                    continue
        except Exception:
            pass

        # Delete the onboarding record itself
        delete_record(entity_set, record_id)
        return jsonify({'success': True}), 200
    except Exception as e:
        print(f"[ERROR] Error deleting onboarding record {record_id}: {e}")
        traceback.print_exc()
        return jsonify({'success': False, 'message': str(e)}), 500

@app.route('/api/onboarding/<record_id>', methods=['PUT'])
def update_onboarding_record(record_id):
    """Update personal information fields for an onboarding record"""
    try:
        token = get_access_token()
        entity_set = get_onboarding_entity_set(token)
        data = request.get_json() or {}

        payload = {}
        if 'firstname' in data: payload['crc6f_firstname'] = data.get('firstname')
        if 'lastname' in data: payload['crc6f_lastname'] = data.get('lastname')
        if 'email' in data: payload['crc6f_email'] = data.get('email')
        if 'contact' in data: payload['crc6f_contactno'] = data.get('contact')
        if 'address' in data: payload['crc6f_address'] = data.get('address')
        if 'department' in data: payload['crc6f_department'] = data.get('department')
        if 'designation' in data: payload['crc6f_designation'] = data.get('designation')
        if 'doj' in data: payload['crc6f_doj'] = data.get('doj')

        if not payload:
            return jsonify({'success': False, 'message': 'No fields to update'}), 400

        update_record(entity_set, record_id, payload)

        # Fetch updated record and return in formatted structure
        url = f"{BASE_URL}/{entity_set}({record_id})?$select=crc6f_hr_onboardingid,crc6f_firstname,crc6f_lastname,crc6f_email,crc6f_contactno,crc6f_address,crc6f_department,crc6f_designation,crc6f_doj,crc6f_progresssteps,crc6f_interviewstatus,crc6f_interviewdate,crc6f_offerpmail,crc6f_offerpmailreply,crc6f_documentsstatus,crc6f_documentsuploaded,crc6f_onboardingid,crc6f_convertedtoemployee,createdon,modifiedon"
        response = requests.get(url, headers={"Authorization": f"Bearer {token}"})
        if response.status_code != 200:
            return jsonify({'success': True, 'message': 'Updated successfully'}), 200
        record = response.json()
        formatted = {
            'id': record.get('crc6f_hr_onboardingid'),
            'firstname': record.get('crc6f_firstname'),
            'lastname': record.get('crc6f_lastname'),
            'email': record.get('crc6f_email'),
            'contact': record.get('crc6f_contactno'),
            'address': record.get('crc6f_address'),
            'department': record.get('crc6f_department'),
            'designation': record.get('crc6f_designation'),
            'doj': record.get('crc6f_doj'),
            'progress_step': record.get('crc6f_progresssteps', 'Personal Information'),
            'interview_status': record.get('crc6f_interviewstatus'),
            'interview_date': record.get('crc6f_interviewdate'),
            'mail_status': record.get('crc6f_offerpmail'),
            'mail_reply': record.get('crc6f_offerpmailreply'),
            'document_status': record.get('crc6f_documentsstatus'),
            'document_urls': record.get('crc6f_documentsuploaded'),
            'employee_id': record.get('crc6f_onboardingid'),
            'converted_to_master': record.get('crc6f_convertedtoemployee', False),
            'created_at': record.get('createdon'),
            'updated_at': record.get('modifiedon')
        }
        try:
            if formatted.get('id'):
                ts_map = fetch_latest_progress_timestamps(token, formatted['id'])
                formatted.update(ts_map)
        except Exception:
            pass
        try:
            _fill_stage_ts_fallbacks(formatted, record)
        except Exception:
            pass

        return jsonify({'success': True, 'record': formatted}), 200
    except Exception as e:
        print(f"[ERROR] Error updating onboarding record: {e}")
        traceback.print_exc()
        return jsonify({'success': False, 'message': str(e)}), 500
@app.route('/api/onboarding', methods=['POST'])
def create_onboarding_record():
    """Create new onboarding record (Stage 1: Personal Information)"""
    try:
        data = request.get_json()
        print(f"\n[LOG] Creating onboarding record with data: {data}")
        
        token = get_access_token()
        entity_set = get_onboarding_entity_set(token)
        print(f"[OK] Using entity set: {entity_set}")
        
        # Basic validation for required fields
        required = ['firstname', 'lastname', 'email', 'contact', 'department', 'designation']
        missing = [k for k in required if not str(data.get(k, '')).strip()]
        if missing:
            return jsonify({
                'success': False,
                'message': f"Missing required fields: {', '.join(missing)}"
            }), 400

        # Sanitize DOJ: only include if non-empty and in YYYY-MM-DD
        doj_raw = (data.get('doj') or '').strip()
        doj_value = doj_raw if doj_raw else None

        # Prepare minimal Dataverse payload with core text fields only
        # to avoid Choice/OptionSet validation errors on creation
        payload = {
            'crc6f_firstname': data.get('firstname'),
            'crc6f_lastname': data.get('lastname'),
            'crc6f_email': data.get('email'),
            'crc6f_contactno': data.get('contact'),
            'crc6f_address': data.get('address'),
            'crc6f_department': data.get('department'),
            'crc6f_designation': data.get('designation')
        }
        if doj_value:
            payload['crc6f_doj'] = doj_value

        print(f"📦 Payload: {payload}")
        
        # Create record in Dataverse
        print(f"[PROC] Calling create_record...")
        created_record = create_record(entity_set, payload)
        print(f"[OK] Record created: {created_record}")
        
        if created_record:
            record_id = created_record.get('crc6f_hr_onboardingid')
            # Best-effort status defaults (may be Choice fields) — ignore failures
            try:
                status_update = {
                    'crc6f_progresssteps': 'Interview Scheduled',
                    'crc6f_interviewstatus': 'Pending',
                    'crc6f_offerpmail': 'Not Sent',
                    'crc6f_offerpmailreply': 'Pending',
                    'crc6f_documentsstatus': 'Pending',
                    'crc6f_convertedtoemployee': False
                }
                update_record(entity_set, record_id, status_update)
            except Exception as uerr:
                print(f"[WARN] Non-fatal: could not set default status fields: {uerr}")

            try:
                create_progress_log_row(token, record_id, "Personal Information", 1, _now_iso())
            except Exception:
                pass

            formatted_record = {
                'id': record_id,
                'firstname': created_record.get('crc6f_firstname'),
                'lastname': created_record.get('crc6f_lastname'),
                'email': created_record.get('crc6f_email'),
                'progress_step': 'Interview Scheduled'
            }
            return jsonify({'success': True, 'record': formatted_record, 'message': 'Onboarding record created successfully'}), 201
        
        return jsonify({'success': False, 'message': 'Failed to create onboarding record'}), 500
    except Exception as e:
        error_msg = str(e)
        print(f"[ERROR] Error creating onboarding record: {error_msg}")
        traceback.print_exc()
        
        # Check if it's a table not found error
        if "404" in error_msg or "not found" in error_msg.lower():
            return jsonify({
                'success': False, 
                'message': 'Onboarding table not found in Dataverse. Please create the table "crc6f_hr_onboarding" or "crc6f_hr_onboardings" with all required fields.',
                'error': error_msg
            }), 500
        
        return jsonify({'success': False, 'message': error_msg, 'error': str(e)}), 500

@app.route('/api/onboarding/<record_id>/interview', methods=['PUT'])
def update_interview_status(record_id):
    """Update interview status and trigger relevant emails (Stage 2)"""
    try:
        data = request.get_json()
        token = get_access_token()
        entity_set = get_onboarding_entity_set(token)

        interview_status = data.get('interview_status')
        interview_date = data.get('interview_date')

        # Fetch candidate details for email context and previous status comparison
        candidate = None
        url = f"{BASE_URL}/{entity_set}({record_id})"
        response = requests.get(url, headers={"Authorization": f"Bearer {token}"})
        if response.status_code == 200:
            candidate = response.json()
        else:
            return jsonify({'success': False, 'message': 'Onboarding record not found'}), 404

        previous_status = (candidate.get('crc6f_interviewstatus') or '').strip().lower()
        candidate_data = {
            'email': candidate.get('crc6f_email'),
            'firstname': candidate.get('crc6f_firstname'),
            'lastname': candidate.get('crc6f_lastname'),
            'designation': candidate.get('crc6f_designation'),
            'department': candidate.get('crc6f_department'),
            'doj': candidate.get('crc6f_doj')
        }

        # Prepare update payload for status/date
        update_payload = {
            'crc6f_interviewstatus': interview_status,
            'crc6f_interviewdate': interview_date
        }
        update_record(entity_set, record_id, update_payload)
        try:
            if interview_date:
                create_progress_log_row(token, record_id, "Scheduling Interview", 2, _now_iso())
        except Exception:
            pass

        # Note: Email sending is now handled by the combined /update-result-send-mail endpoint
        # This endpoint only updates the interview status without sending emails

        return jsonify({
            'success': True,
            'message': 'Interview status updated successfully.'
        }), 200
    except Exception as e:
        print(f"[ERROR] Error updating interview status: {e}")
        traceback.print_exc()
        return jsonify({'success': False, 'message': str(e)}), 500

# New: Schedule interview email (Stage 2 - scheduling)
@app.route('/api/onboarding/<record_id>/schedule-interview', methods=['POST'])
def schedule_interview_email(record_id):
    """Send interview scheduling email with date and optional meet link, and store date."""
    try:
        data = request.get_json() or {}
        interview_date = data.get('interview_date')
        interview_time = data.get('interview_time')
        meet_link = data.get('meet_link')

        token = get_access_token()
        entity_set = get_onboarding_entity_set(token)

        # Fetch candidate details
        url = f"{BASE_URL}/{entity_set}({record_id})"
        response = requests.get(url, headers={"Authorization": f"Bearer {token}"})
        if response.status_code != 200:
            return jsonify({'success': False, 'message': 'Onboarding record not found'}), 404
        candidate = response.json()

        recipient = candidate.get('crc6f_email')
        firstname = candidate.get('crc6f_firstname', '')
        lastname = candidate.get('crc6f_lastname', '')

        time_line = f"\nTime: {interview_time}" if interview_time else ""
        link_line = f"\nMeeting link: {meet_link}" if meet_link else ""
        body = f"""
Dear {firstname} {lastname},

Your interview has been scheduled on {interview_date}.{time_line}{link_line}

If the above time does not work, please reply to this mail with alternatives.

Regards,
HR Team
VTab Pvt. Ltd.
"""
        html = f"""
        <p>Dear <strong>{firstname} {lastname}</strong>,</p>
        <p>Your interview has been scheduled on <strong>{interview_date}</strong>.</p>
        {f'<p><strong>Time:</strong> {interview_time}</p>' if interview_time else ''}
        {f'<p>Meeting link: <a href="{meet_link}">{meet_link}</a></p>' if meet_link else ''}
        <p>If the above time does not work, please reply to this mail with alternatives.</p>
        <p>Regards,<br/>HR Team<br/>VTab Pvt. Ltd.</p>
        """

        # Send email (plain text only)
        sent = send_email(subject="Interview Schedule - VTab Pvt. Ltd.", recipients=[recipient], body=body)

        # Persist interview date and mark progress as scheduled
        try:
            update_payload = {
                'crc6f_interviewdate': interview_date,
                'crc6f_progresssteps': 'Scheduling Interview'
            }
            update_record(entity_set, record_id, update_payload)
        except Exception as upd_err:
            print(f"[WARN] Failed to update interview date/progress: {upd_err}")

        try:
            if interview_date:
                create_progress_log_row(token, record_id, "Scheduling Interview", 2, _now_iso())
        except Exception:
            pass

        return jsonify({'success': True, 'scheduled': bool(sent)}), 200
    except Exception as e:
        print(f"[ERROR] Error scheduling interview email: {e}")
        traceback.print_exc()
        return jsonify({'success': False, 'message': str(e)}), 500

# New: Send offer letter explicitly (Stage 2 -> Stage 3 transition)
@app.route('/api/onboarding/<record_id>/send-offer', methods=['POST'])
def send_offer_letter(record_id):
    try:
        token = get_access_token()
        entity_set = get_onboarding_entity_set(token)

        # Fetch candidate details
        url = f"{BASE_URL}/{entity_set}({record_id})"
        response = requests.get(url, headers={"Authorization": f"Bearer {token}"})
        if response.status_code != 200:
            return jsonify({'success': False, 'message': 'Onboarding record not found'}), 404
        candidate = response.json()

        candidate_data = {
            'email': candidate.get('crc6f_email'),
            'firstname': candidate.get('crc6f_firstname'),
            'lastname': candidate.get('crc6f_lastname'),
            'designation': candidate.get('crc6f_designation'),
            'department': candidate.get('crc6f_department'),
            'doj': candidate.get('crc6f_doj')
        }
        current_reply = (candidate.get('crc6f_offerpmailreply') or '').strip().lower()

        ok = send_offer_letter_email(candidate_data)

        # Update mail status and progress to Offer Acceptance
        try:
            update_payload = {
                'crc6f_offerpmail': 'Sent',
                'crc6f_progresssteps': 'Offer Acceptance'
            }
            if current_reply not in ('yes', 'no'):
                update_payload['crc6f_offerpmailreply'] = 'Pending'
            update_record(entity_set, record_id, update_payload)
        except Exception as upd_err:
            print(f"[WARN] Failed to update offer mail status/progress: {upd_err}")

        return jsonify({'success': True, 'message': 'Offer letter sent' if ok else 'Offer send attempted'}), 200
    except Exception as e:
        print(f"[ERROR] Error sending offer letter: {e}")
        traceback.print_exc()
        return jsonify({'success': False, 'message': str(e)}), 500

# Combined: Update interview result AND send appropriate email (single button action)
@app.route('/api/onboarding/<record_id>/update-result-send-mail', methods=['POST'])
def update_result_and_send_mail(record_id):
    """Combined endpoint: Update interview result and send appropriate email based on status"""
    try:
        data = request.get_json() or {}
        interview_status = data.get('interview_status', 'Pending')
        
        token = get_access_token()
        entity_set = get_onboarding_entity_set(token)

        # Fetch candidate details
        url = f"{BASE_URL}/{entity_set}({record_id})"
        response = requests.get(url, headers={"Authorization": f"Bearer {token}"})
        if response.status_code != 200:
            return jsonify({'success': False, 'message': 'Onboarding record not found'}), 404
        candidate = response.json()

        candidate_data = {
            'email': candidate.get('crc6f_email'),
            'firstname': candidate.get('crc6f_firstname'),
            'lastname': candidate.get('crc6f_lastname'),
            'designation': candidate.get('crc6f_designation'),
            'department': candidate.get('crc6f_department'),
            'doj': candidate.get('crc6f_doj')
        }

        # Update interview status first
        update_payload = {
            'crc6f_interviewstatus': interview_status
        }

        status_lc = (interview_status or '').strip().lower()
        email_sent = False
        message = 'Interview result updated.'

        if status_lc == 'passed':
            # Send offer letter and update progress
            email_sent = send_offer_letter_email(candidate_data)
            update_payload['crc6f_offerpmail'] = 'Sent'
            update_payload['crc6f_progresssteps'] = 'Offer Acceptance'
            current_reply = (candidate.get('crc6f_offerpmailreply') or '').strip().lower()
            if current_reply not in ('yes', 'no'):
                update_payload['crc6f_offerpmailreply'] = 'Pending'
            message = 'Interview passed. Offer letter sent!' if email_sent else 'Interview passed. Offer send attempted.'
            try:
                create_progress_log_row(token, record_id, "Offer Acceptance", 3, _now_iso())
            except Exception:
                pass

        elif status_lc == 'failed':
            # Send rejection email
            email_sent = send_interview_rejection_email(candidate_data)
            message = 'Interview failed. Rejection email sent.' if email_sent else 'Interview failed. Rejection send attempted.'
            try:
                create_progress_log_row(token, record_id, "Interview Result - Failed", 2, _now_iso())
            except Exception:
                pass

        # Apply updates to Dataverse
        update_record(entity_set, record_id, update_payload)

        return jsonify({
            'success': True,
            'email_sent': email_sent,
            'message': message
        }), 200

    except Exception as e:
        print(f"[ERROR] Error in combined update-result-send-mail: {e}")
        traceback.print_exc()
        return jsonify({'success': False, 'message': str(e)}), 500

@app.route('/api/onboarding/<record_id>/mail-reply', methods=['PUT'])
def update_mail_reply(record_id):
    """Update mail reply status (Stage 3)"""
    try:
        data = request.get_json()
        token = get_access_token()
        entity_set = get_onboarding_entity_set(token)
        
        raw_reply = (data.get('mail_reply') or '').strip()
        reply_lc = raw_reply.lower()
        positive_values = {'yes', 'y', 'accept', 'accepted', 'agree', 'agreed', 'confirmed', 'confirm'}
        negative_values = {'no', 'n', 'decline', 'declined', 'reject', 'rejected', 'negative'}

        if reply_lc in positive_values:
            mail_reply = 'Yes'
        elif reply_lc in negative_values:
            mail_reply = 'No'
        else:
            mail_reply = 'Pending'

        # Update mail reply and keep progress in Offer Acceptance until documents arrive
        update_payload = {
            'crc6f_offerpmailreply': mail_reply,  # Fixed: offerpmailreply
            'crc6f_progresssteps': 'Offer Acceptance'
        }

        update_record(entity_set, record_id, update_payload)
        try:
            # Log only when the candidate has accepted
            if mail_reply == 'Yes':
                create_progress_log_row(token, record_id, "Offer Acceptance", 3, _now_iso())
            elif mail_reply == 'No':
                create_progress_log_row(token, record_id, "Offer Declined", 3, _now_iso())
        except Exception:
            pass

        return jsonify({'success': True, 'message': 'Mail reply updated successfully', 'reply': mail_reply}), 200
    except Exception as e:
        print(f"[ERROR] Error updating mail reply: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500

@app.route('/api/onboarding/<record_id>/check-email', methods=['GET'])
def check_email_reply(record_id):
    """Check for email reply (Stage 3) - Check inbox for candidate response"""
    try:
        token = get_access_token()
        onboarding_entity = get_onboarding_entity_set(token)
        
        # 1) Fetch onboarding record to get candidate email
        url = f"{BASE_URL}/{onboarding_entity}({record_id})"
        response = requests.get(url, headers={"Authorization": f"Bearer {token}"})
        if response.status_code != 200:
            return jsonify({'success': False, 'message': 'Onboarding record not found'}), 404
        
        onboarding_record = response.json()
        candidate_email = onboarding_record.get('crc6f_email', '').strip().lower()
        
        if not candidate_email:
            return jsonify({'success': False, 'message': 'No candidate email found'}), 400
        
        # 2) Connect to email inbox via IMAP
        mail_username = os.getenv('MAIL_USERNAME')
        mail_password = os.getenv('MAIL_PASSWORD')
        imap_server = os.getenv('IMAP_SERVER', 'imap.gmail.com')
        
        if not mail_username or not mail_password:
            return jsonify({'success': False, 'message': 'Email credentials not configured'}), 200
        
        try:
            imap = imaplib.IMAP4_SSL(imap_server)
            imap.login(mail_username, mail_password)
            imap.select('INBOX')
        except imaplib.IMAP4.error as auth_err:
            return jsonify({'success': False, 'message': f'IMAP auth failed: {str(auth_err)}'}), 200
        except Exception as conn_err:
            return jsonify({'success': False, 'message': f'IMAP connection failed: {str(conn_err)}'}), 200
        
        # 3) Search for emails from candidate
        status, messages = imap.search(None, f'FROM "{candidate_email}"')
        
        if status != 'OK' or not messages[0]:
            imap.logout()
            return jsonify({'success': False, 'message': 'No reply found yet'}), 200
        
        # 4) Check most recent email for acceptance keywords
        email_ids = messages[0].split()
        latest_id = email_ids[-1]
        
        status, msg_data = imap.fetch(latest_id, '(RFC822)')
        if status != 'OK':
            imap.logout()
            return jsonify({'success': False, 'message': 'Failed to fetch email'}), 200
        
        email_body = msg_data[0][1]
        email_message = email.message_from_bytes(email_body)
        
        # Extract email content
        body = ""
        if email_message.is_multipart():
            for part in email_message.walk():
                if part.get_content_type() == "text/plain":
                    try:
                        body = part.get_payload(decode=True).decode(errors='ignore')
                    except Exception:
                        body = ''
                    break
        else:
            try:
                body = email_message.get_payload(decode=True).decode(errors='ignore')
            except Exception:
                body = ''
        
        imap.logout()
        
        # 5) Check for acceptance keywords
        body_lower = body.lower()

        accept_patterns = [r"\byes\b", r"\bi accept\b", r"\baccept\b", r"\bagree\b", r"\bconfirm\b"]
        decline_patterns = [r"\bno\b", r"\bdecline\b", r"\breject\b", r"\bcannot\b", r"can't", r"cannot accept", r"will not", r"not interested", r"i am not interested"]

        accepted = any(re.search(pattern, body_lower) for pattern in accept_patterns)
        declined = any(re.search(pattern, body_lower) for pattern in decline_patterns)

        # Prioritize decline over accept if both keywords found
        if declined:
            # Update mail_reply to "No"
            try:
                update_record(onboarding_entity, record_id, {"crc6f_offerpmailreply": "No"})
                return jsonify({'success': True, 'message': 'Candidate declined the offer.', 'reply': 'No'}), 200
            except Exception as upd_err:
                print(f"[ERROR] Failed to update mail_reply to No: {upd_err}")
                return jsonify({'success': False, 'message': 'Found decline but failed to update record'}), 200
        
        elif accepted:
            # Update mail_reply to "Yes" and move to Stage 4 (Onboarding)
            try:
                update_record(onboarding_entity, record_id, {"crc6f_offerpmailreply": "Yes", "crc6f_progresssteps": "Onboarding"})
                return jsonify({'success': True, 'message': 'Candidate accepted the offer!', 'reply': 'Yes'}), 200
            except Exception as upd_err:
                print(f"[ERROR] Failed to update mail_reply to Yes: {upd_err}")
                return jsonify({'success': False, 'message': 'Found acceptance but failed to update record'}), 200
        
        else:
            return jsonify({'success': False, 'message': 'Email found but no clear response detected'}), 200
        
    except Exception as e:
        print(f"[ERROR] Error checking email: {e}")
        traceback.print_exc()
        # Return 200 with a descriptive message so frontend can show info instead of a hard error
        return jsonify({'success': False, 'message': f'Email check failed: {str(e)}'}), 200


# New: Stage 5 – send documents mail (ask candidate to courier physical documents)
@app.route('/api/onboarding/<record_id>/send-documents-mail', methods=['POST'])
def send_documents_mail(record_id):
    try:
        token = get_access_token()
        entity_set = get_onboarding_entity_set(token)

        # Fetch candidate details
        url = f"{BASE_URL}/{entity_set}({record_id})"
        response = requests.get(url, headers={"Authorization": f"Bearer {token}"})
        if response.status_code != 200:
            return jsonify({'success': False, 'message': 'Onboarding record not found'}), 404
        candidate = response.json()

        recipient = (candidate.get('crc6f_email') or '').strip()
        firstname = candidate.get('crc6f_firstname', '')
        lastname = candidate.get('crc6f_lastname', '')

        if not recipient:
            return jsonify({'success': False, 'message': 'No candidate email found'}), 400

        postal_address = os.getenv(
            'DOCS_POSTAL_ADDRESS',
            'HR Department,\nVTab Pvt. Ltd.\n[Update DOCS_POSTAL_ADDRESS env variable with full postal address].'
        )

        subject = 'Physical Document Submission - VTab Pvt. Ltd.'
        body = f"""Dear {firstname} {lastname},

Please send your physical documents to this address:

{postal_address}

After sending, please reply to this email with: "Yes, sent".

Regards,
HR Team
VTab Pvt. Ltd.
"""

        html_address = '<br/>'.join(postal_address.split('\n'))
        # Email now sent as plain text only; HTML version is no longer used.
        ok = send_email(subject=subject, recipients=[recipient], body=body)
        return jsonify({'success': True, 'message': 'Documents mail sent' if ok else 'Documents mail send attempted'}), 200
    except Exception as e:
        print(f"[ERROR] Error sending documents mail: {e}")
        traceback.print_exc()
        return jsonify({'success': False, 'message': str(e)}), 500


# New: Stage 5 – check for "Yes, sent" reply about physical documents
@app.route('/api/onboarding/<record_id>/check-documents-email', methods=['GET'])
def check_documents_email(record_id):
    """Check inbox for candidate reply indicating physical documents have been sent."""
    try:
        token = get_access_token()
        onboarding_entity = get_onboarding_entity_set(token)

        # Fetch onboarding record to get candidate email
        url = f"{BASE_URL}/{onboarding_entity}({record_id})"
        response = requests.get(url, headers={"Authorization": f"Bearer {token}"})
        if response.status_code != 200:
            return jsonify({'success': False, 'message': 'Onboarding record not found'}), 404

        onboarding_record = response.json()
        candidate_email = (onboarding_record.get('crc6f_email') or '').strip().lower()
        if not candidate_email:
            return jsonify({'success': False, 'message': 'No candidate email found'}), 400

        # Connect to email inbox via IMAP
        mail_username = os.getenv('MAIL_USERNAME')
        mail_password = os.getenv('MAIL_PASSWORD')
        imap_server = os.getenv('IMAP_SERVER', 'imap.gmail.com')

        if not mail_username or not mail_password:
            return jsonify({'success': False, 'message': 'Email credentials not configured'}), 200

        try:
            imap = imaplib.IMAP4_SSL(imap_server)
            imap.login(mail_username, mail_password)
            imap.select('INBOX')
        except imaplib.IMAP4.error as auth_err:
            return jsonify({'success': False, 'message': f'IMAP auth failed: {str(auth_err)}'}), 200
        except Exception as conn_err:
            return jsonify({'success': False, 'message': f'IMAP connection failed: {str(conn_err)}'}), 200

        # Search for emails from candidate
        status, messages = imap.search(None, f'FROM "{candidate_email}"')
        if status != 'OK' or not messages[0]:
            imap.logout()
            return jsonify({'success': False, 'message': 'No reply found yet'}), 200

        # Check most recent email for "Yes, sent" style acknowledgement
        email_ids = messages[0].split()
        latest_id = email_ids[-1]

        status, msg_data = imap.fetch(latest_id, '(RFC822)')
        if status != 'OK':
            imap.logout()
            return jsonify({'success': False, 'message': 'Failed to fetch email'}), 200

        email_body = msg_data[0][1]
        email_message = email.message_from_bytes(email_body)

        body = ""
        if email_message.is_multipart():
            for part in email_message.walk():
                if part.get_content_type() == "text/plain":
                    try:
                        body = part.get_payload(decode=True).decode(errors='ignore')
                    except Exception:
                        body = ''
                    break
        else:
            try:
                body = email_message.get_payload(decode=True).decode(errors='ignore')
            except Exception:
                body = ''

        imap.logout()

        body_lower = body.lower()

        # Look for phrases like "yes, sent" / "yes sent" / "documents sent" etc.
        patterns = [
            r"yes,\s*sent",
            r"yes\s+sent",
            r"documents\s+sent",
            r"sent\s+the\s+documents",
            r"i\s+have\s+sent\s+the\s+documents",
        ]

        acknowledged = any(re.search(p, body_lower) for p in patterns)
        if acknowledged:
            return jsonify({'success': True, 'message': 'Candidate confirmed documents have been sent', 'reply': 'YesSent'}), 200

        return jsonify({'success': False, 'message': 'Email found but no "Yes, sent" confirmation detected'}), 200
    except Exception as e:
        print(f"[ERROR] Error checking documents email: {e}")
        traceback.print_exc()
        return jsonify({'success': False, 'message': f'Documents email check failed: {str(e)}'}), 200


# New: Update document status without completion (Stage 5 manual verification)
@app.route('/api/onboarding/<record_id>/document-status', methods=['PUT'])
def update_document_status_only(record_id):
    """Update document verification status manually (Verified/Not Verified)."""
    try:
        data = request.get_json() or {}
        status_val = data.get('document_status')
        token = get_access_token()
        entity_set = get_onboarding_entity_set(token)

        if status_val not in ['Verified', 'Not Verified', 'Pending']:
            return jsonify({'success': False, 'message': 'Invalid document status'}), 400

        payload = {'crc6f_documentsstatus': status_val}
        if status_val == 'Verified':
            payload['crc6f_progresssteps'] = 'Completed'
        else:
            payload['crc6f_progresssteps'] = 'Physical Document Verification'

        update_record(entity_set, record_id, payload)
        if status_val == 'Verified':
            try:
                # Progress log entries when verification is completed from Stage 5
                create_progress_log_row(token, record_id, "Physical Document Verification", 4, _now_iso())
                create_progress_log_row(token, record_id, "Onboarding", 5, _now_iso())
            except Exception:
                pass

            # Send acknowledgement email that documents were received
            try:
                url = f"{BASE_URL}/{entity_set}({record_id})"
                resp = requests.get(url, headers={"Authorization": f"Bearer {token}"})
                if resp.status_code == 200:
                    rec = resp.json()
                    recipient = (rec.get('crc6f_email') or '').strip()
                    firstname = rec.get('crc6f_firstname', '')
                    lastname = rec.get('crc6f_lastname', '')
                    if recipient:
                        subject = 'Your Physical Documents Are Verified Successfully - VTab Pvt. Ltd.'
                        body = f"""Dear {firstname} {lastname},

We have received your physical documents and they are verified successfully.

Thank you for your prompt response.

Regards,
HR Team
VTab Pvt. Ltd.
"""
                        # Send plain-text confirmation email (HTML version no longer used)
                        send_email(subject=subject, recipients=[recipient], body=body)
            except Exception as mail_err:
                print(f"[WARN] Failed to send documents received email: {mail_err}")

        return jsonify({'success': True, 'message': 'Document status updated'}), 200
    except Exception as e:
        print(f"[ERROR] Error updating document status: {e}")
        traceback.print_exc()
        return jsonify({'success': False, 'message': str(e)}), 500


# New: Send policy letter with DOJ after document verification (Stage 4)
@app.route('/api/onboarding/<record_id>/policy-letter', methods=['POST'])
def send_policy_letter(record_id):
    print(f"[POLICY LETTER] Received request for record_id: {record_id}")
    try:
        from PyPDF2 import PdfReader, PdfWriter
        from reportlab.pdfgen import canvas
        from reportlab.lib.pagesizes import letter
        from io import BytesIO
        
        data = request.get_json() or {}
        doj = data.get('doj')
        print(f"[POLICY LETTER] DOJ: {doj}")
        
        if not doj:
            print("[POLICY LETTER] ERROR: DOJ is required")
            return jsonify({'success': False, 'message': 'DOJ is required'}), 400

        token = get_access_token()
        entity_set = get_onboarding_entity_set(token)
        print(f"[POLICY LETTER] Entity set: {entity_set}")

        # Fetch candidate details
        url = f"{BASE_URL}/{entity_set}({record_id})"
        response = requests.get(url, headers={"Authorization": f"Bearer {token}"})
        if response.status_code != 200:
            return jsonify({'success': False, 'message': 'Onboarding record not found'}), 404
        candidate = response.json()

        recipient = candidate.get('crc6f_email')
        firstname = candidate.get('crc6f_firstname', '')
        lastname = candidate.get('crc6f_lastname', '')
        designation = candidate.get('crc6f_designation', '')
        department = candidate.get('crc6f_department', '')
        print(f"[POLICY LETTER] Recipient: {recipient}, Name: {firstname} {lastname}")

        # Prepare formatted DOJ for display (DD-MM-YYYY)
        display_doj = doj
        try:
            from datetime import datetime as _dt
            # Handle both ISO (YYYY-MM-DD) and already-formatted dates
            if doj and '-' in doj:
                parts = doj.split('-')
                if len(parts[0]) == 4:
                    display_doj = _dt.strptime(doj, '%Y-%m-%d').strftime('%d-%m-%Y')
        except Exception:
            pass

        # Update DOJ in record
        try:
            print(f"[POLICY LETTER] Updating DOJ to: {doj}")
            update_record(entity_set, record_id, {'crc6f_doj': doj, 'crc6f_progresssteps': 'Onboarding'})
            print("[POLICY LETTER] DOJ updated successfully")
        except Exception as upd_err:
            print(f"[POLICY LETTER ERROR] Failed to update DOJ: {upd_err}")
            return jsonify({'success': False, 'message': 'Failed to update DOJ'}), 500

        # Generate personalized PDF from HTML templates
        print("[POLICY LETTER] Generating personalized PDF from HTML templates...")
        try:
            from xhtml2pdf import pisa
            from datetime import datetime as _dt
            
            # Paths
            backend_dir = os.path.dirname(os.path.abspath(__file__))
            offer_template_path = os.path.join(backend_dir, "offer_letter_new_template.html")
            policy_template_path = os.path.join(backend_dir, "policy_template.html")
            
            # Read templates
            with open(offer_template_path, 'r', encoding='utf-8') as f:
                offer_html = f.read()
            with open(policy_template_path, 'r', encoding='utf-8') as f:
                policy_html = f.read()
            
            # Get current date
            current_date = _dt.now().strftime('%d-%m-%Y')
            address = candidate.get('crc6f_address', '')

            # Resolve images for logos/signature
            import base64
            def _data_uri_if_exists(p):
                try:
                    if p and os.path.exists(p):
                        with open(p, 'rb') as f:
                            b64 = base64.b64encode(f.read()).decode('ascii')
                            return f"data:image/png;base64,{b64}"
                except Exception:
                    pass
                return None

            logo_main = os.environ.get('LOGO_MAIN_URL') or _data_uri_if_exists(os.path.join(backend_dir, 'vtab_logo.png')) or ''
            logo_sub  = os.environ.get('LOGO_SUB_URL')  or _data_uri_if_exists(os.path.join(backend_dir, 'siroco_logo.png')) or ''
            sign_img  = os.environ.get('SIGN_IMG_URL')  or _data_uri_if_exists(os.path.join(backend_dir, 'signature.png')) or ''
            
            # Prepare context for offer letter
            offer_context = {
                'current_date': current_date,
                'candidate_name': f"{firstname} {lastname}".strip(),
                'candidate_address': address or 'Address not provided',
                'designation': designation or 'Employee',
                'date_of_joining': display_doj,
                'logo_main': logo_main,
                'logo_sub': logo_sub,
                'sign_img': sign_img
            }
            
            # Prepare context for policy letter
            policy_context = {
                'candidate_name': f"{firstname} {lastname}".strip(),
                'unpaid_duration': '3',
                'training_duration': '3',
                'training_salary': '₹10,000',
                'probation_duration': '6',
                'probation_salary': '₹15,000',
                'postprobation_salary': '₹20,000',
                'postprobation_duration': '12',
                'work_hours_start': '9:00 AM',
                'work_hours_end': '6:00 PM'
            }
            
            # Replace placeholders in offer letter
            for key, value in offer_context.items():
                offer_html = offer_html.replace('{{' + key + '}}', str(value))
            
            # Replace placeholders in policy letter
            for key, value in policy_context.items():
                policy_html = policy_html.replace('{{' + key + '}}', str(value))
            
            print(f"[PDF GENERATION] Name: {offer_context['candidate_name']}")
            print(f"[PDF GENERATION] Designation: {offer_context['designation']}")
            print(f"[PDF GENERATION] DOJ: {offer_context['date_of_joining']}")
            
            # Generate offer letter PDF
            offer_pdf = BytesIO()
            pisa_status = pisa.CreatePDF(offer_html, dest=offer_pdf)
            if pisa_status.err:
                raise Exception("Offer letter PDF generation failed")
            offer_pdf.seek(0)
            print("[PDF GENERATION] Offer letter PDF generated")
            
            # Generate policy PDF
            policy_pdf = BytesIO()
            pisa_status = pisa.CreatePDF(policy_html, dest=policy_pdf)
            if pisa_status.err:
                raise Exception("Policy PDF generation failed")
            policy_pdf.seek(0)
            print("[PDF GENERATION] Policy PDF generated")
            
            # Build Offer Letter (separate PDF): static p1 & p3 where available, generated p2
            offer_reader = PdfReader(offer_pdf)
            cover_path = os.path.join(backend_dir, 'offer_cover_static.pdf')
            contact_path = os.path.join(backend_dir, 'offer_contact_static.pdf')
            offer_pack_paths = [
                os.path.join(backend_dir, 'Offer Letter.pdf'),
                os.path.join(backend_dir, 'Offer_Letter.pdf'),
                os.path.join(backend_dir, 'offer_letter.pdf'),
                os.path.join(backend_dir, 'OfferLetter.pdf'),
            ]
            offer_pack_reader = None
            offer_pack_path_used = None
            for pp in offer_pack_paths:
                if os.path.exists(pp):
                    try:
                        offer_pack_reader = PdfReader(pp)
                        offer_pack_path_used = pp
                        break
                    except Exception:
                        offer_pack_reader = None

            # If we have a static Offer Letter.pdf, use pages 1 and 2 as-is (no additional pages)
            offer_pdf_bytes = BytesIO()
            if offer_pack_reader and offer_pack_path_used:
                offer_writer = PdfWriter()
                # Page 1 as-is
                if len(offer_pack_reader.pages) >= 1:
                    offer_writer.add_page(offer_pack_reader.pages[0])
                # Page 2 as-is
                if len(offer_pack_reader.pages) >= 2:
                    offer_writer.add_page(offer_pack_reader.pages[1])
                offer_writer.write(offer_pdf_bytes)
                offer_pdf_bytes.seek(0)
            else:
                # No static Offer Letter.pdf present -> fallback to mixed assemble
                offer_writer = PdfWriter()
                if len(offer_reader.pages) >= 1:
                    if os.path.exists(cover_path):
                        try:
                            cover_reader = PdfReader(cover_path)
                            for p in cover_reader.pages:
                                offer_writer.add_page(p)
                        except Exception:
                            offer_writer.add_page(offer_reader.pages[0])
                    else:
                        offer_writer.add_page(offer_reader.pages[0])
                if len(offer_reader.pages) >= 2:
                    offer_writer.add_page(offer_reader.pages[1])
                offer_writer.write(offer_pdf_bytes)
                offer_pdf_bytes.seek(0)

            # Build Policy (separate PDF): prefer static policy_static.pdf else generated
            policy_static_path = os.path.join(backend_dir, 'policy_static.pdf')
            policy_bytes = None
            if os.path.exists(policy_static_path):
                try:
                    policy_static_reader = PdfReader(policy_static_path)
                    policy_writer = PdfWriter()
                    for p in policy_static_reader.pages:
                        policy_writer.add_page(p)
                    _policy_bytes = BytesIO()
                    policy_writer.write(_policy_bytes)
                    _policy_bytes.seek(0)
                    policy_bytes = _policy_bytes.getvalue()
                except Exception:
                    policy_pdf.seek(0)
                    policy_bytes = policy_pdf.getvalue()
            else:
                policy_pdf.seek(0)
                policy_bytes = policy_pdf.getvalue()

            print("[POLICY LETTER] Offer and Policy PDFs prepared (separate)")

        except Exception as pdf_err:
            print(f"[POLICY LETTER ERROR] Failed to generate PDF: {pdf_err}")
            traceback.print_exc()
            return jsonify({'success': False, 'message': f'Failed to generate PDF: {str(pdf_err)}'}), 500

        # Prepare email
        subject = "Offer Letter & Policy Agreement - VTab Pvt. Ltd."
        print(f"[POLICY LETTER] Preparing to send email to {recipient}")
        # Template strings with placeholders (support both {key} and {{key}} styles)
        body_tpl = (
            "Dear {candidate_name},\n\n"
            "Congratulations! Your documents have been verified.\n\n"
            "You will be joining as {designation}.\n"
            "Your Date of Joining is {date_of_joining}.\n\n"
            "Please find attached:\n"
            "1. Your personalized Offer Letter\n"
            "2. Company Policy Agreement\n\n"
            "We look forward to welcoming you to VTab Pvt. Ltd.\n\n"
            "Regards,\nHR Team\nVTab Pvt. Ltd.\n"
        )
        html_tpl = (
            "<div style=\"font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;\">"
            "<h2 style=\"color: #2563eb;\">Welcome to VTab Pvt. Ltd.!</h2>"
            "<p>Dear <strong>{candidate_name}</strong>,</p>"
            "<p>Congratulations! Your documents have been verified.</p>"
            "<p>You will be joining as <strong>{designation}</strong>.</p>"
            "<p>Your <strong>Date of Joining</strong> is <strong style=\"color: #2563eb;\">{date_of_joining}</strong>.</p>"
            "<p>Please find attached:</p>"
            "<ul>"
            "<li>Your personalized <strong>Offer Letter</strong></li>"
            "<li>Company <strong>Policy Agreement</strong></li>"
            "</ul>"
            "<p>We look forward to welcoming you to VTab Pvt. Ltd.</p>"
            "<hr style=\"border: 1px solid #e5e7eb; margin: 20px 0;\">"
            "<p style=\"color: #6b7280;\">Regards,<br/><strong>HR Team</strong><br/>VTab Pvt. Ltd.</p>"
            "</div>"
        )

        # Simple placeholder rendering supporting {key} and {{key}}
        ctx = {
            'candidate_name': f"{firstname} {lastname}".strip(),
            'designation': designation or 'Employee',
            'date_of_joining': display_doj or doj or ''
        }
        def _render(s: str, m: dict) -> str:
            out = s
            for k, v in m.items():
                out = out.replace('{' + k + '}', str(v))
                out = out.replace('{{' + k + '}}', str(v))
            return out

        body = _render(body_tpl, ctx)
        html = _render(html_tpl, ctx)

        # Send email with PDF attachments (plain-text body only)
        print("[POLICY LETTER] Sending email with two PDF attachments (Offer, Policy)...")
        try:
            send_email(
                subject=subject,
                recipients=[recipient],
                body=body,
                attachments=[
                    ("Offer_Letter.pdf", offer_pdf_bytes.getvalue()),
                    ("Policy.pdf", policy_bytes),
                ]
            )
            print("[POLICY LETTER] Email sent successfully")
        except Exception as email_err:
            print(f"[POLICY LETTER ERROR] Failed to send email: {email_err}")
            traceback.print_exc()
            return jsonify({'success': False, 'message': 'Failed to send email'}), 500
        
        # Create progress log
        try:
            create_progress_log_row(token, record_id, "Policy Letter Sent", 4, _now_iso())
            print("[POLICY LETTER] Progress log created")
        except Exception as log_err:
            print(f"[POLICY LETTER WARN] Failed to create progress log: {log_err}")
        
        print("[POLICY LETTER] Request completed successfully (separate Offer & Policy attachments)")
        return jsonify({'success': True, 'message': 'Offer Letter and Policy sent as separate attachments (Offer: static p1+p3, generated p2).'}), 200
    except Exception as e:
        print(f"[ERROR] Error sending policy letter: {e}")
        traceback.print_exc()
        return jsonify({'success': False, 'message': str(e)}), 500

@app.route('/api/onboarding/<record_id>/policy-letter-upload', methods=['POST'])
def send_policy_letter_with_upload(record_id):
    """Send Policy/Offer email using user-uploaded files as attachments.
    Does not generate PDFs. Expects multipart/form-data with:
      - doj: optional Date of Joining
      - attachments: one or more files (PDFs preferred)
    """
    try:
        # Extract form values
        doj = request.form.get('doj')

        token = get_access_token()
        entity_set = get_onboarding_entity_set(token)

        # Fetch candidate record
        url = f"{BASE_URL}/{entity_set}({record_id})"
        response = requests.get(url, headers={"Authorization": f"Bearer {token}"})
        if response.status_code != 200:
            return jsonify({'success': False, 'message': 'Onboarding record not found'}), 404
        candidate = response.json()

        # Update DOJ if provided
        try:
            if doj:
                update_record(entity_set, record_id, {'crc6f_doj': doj})
        except Exception as upd_err:
            print(f"[WARN] Failed to update DOJ: {upd_err}")

        recipient = candidate.get('crc6f_email')
        firstname = candidate.get('crc6f_firstname', '')
        lastname = candidate.get('crc6f_lastname', '')
        designation = candidate.get('crc6f_designation', 'Employee')
        display_doj = doj or candidate.get('crc6f_doj', '')

        # Collect uploaded files. Accept 'attachments', 'files', or 'documents' keys for flexibility
        files = []
        for key in ['attachments', 'files', 'documents']:
            files.extend(request.files.getlist(key))
        if not files:
            return jsonify({'success': False, 'message': 'No files uploaded'}), 400

        # Prepare email body/html like the generator route
        subject = "Offer Letter & Policy Agreement - VTab Pvt. Ltd."
        body_tpl = (
            "Dear {candidate_name},\n\n"
            "Congratulations! Your documents have been verified.\n\n"
            "You will be joining as {designation}.\n"
            "Your Date of Joining is {date_of_joining}.\n\n"
            "Please find attached:\n"
            "1. Your personalized Offer Letter\n"
            "2. Company Policy Agreement\n\n"
            "We look forward to welcoming you to VTab Pvt. Ltd.\n\n"
            "Regards,\nHR Team\nVTab Pvt. Ltd.\n"
        )
        html_tpl = (
            "<div style=\"font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;\">"
            "<h2 style=\"color: #2563eb;\">Welcome to VTab Pvt. Ltd.!</h2>"
            "<p>Dear <strong>{candidate_name}</strong>,</p>"
            "<p>Congratulations! Your documents have been verified.</p>"
            "<p>You will be joining as <strong>{designation}</strong>.</p>"
            "<p>Your <strong>Date of Joining</strong> is <strong style=\"color: #2563eb;\">{date_of_joining}</strong>.</p>"
            "<p>Please find attached:</p>"
            "<ul>"
            "<li>Your personalized <strong>Offer Letter</strong></li>"
            "<li>Company <strong>Policy Agreement</strong></li>"
            "</ul>"
            "<p>We look forward to welcoming you to VTab Pvt. Ltd.</p>"
            "<hr style=\"border: 1px solid #e5e7eb; margin: 20px 0;\">"
            "<p style=\"color: #6b7280;\">Regards,<br/><strong>HR Team</strong><br/>VTab Pvt. Ltd.</p>"
            "</div>"
        )
        ctx = {
            'candidate_name': f"{firstname} {lastname}".strip(),
            'designation': designation or 'Employee',
            'date_of_joining': display_doj or ''
        }
        def _render(s: str, m: dict) -> str:
            out = s
            for k, v in m.items():
                out = out.replace('{' + k + '}', str(v))
                out = out.replace('{{' + k + '}}', str(v))
            return out
        body = _render(body_tpl, ctx)
        html = _render(html_tpl, ctx)

        # Build attachments list [(filename, bytes), ...]
        atts = []
        for f in files:
            try:
                content = f.read()
                if content:
                    atts.append((f.filename or 'Attachment.pdf', content))
            except Exception as fe:
                print(f"[WARN] Failed reading uploaded file {getattr(f,'filename',None)}: {fe}")

        if not atts:
            return jsonify({'success': False, 'message': 'Uploaded files are empty'}), 400

        if not recipient:
            return jsonify({'success': False, 'message': 'Candidate email not found'}), 400

        # Send email with uploaded attachments (plain-text body only)
        print("[POLICY LETTER UPLOAD] Sending email with user-uploaded attachments ...")
        ok = send_email(
            subject=subject,
            recipients=[recipient],
            body=body,
            attachments=atts
        )
        if not ok:
            return jsonify({'success': False, 'message': 'Failed to send email'}), 500

        # Log progress
        try:
            create_progress_log_row(token, record_id, "Policy Letter Sent (Uploaded)", 4, _now_iso())
        except Exception as log_err:
            print(f"[POLICY LETTER UPLOAD WARN] Failed to create progress log: {log_err}")

        return jsonify({'success': True, 'message': 'Email sent with uploaded attachments'}), 200
    except Exception as e:
        print(f"[ERROR] Policy letter upload send failed: {e}")
        traceback.print_exc()
        return jsonify({'success': False, 'message': str(e)}), 500
# Deprecated: Old onboarding mail endpoint (Stage 5) - kept for compatibility
@app.route('/api/onboarding/<record_id>/onboarding-mail', methods=['POST'])
def send_onboarding_mail(record_id):
    try:
        data = request.get_json() or {}
        doj = data.get('doj')

        token = get_access_token()
        entity_set = get_onboarding_entity_set(token)

        # Fetch candidate details
        url = f"{BASE_URL}/{entity_set}({record_id})"
        response = requests.get(url, headers={"Authorization": f"Bearer {token}"})
        if response.status_code != 200:
            return jsonify({'success': False, 'message': 'Onboarding record not found'}), 404
        candidate = response.json()

        recipient = candidate.get('crc6f_email')
        firstname = candidate.get('crc6f_firstname', '')
        lastname = candidate.get('crc6f_lastname', '')

        # Update DOJ if provided
        try:
            if doj:
                update_record(entity_set, record_id, {'crc6f_doj': doj})
        except Exception as upd_err:
            print(f"[WARN] Failed to update DOJ: {upd_err}")

        subject = "Welcome to VTab Pvt. Ltd. - Onboarding Details"
        body = f"""
Dear {firstname} {lastname},

Welcome to VTab Pvt. Ltd. Your Date of Joining is {doj}.
Please find the onboarding details shared by the HR team.

Regards,
HR Team
VTab Pvt. Ltd.
"""
        send_email(subject=subject, recipients=[recipient], body=body)
        try:
            create_progress_log_row(token, record_id, "Onboarding", 5, _now_iso())
        except Exception:
            pass
        return jsonify({'success': True, 'message': 'Onboarding email sent'}), 200
    except Exception as e:
        print(f"[ERROR] Error sending onboarding mail: {e}")
        traceback.print_exc()
        return jsonify({'success': False, 'message': str(e)}), 500

@app.route('/api/onboarding/<record_id>/verify', methods=['PUT'])
def verify_documents_and_complete(record_id):
    """Verify documents and complete onboarding (Stage 4 -> 5)"""
    try:
        token = get_access_token()
        onboarding_entity = get_onboarding_entity_set(token)
        employee_entity = get_employee_entity_set(token)

        # 1) Fetch onboarding record
        url = f"{BASE_URL}/{onboarding_entity}({record_id})"
        response = requests.get(url, headers={"Authorization": f"Bearer {token}"})
        if response.status_code != 200:
            return jsonify({'success': False, 'message': 'Onboarding record not found'}), 404
        onboarding_record = response.json()

        # 2) Build employee creation payload with NO employee_id (so bulk logic auto-generates)
        first_name = onboarding_record.get('crc6f_firstname', '')
        last_name = onboarding_record.get('crc6f_lastname', '')
        email = onboarding_record.get('crc6f_email', '')
        designation = onboarding_record.get('crc6f_designation', '')
        department = onboarding_record.get('crc6f_department')
        address = onboarding_record.get('crc6f_address')
        contact_number = onboarding_record.get('crc6f_contactno')
        doj = onboarding_record.get('crc6f_doj')
        employee_id = onboarding_record.get('crc6f_onboardingid')

        employee_create_payload = {
            "first_name": first_name,
            "last_name": last_name,
            "email": email,
            "designation": designation,
            "department": department,
            "address": address,
            "contact_number": contact_number,
            "active": True,
            # Flag all onboarding-created employees as Intern so they
            # automatically participate in the Interns view filtering.
            "employee_flag": "Intern",
        }
        if doj:
            employee_create_payload["doj"] = doj

        # 2.1) Validate required fields before creating employee
        required = {
            'first_name': first_name,
            'last_name': last_name,
            'email': email,
            'contact_number': contact_number,
            'address': address,
            'department': department,
            'designation': designation
        }
        missing = [k for k, v in required.items() if not str(v or '').strip()]
        if missing:
            return jsonify({
                'success': False,
                'message': f"Missing required fields: {', '.join(missing)}",
                'details': {'missing': missing}
            }), 400

        # Auto-generate employee ID if Dataverse would otherwise leave it blank
        auto_employee_id = None
        if not employee_id:
            auto_employee_id = generate_employee_id()
            employee_create_payload["employee_id"] = auto_employee_id

        # 3) Call existing employee creation API to reuse exact logic
        try:
            internal_url = "http://localhost:5000/api/employees"
            emp_resp = requests.post(internal_url, json=employee_create_payload, timeout=20)
        except Exception as call_err:
            print(f"[ERROR] Error calling employee creation API: {call_err}")
            return jsonify({'success': False, 'message': 'Failed to create employee record'}), 500

        employee_already_exists = False
        if emp_resp.status_code not in [200, 201]:
            print(f"[ERROR] Employee creation failed: {emp_resp.status_code} | {emp_resp.text}")
            # Treat duplicate employee gracefully so onboarding can proceed
            err_json = {}
            try:
                err_json = emp_resp.json()
            except Exception:
                err_json = { 'error': emp_resp.text }

            err_message = (err_json.get('error') or err_json.get('message') or '').lower()
            if emp_resp.status_code == 400 and 'already exists' in err_message:
                employee_already_exists = True
                print("[INFO] Employee already exists; proceeding with onboarding completion.")
            else:
                status = emp_resp.status_code if 400 <= emp_resp.status_code < 500 else 500
                return jsonify({
                    'success': False,
                    'message': err_json.get('error') or 'Failed to create employee record',
                    'details': err_json
                }), status

        # 4) Query Dataverse to retrieve the generated Employee ID by email (best effort)
        employee_id = None
        try:
            headers_check = {
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "OData-MaxVersion": "4.0",
                "OData-Version": "4.0"
            }
            field_map = get_field_map(employee_entity)
            id_field = field_map.get('id') or 'crc6f_employeeid'
            safe_email = (email or '').strip().replace("'", "''")
            find_emp_url = f"{BASE_URL}/{employee_entity}?$top=1&$select={id_field}&$filter=crc6f_email eq '{safe_email}'"
            emp_find = requests.get(find_emp_url, headers=headers_check, timeout=20)
            if emp_find.status_code == 200:
                vals = emp_find.json().get('value', [])
                if vals:
                    employee_id = vals[0].get(id_field)
        except Exception as lookup_err:
            print(f"[WARN] Could not resolve employee_id from Dataverse: {lookup_err}")
        if not employee_id and auto_employee_id:
            employee_id = auto_employee_id

        # 4.5) Ensure an intern details record exists for this employee so the
        # Interns view can display them. We use the same INT-<EMPID> pattern
        # as the debug_create_test_intern helper.
        try:
            if employee_id:
                intern_id = f"INT-{employee_id}"
                existing_intern = _fetch_intern_record_by_id(token, intern_id, include_system=True)
                if not existing_intern:
                    intern_payload = {
                        INTERN_FIELDS["intern_id"]: intern_id,
                        INTERN_FIELDS["employee_id"]: employee_id,
                    }
                    create_record(INTERN_ENTITY, intern_payload)
        except Exception as intern_err:
            print(f"[WARN] Failed to ensure intern record for {employee_id}: {intern_err}")

        # 5) Update onboarding record status and optionally set onboardingid if we resolved it
        # After onboarding, mark the record as Completed (green) and documents as Verified
        onboarding_payload = {
            'crc6f_documentsstatus': 'Verified',
            'crc6f_progresssteps': 'Completed',
            'crc6f_convertedtoemployee': True,
        }
        if employee_id:
            onboarding_payload['crc6f_onboardingid'] = employee_id
        try:
            update_record(onboarding_entity, record_id, onboarding_payload)
        except Exception as upd_err:
            print(f"[WARN] Failed to update onboarding record after conversion: {upd_err}")

        try:
            create_progress_log_row(token, record_id, "Onboarding", 4, _now_iso())
            create_progress_log_row(token, record_id, "Completed", 5, _now_iso())
        except Exception:
            pass

        response_message = 'Verification successful! Employee created successfully.'
        if employee_already_exists:
            response_message = 'Already exist'

        return jsonify({
            'success': True,
            'message': response_message,
            'employee_id': employee_id,
            'already_exists': employee_already_exists
        }), 200
    except Exception as e:
        print(f"[ERROR] Error completing onboarding: {e}")
        traceback.print_exc()
        return jsonify({'success': False, 'message': str(e)}), 500

@app.route('/api/onboarding/<record_id>/documents', methods=['POST'])
def upload_onboarding_documents(record_id):
    """Upload files to Dataverse File column (crc6f_documentsuploaded)"""
    try:
        token = get_access_token()
        onboarding_entity = get_onboarding_entity_set(token)

        files = request.files.getlist('documents')
        if not files:
            return jsonify({'success': False, 'message': 'No files provided'}), 400

        uploaded_files = []
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0"
        }

        for f in files:
            if not f or not getattr(f, 'filename', ''):
                continue
            name = f.filename
            ext = os.path.splitext(name)[1].lower()
            if ext not in ['.pdf', '.jpg', '.jpeg', '.png']:
                continue

            try:
                # Read file content
                file_content = f.read()
                
                # Upload to Dataverse File column using PATCH with file data
                # Reference: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/file-column-data
                file_upload_url = f"{BASE_URL}/{onboarding_entity}({record_id})/crc6f_documentsuploaded"
                
                file_headers = headers.copy()
                file_headers["Content-Type"] = "application/octet-stream"
                file_headers["x-ms-file-name"] = name
                
                # Try upload without If-Match first (for new uploads)
                upload_resp = requests.patch(file_upload_url, headers=file_headers, data=file_content)
                
                # If it fails with 412 Precondition Failed, retry with If-Match: * (for re-upload)
                if upload_resp.status_code == 412:
                    print(f"[INFO] File exists, retrying with If-Match for {name}")
                    file_headers["If-Match"] = "*"
                    upload_resp = requests.patch(file_upload_url, headers=file_headers, data=file_content)
                
                if upload_resp.status_code in [200, 204]:
                    uploaded_files.append(name)
                    print(f"[OK] Uploaded file to Dataverse: {name}")
                else:
                    print(f"[WARN] Failed to upload {name}: {upload_resp.status_code} - {upload_resp.text}")
                    
            except Exception as file_err:
                print(f"[ERROR] Error uploading file {name}: {file_err}")
                continue

        if not uploaded_files:
            return jsonify({'success': False, 'message': 'No files were successfully uploaded to Dataverse'}), 400

        # Update document status and progress (if candidate already accepted offer)
        mail_reply_value = ''
        try:
            detail_headers = {
                "Authorization": f"Bearer {token}",
                "Accept": "application/json"
            }
            detail_url = f"{BASE_URL}/{onboarding_entity}({record_id})?$select=crc6f_offerpmailreply"
            detail_resp = requests.get(detail_url, headers=detail_headers, timeout=20)
            if detail_resp.status_code == 200:
                detail_json = detail_resp.json()
                mail_reply_value = (detail_json.get('crc6f_offerpmailreply') or '').strip().lower()
        except Exception as fetch_err:
            print(f"[WARN] Could not read onboarding record before updating progress: {fetch_err}")

        try:
            update_payload = {
                'crc6f_documentsstatus': 'Pending'
            }
            moved_to_stage4 = False
            if mail_reply_value == 'yes':
                update_payload['crc6f_progresssteps'] = 'Onboarding'
                moved_to_stage4 = True

            update_record(onboarding_entity, record_id, update_payload)

            if moved_to_stage4:
                try:
                    create_progress_log_row(token, record_id, "Onboarding", 4, _now_iso())
                except Exception:
                    pass
        except Exception as status_err:
            print(f"[WARN] Could not update document status/progress: {status_err}")

        return jsonify({
            'success': True, 
            'uploaded': uploaded_files,
            'message': f'Successfully uploaded {len(uploaded_files)} file(s) to Dataverse'
        }), 200
        
    except Exception as e:
        print(f"[ERROR] Error uploading documents: {e}")
        traceback.print_exc()
        return jsonify({'success': False, 'message': str(e)}), 500

@app.route('/api/onboarding/<record_id>/documents', methods=['DELETE'])
def delete_onboarding_documents(record_id):
    try:
        token = get_access_token()
        onboarding_entity = get_onboarding_entity_set(token)

        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0",
        }

        # Try to retrieve file metadata so we can use the DeleteFile action with FileId
        file_id = None
        try:
            detail_headers = {
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
            }
            detail_url = f"{BASE_URL}/{onboarding_entity}({record_id})?$select=crc6f_documentsuploaded"
            detail_resp = requests.get(detail_url, headers=detail_headers, timeout=20)
            if detail_resp.status_code == 200:
                record = detail_resp.json()
                meta = record.get("crc6f_documentsuploaded")
                if isinstance(meta, dict):
                    file_id = meta.get("fileId") or meta.get("fileid") or meta.get("FileId")
                elif isinstance(meta, str):
                    file_id = meta
        except Exception as meta_err:
            print(f"[WARN] Could not read file metadata before delete: {meta_err}")

        if file_id:
            # Recommended approach: use DeleteFile action with the FileId
            delete_action_url = f"{BASE_URL}/DeleteFile"
            action_headers = headers.copy()
            action_headers["Content-Type"] = "application/json"
            resp = requests.post(delete_action_url, headers=action_headers, json={"FileId": file_id})
        else:
            # Fallback: delete the file column directly using DELETE on the property
            delete_headers = headers.copy()
            delete_headers["If-None-Match"] = "null"
            delete_url = f"{BASE_URL}/{onboarding_entity}({record_id})/crc6f_documentsuploaded"
            resp = requests.delete(delete_url, headers=delete_headers)

        if resp.status_code not in (200, 204):
            try:
                err_json = resp.json()
                err_msg = (err_json.get('error') or {}).get('message') or resp.text
            except Exception:
                err_msg = resp.text
            print(f"[WARN] Failed to delete documents file column: {resp.status_code} - {err_msg}")
            return jsonify({'success': False, 'message': f'Failed to delete documents: {err_msg}'}), resp.status_code

        try:
            update_record(onboarding_entity, record_id, {'crc6f_documentsstatus': 'Pending'})
        except Exception as upd_err:
            print(f"[WARN] Could not reset documents status after delete: {upd_err}")

        return jsonify({'success': True, 'message': 'Documents deleted successfully'}), 200
    except Exception as e:
        print(f"[ERROR] Error deleting onboarding documents: {e}")
        traceback.print_exc()
        return jsonify({'success': False, 'message': str(e)}), 500

# ==================== PROGRESS LOG READ API ====================
@app.route('/api/onboarding/<record_id>/progress-log', methods=['GET'])
def get_onboarding_progress_log(record_id):
    """Return audit log rows for an onboarding record, newest first."""
    try:
        token = get_access_token()
        entity_set = get_progress_log_entity_set(token)
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        safe_id = str(record_id).replace("'", "''")
        url = (
            f"{BASE_URL}/{entity_set}?$select="
            f"crc6f_hr_onboardingprogresslogid,crc6f_onboardingid,crc6f_progresssteps,crc6f_refid,crc6f_timestamps,createdby"
            f"&$filter=crc6f_onboardingid eq '{safe_id}'&$orderby=crc6f_timestamps desc"
        )
        resp = requests.get(url, headers=headers, timeout=20)
        if resp.status_code != 200:
            return jsonify({"success": False, "message": "Failed to fetch progress log"}), 500
        rows = resp.json().get("value", [])
        # Normalize fields for frontend
        logs = []
        for r in rows:
            logs.append({
                "id": r.get("crc6f_hr_onboardingprogresslogid"),
                "onboarding_id": r.get("crc6f_onboardingid"),
                "stage_name": r.get("crc6f_progresssteps"),
                "stage_number": r.get("crc6f_refid"),
                "timestamp": r.get("crc6f_timestamps"),
                "created_by": r.get("createdby"),
            })
        return jsonify({"success": True, "logs": logs}), 200
    except Exception as e:
        print(f"[ERROR] Error reading onboarding progress log: {e}")
        traceback.print_exc()
        return jsonify({"success": False, "message": str(e)}), 500


@app.route('/google/authorize', methods=['GET'])
def google_authorize():
    """
    Initiates Google OAuth flow.
    - Uses 'consent' prompt only if force=true query param is passed
    - Otherwise, uses 'select_account' which won't force re-consent if already authorized
    """
    try:
        if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
            return jsonify({"success": False, "error": "Google OAuth not configured"}), 500
        
        # Check if we should force re-consent (useful for getting new refresh token)
        force_consent = request.args.get("force", "").lower() == "true"
        
        flow = _build_google_oauth_flow()
        authorization_url, state = flow.authorization_url(
            access_type="offline",
            include_granted_scopes="true",
            # Only force consent if explicitly requested, otherwise just select account
            prompt="consent" if force_consent else "select_account",
        )
        return redirect(authorization_url)
    except Exception as e:
        print(f"[ERROR] Google authorize failed: {e}")
        traceback.print_exc()
        return jsonify({"success": False, "error": "Google authorization failed"}), 500


@app.route('/google/oauth2callback', methods=['GET'])
def google_oauth2callback():
    try:
        if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
            return jsonify({"success": False, "error": "Google OAuth not configured"}), 500
        state = request.args.get("state")
        flow = _build_google_oauth_flow(state=state)
        flow.fetch_token(authorization_response=request.url)
        creds = flow.credentials
        _save_google_credentials(creds)
        return jsonify({"success": True}), 200
    except Exception as e:
        print(f"[ERROR] Google OAuth callback failed: {e}")
        traceback.print_exc()
        return jsonify({"success": False, "error": "Google OAuth callback failed"}), 500


@app.route('/api/meet/start', methods=['POST'])
def start_google_meet():
    try:
        data = request.get_json(force=True) or {}
        print("[MEET] Incoming payload:", data)
        title = (data.get("title") or "Meeting").strip()
        description = data.get("description") or ""
        audience_type = (data.get("audience_type") or "employees").strip().lower()
        employee_ids = data.get("employee_ids") or []
        employee_emails = data.get("employee_emails") or []
        project_id = data.get("project_id") or None
        start_time = data.get("start_time")
        end_time = data.get("end_time")
        timezone_str = data.get("timezone") or "UTC"

        admin_id = (data.get("admin_id") or "").strip() or "admin"

        if audience_type not in ["employees", "project", "custom"]:
            audience_type = "employees"

        token = get_access_token()

        if audience_type in ["project", "custom"] and project_id:
            project_emp_ids = _get_project_member_employee_ids(token, project_id)
            if project_emp_ids:
                employee_ids = list(set(employee_ids) | set(project_emp_ids))

        print(f"[MEET] Resolved audience_type={audience_type}, employee_ids={employee_ids}, project_id={project_id}")

        emails = set()
        participants_for_socket = []
        for e in employee_emails or []:
            e_str = (e or "").strip()
            if e_str:
                emails.add(e_str)
                participants_for_socket.append({
                    "employee_id": None,
                    "email": e_str,
                })

        for emp_id in employee_ids or []:
            emp_str = str(emp_id).strip()
            if not emp_str:
                continue
            print(f"[MEET] Resolving email for employee_id={emp_str}")
            emp_email = get_employee_email(emp_str)
            if isinstance(emp_email, tuple):
                emp_email = emp_email[0]
            print(f"[MEET] get_employee_email => {emp_email}")
            if emp_email:
                emails.add(emp_email)
                participants_for_socket.append({
                    "employee_id": emp_str,
                    "email": emp_email,
                })

        if not emails:
            print("[MEET] No participant emails resolved for:", {"employee_ids": employee_ids, "employee_emails": employee_emails, "project_id": project_id})
            return jsonify({"success": False, "error": "No participant emails resolved"}), 400

        if start_time:
            start_body = {"dateTime": start_time, "timeZone": timezone_str}
        else:
            now_utc = datetime.utcnow().replace(microsecond=0)
            start_body = {"dateTime": now_utc.isoformat() + "Z", "timeZone": timezone_str}

        if end_time:
            end_body = {"dateTime": end_time, "timeZone": timezone_str}
        else:
            end_dt_utc = datetime.utcnow().replace(microsecond=0) + timedelta(minutes=30)
            end_body = {"dateTime": end_dt_utc.isoformat() + "Z", "timeZone": timezone_str}

        service = get_google_calendar_service()

        event_body = {
            "summary": title or "Meeting",
            "description": description,
            "start": start_body,
            "end": end_body,
            "attendees": [{"email": e} for e in sorted(emails)],
            "conferenceData": {
                "createRequest": {
                    "requestId": "vtab-" + uuid.uuid4().hex
                }
            },
        }

        event = service.events().insert(
            calendarId="primary",
            body=event_body,
            conferenceDataVersion=1,
            sendUpdates="all",
        ).execute()

        meet_url = event.get("hangoutLink")
        if not meet_url:
            conf = event.get("conferenceData") or {}
            entry_points = conf.get("entryPoints") or []
            for ep in entry_points:
                if ep.get("entryPointType") == "video" and ep.get("uri"):
                    meet_url = ep["uri"]
                    break

        response_payload = {
            "success": True,
            "event_id": event.get("id"),
            "html_link": event.get("htmlLink"),
            "meet_url": meet_url,
            "title": event.get("summary"),
            "status": event.get("status"),
            "attendees": [a.get("email") for a in event.get("attendees", [])],
            "start": event.get("start"),
            "end": event.get("end"),
        }

        if project_id:
            response_payload["project_id"] = project_id

        try:
            if meet_url:
                call_id = notify_socket_server(admin_id, meet_url, participants_for_socket, title)
                if call_id:
                    response_payload["call_id"] = call_id
        except Exception as notify_err:
            print(f"[MEET][SOCKET] notify_socket_server failed: {notify_err}")

        return jsonify(response_payload), 200
    except Exception as e:
        print(f"[ERROR] Failed to create Google Meet: {e}")
        traceback.print_exc()
        return jsonify({"success": False, "error": "Failed to create Google Meet"}), 500

# -----------------------------------------
# [TIME] Comp Off Module API
# -----------------------------------------
@app.route('/api/comp-off', methods=['GET'])
def get_comp_off():
    try:
        # 1️⃣ Fetch employee basic info
        employee_url = f"{BASE_URL}/crc6f_table12s"
        token = get_access_token()
        employee_response = requests.get(
            employee_url,
            headers={"Authorization": f"Bearer {token}"}
        )
        employees = employee_response.json().get('value', [])

        # 2️⃣ Fetch comp off details
        compoff_url = f"{BASE_URL}/crc6f_hr_leavemangements"
        compoff_response = requests.get(
            compoff_url,
            headers={"Authorization": f"Bearer {token}"}
        )
        compoffs = compoff_response.json().get('value', [])

        # Build quick lookups
        leave_map = { (c.get("crc6f_employeeid") or "").upper(): c for c in compoffs }
        normalized_requests = []
        try:
            comp_req_url = f"{BASE_URL}/crc6f_compensatoryrequests"
            comp_req_resp = requests.get(comp_req_url, headers={"Authorization": f"Bearer {token}"})
            if comp_req_resp.status_code == 200:
                normalized_requests = [{
                    "employee_id": (r.get("crc6f_employeeid") or "").upper(),
                    "status": (r.get("crc6f_status") or "").strip().lower(),
                    "days": float(r.get("crc6f_totaldays") or 0)
                } for r in comp_req_resp.json().get("value", [])]
        except Exception as pending_err:
            print(f"[WARN] Failed to load comp-off requests: {pending_err}")

        pending_by_emp = {}
        for req in normalized_requests:
            emp_key = req["employee_id"]
            if not emp_key:
                continue
            if req["status"] == "pending" and req["days"] > 0:
                pending_by_emp.setdefault(emp_key, 0.0)
                pending_by_emp[emp_key] += req["days"]

        # 3️⃣ Merge both datasets
        result = []
        for emp in employees:
            emp_id = emp.get("crc6f_employeeid")
            first_name = emp.get("crc6f_firstname", "")
            last_name = emp.get("crc6f_lastname", "")
            full_name = f"{first_name} {last_name}".strip()

            # find comp off record for this employee
            emp_key = (emp_id or "").upper()
            emp_compoff = leave_map.get(emp_key)
            raw_balance = float(emp_compoff.get("crc6f_compoff", 0) or 0) if emp_compoff else 0
            pending_days = pending_by_emp.get(emp_key, 0.0)
            available_compoff = max(0.0, raw_balance - pending_days)

            result.append({
                "employee_id": emp_id,
                "employee_name": full_name,
                "available_compoff": available_compoff,
                "pending_compoff": pending_days,
                "raw_compoff": raw_balance
            })

        return jsonify({"status": "success", "data": result}), 200

    except Exception as e:
        print("[ERROR] Error in fetching comp off data:", e)
        return jsonify({"status": "error", "message": str(e)}), 500
@app.route("/api/comp-off/<employee_id>", methods=["PUT"])
def update_comp_off(employee_id):
    try:
        data = request.get_json()
        new_balance = data.get("available_compoff")

        if new_balance is None:
            return jsonify({"status": "error", "message": "Missing available_compoff field"}), 400

        # [OK] 1. Get the record ID of the employee in Dataverse
        get_url = f"{BASE_URL}/crc6f_hr_leavemangements?$filter=crc6f_employeeid eq '{employee_id}'"
        # Convert to string for Dataverse
        update_data = {"crc6f_compoff": str(new_balance)}
        token = get_access_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }

        get_response = requests.get(get_url, headers=headers)
        get_response.raise_for_status()
        records = get_response.json().get("value", [])

        if not records:
            return jsonify({"status": "error", "message": "Employee not found in Dataverse"}), 404

        record_id = records[0]["crc6f_hr_leavemangementid"]

        # [OK] 2. Update the comp off field in Dataverse
        update_url = f"{BASE_URL}/crc6f_hr_leavemangements({record_id})"
        update_data = {"crc6f_compoff": str(new_balance)}

        patch_response = requests.patch(update_url, headers=headers, json=update_data)
        if patch_response.status_code in [204, 200]:
            return jsonify({"status": "success", "message": "Comp Off balance updated successfully."})
        else:
            return jsonify({
                "status": "error",
                "message": f"Failed to update Dataverse: {patch_response.text}"
            }), patch_response.status_code

    except Exception as e:
        print("[ERROR] Error updating Comp Off:", e)
        return jsonify({"status": "error", "message": str(e)}), 500


# ================== AI ASSISTANT ==================
from ai_gemini import ask_gemini
from ai_dataverse_service import build_ai_context
from ai_automation import process_automation, execute_automation_action

@app.route("/api/ai/query", methods=["POST"])
def ai_query():
    """
    AI Assistant endpoint - answers questions using Gemini + Dataverse data.
    Also handles automation flows (e.g., create employee via chat).
    
    Request body:
        - question: str (required)
        - scope: str (optional) - 'general', 'attendance', 'leave', 'employee', etc.
        - history: list (optional) - previous chat messages
        - currentUser: dict (optional) - user info
        - automationState: dict (optional) - state for multi-step automation flows
    """
    try:
        data = request.get_json(force=True)
        question = data.get("question", "").strip()
        
        if not question:
            return jsonify({
                "success": False,
                "error": "Question is required"
            }), 400
        
        # Extract user info
        current_user = data.get("currentUser", {})
        user_meta = {
            "name": current_user.get("name", "User"),
            "email": current_user.get("email", ""),
            "employee_id": current_user.get("employee_id") or current_user.get("id", ""),
            "designation": current_user.get("designation", ""),
            "is_admin": current_user.get("is_admin", False),
        }
        
        # Get automation state from request (for multi-step flows)
        automation_state = data.get("automationState", None)
        
        # Check for automation flow first (pass user info for check-in/out, leave, and task flows)
        user_employee_id = user_meta.get("employee_id", "")
        user_employee_name = user_meta.get("name", "")
        user_employee_email = user_meta.get("email", "")
        automation_result = process_automation(question, automation_state, user_employee_id, user_employee_name, user_employee_email)
        
        # If there's an active automation flow OR this triggers a new one, handle it
        # This ensures we NEVER fall back to Gemini during a multi-step automation
        has_active_flow = (
            automation_state and 
            automation_state.get("active_flow") is not None
        )
        
        # For leave_application flow, inject the logged-in user's employee_id
        if automation_result.get("is_automation"):
            result_state = automation_result.get("state", {})
            if result_state.get("active_flow") == "leave_application":
                # Inject employee_id from logged-in user if not already set
                collected_data = result_state.get("collected_data", {})
                if not collected_data.get("employee_id") and user_meta.get("employee_id"):
                    collected_data["employee_id"] = user_meta.get("employee_id")
                    result_state["collected_data"] = collected_data
                    automation_result["state"] = result_state
        
        if automation_result.get("is_automation") or has_active_flow:
            response_data = {
                "success": True,
                "answer": automation_result.get("response"),
                "automationState": automation_result.get("state"),
                "isAutomation": True
            }
            
            # If there's an action to execute (e.g., create employee, search employee)
            action = automation_result.get("action")
            if action:
                token = get_access_token()
                action_result = execute_automation_action(action, token)
                
                if action_result.get("success"):
                    # Special handling for search_employee - update state with found employee
                    if action.get("type") == "search_employee" and action_result.get("employee"):
                        # Update the automation state with the found employee
                        current_state = response_data.get("automationState", {})
                        current_state["edit_target"] = action_result.get("employee")
                        response_data["automationState"] = current_state
                        
                        # Build the edit menu response
                        from ai_automation import _build_edit_menu
                        menu = _build_edit_menu(action_result.get("employee"))
                        response_data["answer"] = f"✅ {action_result.get('message')}\n\n{menu}"
                    # Special handling for search_employee_for_delete - update state and show delete confirmation
                    elif action.get("type") == "search_employee_for_delete" and action_result.get("employee"):
                        current_state = response_data.get("automationState", {})
                        current_state["edit_target"] = action_result.get("employee")
                        response_data["automationState"] = current_state
                        
                        # Build the delete confirmation response
                        emp = action_result.get("employee")
                        emp_id = emp.get("employee_id", "Unknown")
                        name = f"{emp.get('first_name', '')} {emp.get('last_name', '')}".strip()
                        email = emp.get("email", "N/A")
                        designation = emp.get("designation", "N/A")
                        confirm_text = f"DELETE {emp_id}"
                        
                        # Update state for confirmation
                        current_state["collected_data"] = current_state.get("collected_data", {})
                        current_state["collected_data"]["confirm_text"] = confirm_text
                        current_state["awaiting_confirmation"] = True
                        response_data["automationState"] = current_state
                        
                        response_data["answer"] = f"""⚠️ **WARNING: You are about to delete this employee:**

• **Employee ID:** {emp_id}
• **Name:** {name}
• **Email:** {email}
• **Designation:** {designation}

**This action is permanent and cannot be undone.**

To confirm, type exactly: **{confirm_text}**

Or type **'cancel'** to abort."""
                    # Special handling for fetch_my_tasks - show task list and update state
                    elif action.get("type") == "fetch_my_tasks" and action_result.get("tasks"):
                        tasks = action_result.get("tasks", [])
                        current_state = response_data.get("automationState", {})
                        current_state["collected_data"] = current_state.get("collected_data", {})
                        current_state["collected_data"]["tasks"] = tasks
                        current_state["current_step"] = 1  # Move to task selection step
                        response_data["automationState"] = current_state
                        
                        if not tasks:
                            response_data["answer"] = "❌ You don't have any tasks assigned. Please check with your manager."
                            current_state["active_flow"] = None
                        else:
                            # Build numbered task list
                            task_lines = []
                            for i, task in enumerate(tasks, 1):
                                name = task.get("task_name", "Unnamed Task")
                                task_id = task.get("task_id", "")
                                status = task.get("task_status", "")
                                project = task.get("project_id", "")
                                task_lines.append(f"**{i}.** {name} ({task_id}) - {status}")
                            
                            task_list = "\n".join(task_lines)
                            response_data["answer"] = f"""📋 **Your Tasks:**

{task_list}

**Please enter the number of the task you want to start** (e.g., type `1` to start the first task).

Or type **'cancel'** to abort."""
                    elif action.get("type") == "chat_search_employee" and action_result.get("employee"):
                        employee = action_result.get("employee", {})
                        employee_name = employee.get("name") or employee.get("first_name") or "the employee"
                        
                        current_state = response_data.get("automationState", {}) or {}
                        current_state["active_flow"] = "chat_send_message"  # Set active flow
                        collected_data = current_state.get("collected_data", {})
                        collected_data["target_employee_id"] = employee.get("employee_id")
                        collected_data["target_name"] = employee_name
                        current_state["collected_data"] = collected_data
                        current_state["current_step"] = 1  # Next step: ask for message content
                        response_data["automationState"] = current_state
                        
                        suggestions = action_result.get("all_matches", [])
                        if suggestions:
                            matches_preview = "\n".join(
                                [f"• {match.get('name')} ({match.get('employee_id')})" for match in suggestions[:3]]
                            )
                            response_data["answer"] = f"""✅ Found **{employee_name}**.

**Who to message:**\n{matches_preview}

What would you like to say to {employee_name}?"""
                        else:
                            response_data["answer"] = f"✅ Found **{employee_name}**. What would you like to say to them?"
                    # Special handling for start_task_timer - return action info to frontend
                    elif action.get("type") == "start_task_timer":
                        response_data["answer"] = f"▶️ {action_result.get('message', 'Timer started!')}"
                        response_data["actionResult"] = action_result
                        response_data["taskAction"] = "start_timer"
                    # Special handling for stop_task_timer - return action info to frontend
                    elif action.get("type") == "stop_task_timer":
                        response_data["answer"] = f"⏹️ {action_result.get('message', 'Timer stopped!')}"
                        response_data["actionResult"] = action_result
                        response_data["taskAction"] = "stop_timer"
                    else:
                        # Normal success - append message
                        response_data["answer"] += f"\n\n🎉 {action_result.get('message')}"
                    response_data["actionResult"] = action_result
                else:
                    response_data["answer"] += f"\n\n❌ Error: {action_result.get('error')}"
                    response_data["actionError"] = action_result.get("error")
            
            return jsonify(response_data)
        
        # Not an automation - proceed with normal AI query
        # Determine scope from question keywords
        scope = data.get("scope", "general")
        question_lower = question.lower()
        
        if any(kw in question_lower for kw in ["attendance", "check-in", "checkin", "check-out", "checkout", "hours", "time"]):
            scope = "attendance"
        elif any(kw in question_lower for kw in ["leave", "vacation", "sick", "holiday", "pto", "time off"]):
            scope = "leave"
        elif any(kw in question_lower for kw in ["employee", "staff", "team", "people", "department"]):
            scope = "employee"
        elif any(kw in question_lower for kw in ["asset", "laptop", "equipment", "device"]):
            scope = "assets"
        elif any(kw in question_lower for kw in ["project", "client"]):
            scope = "projects"
        elif any(kw in question_lower for kw in ["intern", "trainee"]):
            scope = "interns"
        
        # Get Dataverse token and build context
        token = get_access_token()
        data_context = build_ai_context(token, user_meta, scope)
        
        # Get chat history
        history = data.get("history", [])
        
        # Call Gemini model
        result = ask_gemini(
            question=question,
            data_context=data_context,
            user_meta=user_meta,
            history=history
        )
        
        if result.get("success"):
            return jsonify({
                "success": True,
                "answer": result.get("answer"),
                "scope": scope,
                "timestamp": data_context.get("timestamp"),
                "automationState": automation_result.get("state")  # Preserve state
            })
        else:
            return jsonify({
                "success": False,
                "error": result.get("error", "Failed to get AI response")
            }), 500
            
    except Exception as e:
        print(f"[AI] Error in ai_query: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500

@app.route("/api/ai/health", methods=["GET"])
def ai_health():
    """Check if AI service is available."""
    return jsonify({
        "status": "ok",
        "service": "AI Assistant",
        "model": "Gemini",
        "backend_model_id": "gemini-2.0-flash"
    })

# ================== LOGIN EVENTS (Location Tracking) ==================
@app.route("/api/login-activity", methods=["PUT"])
def upsert_login_activity_api():
    try:
        data = request.get_json(force=True) or {}
        employee_id = (data.get("employee_id") or "").strip().upper()
        date_str = (data.get("date") or "").strip()
        if not employee_id or not date_str:
            return jsonify({"success": False, "error": "employee_id and date are required"}), 400

        payload = {}
        if "check_in_time" in data:
            payload[LA_FIELD_CHECKIN_TIME] = data.get("check_in_time")
        if "check_in_location" in data:
            payload[LA_FIELD_CHECKIN_LOCATION] = data.get("check_in_location")
        if "check_out_time" in data:
            payload[LA_FIELD_CHECKOUT_TIME] = data.get("check_out_time")
        if "check_out_location" in data:
            payload[LA_FIELD_CHECKOUT_LOCATION] = data.get("check_out_location")

        token = get_access_token()
        record_id = _upsert_login_activity(token, employee_id, date_str, payload)
        updated = _fetch_login_activity_record(token, employee_id, date_str)

        return jsonify({
            "success": True,
            "record_id": record_id,
            "record": updated or {},
        })
    except Exception as e:
        print(f"[ERROR] upsert_login_activity_api: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/login-events", methods=["GET"])
def get_login_events():
    """Get login events (check-in/out with location) for L2/L3 tracking.
    
    Query params:
    - from: start date (YYYY-MM-DD)
    - to: end date (YYYY-MM-DD)
    - employee_id: filter by specific employee
    """
    try:
        from_date = (request.args.get("from") or "").strip()
        to_date = (request.args.get("to") or "").strip()
        employee_id_filter = request.args.get("employee_id", "").strip().upper()

        if not from_date or not to_date:
            today = datetime.now(timezone.utc).date().isoformat()
            from_date = from_date or today
            to_date = to_date or today

        token = get_access_token()
        employee_ids = _fetch_all_employee_ids(token)
        if employee_id_filter:
            employee_ids = [employee_id_filter]

        records = _fetch_login_activity_records_range(token, from_date, to_date, employee_id_filter)
        record_map = {}
        for r in records:
            emp = (r.get(LA_FIELD_EMPLOYEE_ID) or "").strip().upper()
            dt_raw = (r.get(LA_FIELD_DATE) or "").strip()
            # Normalize DateTime (2025-12-15T00:00:00Z) to date-only (2025-12-15)
            dt = dt_raw[:10] if dt_raw else ""
            if emp and dt:
                record_map[f"{emp}|{dt}"] = r

        try:
            d0 = date.fromisoformat(from_date)
            d1 = date.fromisoformat(to_date)
        except Exception:
            return jsonify({"success": False, "error": "Invalid date range. Expected YYYY-MM-DD."}), 400

        if d1 < d0:
            return jsonify({"success": False, "error": "to must be >= from"}), 400

        dates = []
        cur = d0
        while cur <= d1:
            dates.append(cur.isoformat())
            cur = cur + timedelta(days=1)

        daily_summary = []
        for dt in dates:
            for emp_id in employee_ids:
                rec = record_map.get(f"{emp_id}|{dt}") or {}
                daily_summary.append({
                    "employee_id": emp_id,
                    "date": dt,
                    "check_in_time": rec.get(LA_FIELD_CHECKIN_TIME),
                    "check_in_location": rec.get(LA_FIELD_CHECKIN_LOCATION),
                    "check_out_time": rec.get(LA_FIELD_CHECKOUT_TIME),
                    "check_out_location": rec.get(LA_FIELD_CHECKOUT_LOCATION),
                    "record_id": rec.get(LOGIN_ACTIVITY_PRIMARY_FIELD),
                })

        return jsonify({
            "success": True,
            "daily_summary": daily_summary,
            "total": len(daily_summary),
        })
    except Exception as e:
        print(f"[ERROR] get_login_events: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


# ================== MAIN ==================
if __name__ == '__main__':
    print("\n" + "=" * 80)
    print("UNIFIED BACKEND SERVER STARTING")
    print("=" * 80)
    print("Server Configuration:")
    print("=" * 80)
    port = int(os.getenv("PORT", "5000"))
    debug_flag = bool(app.config.get('DEBUG', False))
    print(f"  Host: 0.0.0.0 (accessible from network)")
    print(f"  Port: {port}")
    print(f"  Debug Mode: {'ON' if debug_flag else 'OFF'}")
    print("=" * 80)
    print("\nAvailable Services:")
    print("  [OK] Attendance Management (Check-in/Check-out)")
    print("  [OK] Leave Tracker (Apply Leave)")
    print("  [OK] Asset Management (CRUD Operations)")
    print("  [OK] Employee Master (CRUD & Bulk Upload)")
    print("  [OK] Employee Onboarding (5-Stage Process)")
    print("  [OK] Holiday Management (CRUD Operations)")
    print("  [OK] Deleted Employees Management (CSV)")
    print("=" * 80)
    print("\nEndpoints:")
    base = f"http://localhost:{port}"
    print(f"  -> {base}/ping - Health check")
    print(f"  -> {base}/api/info - API documentation")
    print(f"  -> {base}/api/checkin - Check-in")
    print(f"  -> {base}/api/checkout - Check-out")
    print(f"  -> {base}/apply_leave - Apply leave")
    print(f"  -> {base}/assets - Asset management")
    print(f"  -> {base}/api/employees - Employee management")
    print(f"  -> {base}/api/onboarding - Employee onboarding")
    print(f"  -> {base}/api/holidays - Holiday management")
    print("=" * 80 + "\n")
    
    app.run(debug=debug_flag, host='0.0.0.0', port=port)