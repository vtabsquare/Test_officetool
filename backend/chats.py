import os
import time
import uuid
import base64
import json
import traceback
import re
from threading import Lock
import requests
import datetime
from flask import Blueprint, request, jsonify, Response, current_app,send_file, make_response
import requests
import logging

# --------------------------------------------------------------
# BLUEPRINT
# --------------------------------------------------------------
chat_bp = Blueprint("chat", __name__, url_prefix="/chat")


log = logging.getLogger(__name__)
log.setLevel(logging.DEBUG)
# --------------------------------------------------------------
# ENTITY SETS (TABLE NAMES)
# --------------------------------------------------------------

CONV_ENTITY_SET = os.getenv("CHAT_CONVERSATION_ENTITY_SET", "crc6f_hr_chat_conversations")
MEMBERS_ENTITY_SET = os.getenv("CHAT_MEMBERS_ENTITY_SET", "crc6f_hr_conversation_memberses")
MSG_ENTITY_SET = os.getenv("CHAT_MESSAGE_ENTITY_SET", "crc6f_hr_messageses")
MSGSTATUS_ENTITY_SET = os.getenv("CHAT_MSGSTATUS_ENTITY_SET", "crc6f_hr_messagestatuses")
ANNOTATION_ENTITY_SET = "annotations"
EMPLOYEE_ENTITY_SET = os.getenv("CHAT_EMPLOYEE_ENTITY_SET", "crc6f_table12s")

RESOURCE = os.getenv("RESOURCE")
TENANT_ID = os.getenv("TENANT_ID") or os.getenv("AZURE_TENANT_ID")
CLIENT_ID = os.getenv("CLIENT_ID")
CLIENT_SECRET = os.getenv("CLIENT_SECRET")

if not RESOURCE:
    raise RuntimeError("RESOURCE environment variable is required")

# --------------------------------------------------------------
# TOKEN CACHE
# --------------------------------------------------------------

_token_cache = {"access_token": None, "expires_at": 0}


def _get_oauth_token():
    now = int(time.time())
    if _token_cache.get("access_token") and _token_cache["expires_at"] - 60 > now:
        return _token_cache["access_token"]

    url = f"https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token"
    data = {
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "scope": f"{RESOURCE.rstrip('/')}/.default",
        "grant_type": "client_credentials",
    }
    r = requests.post(url, data=data, timeout=10)
    r.raise_for_status()
    j = r.json()

    _token_cache["access_token"] = j["access_token"]
    _token_cache["expires_at"] = now + int(j.get("expires_in", 3600))
    return j["access_token"]

SOCKET_SERVER_URL = os.getenv("SOCKET_SERVER_URL", "http://localhost:4001")


CHAT_SOCKET_EMIT_URL = "http://localhost:4001/emit-to-room"


def emit_socket_event(event, payload):
    """
    Sends real-time event to Node socket server.
    This avoids running socket in Python.
    """
    try:
        requests.post(
            f"{SOCKET_SERVER_URL}/emit",
            json={"event": event, "data": payload},
            timeout=3
        )
    except Exception as e:
        print("Socket emit failed:", e)



def dataverse_headers():
    return {
        "Authorization": f"Bearer {_get_oauth_token()}",
        "Content-Type": "application/json; charset=utf-8",
        "Accept": "application/json",
    }
# --------------------------------------------------------------
# CRUD HELPERS (Dataverse)
# --------------------------------------------------------------

def dataverse_get(entity_set, q=None):
    url = f"{RESOURCE}/api/data/v9.2/{entity_set}"
    if q:
        url += f"?{q}"
    r = requests.get(url, headers=dataverse_headers(), timeout=20)
    r.raise_for_status()
    return r.json()


def dataverse_create(entity_set, data):
    url = f"{RESOURCE}/api/data/v9.2/{entity_set}"
    r = requests.post(url, headers=dataverse_headers(), data=json.dumps(data), timeout=20)

    if r.status_code in (200, 201, 204):
        try:
            if r.text and r.text.strip():
                return r.json()
        except:
            pass

        ent = r.headers.get("OData-EntityId") or r.headers.get("odata-entityid")
        return {"entity_reference": ent}

    raise RuntimeError(f"Dataverse create failed: {r.status_code} {r.text}")


def dataverse_update(entity_set, record_guid, data):
    # record_guid should be GUID without surrounding ()
    url = f"{RESOURCE}/api/data/v9.2/{entity_set}({record_guid})"
    r = requests.patch(url, headers=dataverse_headers(), data=json.dumps(data), timeout=20)
    if r.status_code not in (200, 204):
        r.raise_for_status()
    return True


def dataverse_delete(entity_set, record_guid):
    url = f"{RESOURCE}/api/data/v9.2/{entity_set}({record_guid})"
    r = requests.delete(url, headers=dataverse_headers(), timeout=20)
    if r.status_code not in (200, 204):
        r.raise_for_status()
    return True




# --------------------------------------------------------------
# Helper: Extract GUID from Dataverse record
# --------------------------------------------------------------

def extract_guid(record):
    """
    Finds the Dataverse GUID for update/delete.
    Works with:
      - crc6f_hr_xxxxxid fields
      - @odata.id
      - id field
    """
    if not record:
        return None

    # 1. Check any field ending in 'id' except business IDs
    for k, v in record.items():
        if k.lower().endswith("id") and not k.lower().startswith("crc6f_message_id") \
            and not k.lower().startswith("crc6f_conversationid") \
            and not k.lower().startswith("crc6f_member_id"):
            return v

    # 2. @odata.id — extract GUID
    odata = record.get("@odata.id")
    if odata and "(" in odata:
        return odata.split("(")[1].replace(")", "")

    # 3. fallback
    return record.get("id")


# --------------------------------------------------------------
# Employee name lookup (cached using file cache)
# --------------------------------------------------------------

def _get_employee_name_by_id(emp_id):
    try:
        if not emp_id:
            return None

        

        query = f"$filter=crc6f_employeeid eq '{emp_id}'&$top=1"
        resp = dataverse_get(EMPLOYEE_ENTITY_SET, query)
        rows = resp.get("value", []) if resp else []

        if not rows:
            
            return emp_id  # fallback to id

        r = rows[0]
        fn = r.get("crc6f_firstname") or ""
        ln = r.get("crc6f_lastname") or ""
        full = (fn + " " + ln).strip()

        result = full if full else emp_id
        

        return result

    except Exception:
        # Do not crash the flow if lookup fails
        return emp_id


# --------------------------------------------------------------
# Normalize message record
# --------------------------------------------------------------

def normalize_message(rec):
    if not rec:
        return {}
    return {
        "message_id": rec.get("crc6f_message_id"),
        "conversation_id": rec.get("crc6f_conversation_id"),
        "sender_id": rec.get("crc6f_sender_id"),
        "message_type": rec.get("crc6f_message_type"),
        "message_text": rec.get("crc6f_message_text"),
        "media_url": rec.get("crc6f_media_url"),
        "file_name": rec.get("crc6f_file_name"),
        "mime_type": rec.get("crc6f_mime_type"),
        "created_on": rec.get("createdon"),
    }


# --------------------------------------------------------------
# GET CONVERSATIONS (WITH MEMBERS ARRAY) — CACHED
# --------------------------------------------------------------

@chat_bp.route("/conversations/<string:user_id>", methods=["GET"])
def get_conversations(user_id):
    try:
        

        q = f"$filter=crc6f_user_id eq '{user_id}'&$top=500"
        mem_rows = dataverse_get(MEMBERS_ENTITY_SET, q).get("value", [])

        convo_ids = list({m["crc6f_conversation_id"] for m in mem_rows})

        results = []

        for cid in convo_ids:
            # fetch conversation
            cq = f"$filter=crc6f_conversationid eq '{cid}'&$top=1"
            conv_resp = dataverse_get(CONV_ENTITY_SET, cq).get("value", [])
            if not conv_resp:
                continue
            conv = conv_resp[0]

            # fetch all members
            mq = f"$filter=crc6f_conversation_id eq '{cid}'&$top=200"
            members_resp = dataverse_get(MEMBERS_ENTITY_SET, mq).get("value", [])

            members = []
            for m in members_resp:
                uid = m["crc6f_user_id"]
                real_name = _get_employee_name_by_id(uid)
                members.append({
                    "id": uid,
                    "name": real_name
                })

            is_group = str(conv.get("crc6f_isgroup", "")).lower() in ("true", "1", "yes")
            name = conv.get("crc6f_empname") or "Conversation"
            # ---- FETCH LAST MESSAGE ----
            mq2 = f"$filter=crc6f_conversation_id eq '{cid}'&$orderby=createdon desc&$top=1"
            last_msg_resp = dataverse_get(MSG_ENTITY_SET, mq2).get("value", [])

            last_msg_text = ""
            last_msg_sender = ""
            last_msg_time = ""
            last_sender_name = ""

            if last_msg_resp:
                last = last_msg_resp[0]
                last_msg_text = last.get("crc6f_message_text") or last.get("crc6f_file_name") or ""
                last_msg_sender = last.get("crc6f_sender_id")
                last_msg_time = last.get("createdon")
                if last_msg_sender:
                    last_sender_name = _get_employee_name_by_id(last_msg_sender)

            results.append({
                "conversation_id": cid,
                "name": name,
                "display_name": name,
                "is_group": is_group,
                "avatar": (name[:1] or "").upper(),
                "members": members,
                "last_message": last_msg_text,
                "last_sender": last_msg_sender,
                "last_sender_name": last_sender_name,
                "last_message_time": last_msg_time,
            })

        
        return jsonify(results)

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "convo_failed", "details": str(e)}), 500


# --------------------------------------------------------------
# DIRECT CHAT - reuse existing conversation if present or create
# --------------------------------------------------------------

@chat_bp.route("/direct", methods=["POST"])
def start_direct_chat():
    data = request.get_json() or {}
    u1 = data.get("user_id")
    u2 = data.get("target_id")

    if not u1 or not u2:
        return jsonify({"error": "user_id and target_id required"}), 400

    try:
        # find if both already share a conversation
        q = f"$filter=crc6f_user_id eq '{u1}' or crc6f_user_id eq '{u2}'"
        rows = dataverse_get(MEMBERS_ENTITY_SET, q).get("value", [])

        map_conv = {}
        for r in rows:
            cid = r["crc6f_conversation_id"]
            map_conv.setdefault(cid, set()).add(r["crc6f_user_id"])

        for cid, users in map_conv.items():
            if u1 in users and u2 in users:
                # check if direct chat
                cq = f"$filter=crc6f_conversationid eq '{cid}'&$top=1"
                conv = dataverse_get(CONV_ENTITY_SET, cq).get("value", [])
                if conv and str(conv[0].get("crc6f_isgroup")).lower() != "true":
                    return jsonify({"conversation_id": cid})

        # create new conversation
        conversation_id = str(uuid.uuid4())

        conv_payload = {
            "crc6f_conversationid": conversation_id,
            "crc6f_empname": f"{u1} → {u2}",
            "crc6f_isgroup": "false",
        }
        dataverse_create(CONV_ENTITY_SET, conv_payload)

        # create 2 members
        for uid in (u1, u2):
            mem = {
                "crc6f_conversation_id": conversation_id,
                "crc6f_member_id": str(uuid.uuid4()),
                "crc6f_user_id": uid,
                "crc6f_joined_on": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
            }
            dataverse_create(MEMBERS_ENTITY_SET, mem)

        
        emit_socket_event("conversation_created", {
            "conversation_id": conversation_id,
            "members": [u1, u2],
            "is_group": False
        })


        return jsonify({"conversation_id": conversation_id})

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "direct_failed", "details": str(e)}), 500


# --------------------------------------------------------------
# GROUP CREATE
# --------------------------------------------------------------

@chat_bp.route("/group", methods=["POST"])
def create_group():
    data = request.get_json() or {}
    name = data.get("name", "Group")
    members = data.get("members", [])
    creator = data.get("creator_id")

    if not members:
         members = []
    if creator and creator not in members:
         members.append(creator)

    cid = str(uuid.uuid4())

    try:
        dataverse_create(CONV_ENTITY_SET, {
            "crc6f_conversationid": cid,
            "crc6f_empname": name,
            "crc6f_isgroup": "true",
        })

        for uid in members:
            dataverse_create(MEMBERS_ENTITY_SET, {
                "crc6f_conversation_id": cid,
                "crc6f_member_id": str(uuid.uuid4()),
                "crc6f_user_id": uid,
                "crc6f_joined_on": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
            })

      
            
        emit_socket_event("conversation_created", {
            "conversation_id": cid,
            "members": members,
            "name": name,
            "is_group": True
        })


        return jsonify({"conversation_id": cid})

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "group_failed", "details": str(e)}), 500


# --------------------------------------------------------------
# GET MESSAGES (cached per conversation)
# --------------------------------------------------------------

@chat_bp.route("/messages/<string:conversation_id>", methods=["GET"])
def get_messages(conversation_id):
    try:
        

        q = f"$filter=crc6f_conversation_id eq '{conversation_id}'&$orderby=createdon asc&$top=1000"
        rows = dataverse_get(MSG_ENTITY_SET, q).get("value", [])
        out = [normalize_message(r) for r in rows]

        
        return jsonify(out)

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "messages_failed", "details": str(e)}), 500


# --------------------------------------------------------------
# SEND TEXT MESSAGE (and cache invalidation)
# --------------------------------------------------------------

@chat_bp.route("/send-text", methods=["POST"])
def send_text():
    data = request.get_json() or {}

    message_id = data.get("message_id") or str(uuid.uuid4())

    payload = {
        "crc6f_message_id": message_id,
        "crc6f_conversation_id": data.get("conversation_id"),
        "crc6f_sender_id": data.get("sender_id"),
        "crc6f_message_type": data.get("message_type", "text"),
        "crc6f_message_text": data.get("message_text"),
    }

    try:
        dataverse_create(MSG_ENTITY_SET, payload)
        emit_socket_event("new_message", normalize_message(payload))


        # Invalidate messages cache for this conversation and convo list of members
        conv_id = payload.get("crc6f_conversation_id")
        

            # invalidate conversation lists for all members of this conv (so last_message updates)
        try:
                mq = f"$filter=crc6f_conversation_id eq '{conv_id}'&$top=500"
                members_resp = dataverse_get(MEMBERS_ENTITY_SET, mq).get("value", [])
                for m in members_resp:
                    uid = m.get("crc6f_user_id")
                   
        except Exception:
                pass

        return jsonify(normalize_message(payload))

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "send_text_failed", "details": str(e)}), 500

# --------------------------------------------------------------
# SEND FILE MESSAGE (UPLOAD ANNOTATION + MESSAGE)
# --------------------------------------------------------------
@chat_bp.route("/send-file", methods=["POST"])
def send_file():
    try:
        conv = request.form.get("conversation_id")
        sender = request.form.get("sender_id")
        f = request.files.get("file")

        if not conv or not sender or not f:
            return jsonify({"error": "conversation_id, sender_id, file required"}), 400

        # ---------- SAFE MIME CHECK ----------
        SAFE_MIME = {
            "image/png", "image/jpeg", "image/jpg", "image/webp",
            "video/mp4", "video/webm",
            "audio/mpeg", "audio/mp3", "audio/wav",
            "application/pdf",
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.ms-excel",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/zip"
        }

        if f.mimetype not in SAFE_MIME:
            return jsonify({"error": "unsafe_file_type", "mime": f.mimetype}), 400

        # ---------- BASE64 ENCODE ----------
        file_bytes = f.read()
        encoded = base64.b64encode(file_bytes).decode("utf-8")

        # ---------- CREATE ANNOTATION ----------
        ann_payload = {
            "filename": f.filename,
            "mimetype": f.mimetype,
            "documentbody": encoded,
            "isdocument": True,      # REQUIRED!!
            "subject": f.filename,   # REQUIRED!!
            "notetext": ""           # REQUIRED FIELD FOR ANNOTATIONS
        }

        ann_res = dataverse_create(ANNOTATION_ENTITY_SET, ann_payload)

        annotation_raw = (
            ann_res.get("annotationid")
            or ann_res.get("id")
            or ann_res.get("entity_reference")
        )

        if not annotation_raw:
            raise RuntimeError("Dataverse did not return annotationid")

        # Extract GUID from "(guid)"
        if "(" in annotation_raw:
            annotation_id = annotation_raw.split("(")[1].replace(")", "")
        else:
            annotation_id = annotation_raw.strip()

        # ---------- CREATE CHAT MESSAGE ----------
        message_id = str(uuid.uuid4())

        msg_payload = {
            "crc6f_message_id": message_id,
            "crc6f_conversation_id": conv,
            "crc6f_sender_id": sender,
            "crc6f_message_type": (
                "image" if f.mimetype.startswith("image") else
                "video" if f.mimetype.startswith("video") else
                "audio" if f.mimetype.startswith("audio") else
                "file"
            ),
            "crc6f_media_url": annotation_id,
            "crc6f_file_name": f.filename,
            "crc6f_mime_type": f.mimetype
        }

        dataverse_create(MSG_ENTITY_SET, msg_payload)

        # ---------- SOCKET PUSH ----------
        emit_socket_event("new_message", {
            "message_id": message_id,
            "conversation_id": conv,
            "sender_id": sender,
            "message_type": msg_payload["crc6f_message_type"],
            "media_url": annotation_id,
            "file_name": f.filename,
            "mime_type": f.mimetype,
            "created_on": datetime.datetime.utcnow().isoformat()
        })

        return jsonify({
            "ok": True,
            "message_id": message_id,
            "file_name": f.filename,
            "mime_type": f.mimetype,
            "media_url": annotation_id
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "file_failed", "details": str(e)}), 500

# --------------------------------------------------------------
# DOWNLOAD FILE FROM DATAVERSE (ANNOTATION)
# --------------------------------------------------------------
@chat_bp.route("/file/<annotation_id>", methods=["GET"])
def download_file(annotation_id):
    try:
        # ---------- FETCH ANNOTATION ----------
        url = f"{RESOURCE}/api/data/v9.2/annotations({annotation_id})?$select=filename,mimetype,documentbody"
        headers = {
            "Authorization": f"Bearer {_get_oauth_token()}",
            "Accept": "application/json"
        }

        r = requests.get(url, headers=headers, timeout=30)

        if r.status_code != 200:
            return Response("File not found", status=404)

        meta = r.json()

        file_name = meta.get("filename", f"file_{annotation_id}")
        mime_type = meta.get("mimetype", "application/octet-stream")
        documentbody = meta.get("documentbody")

        if not documentbody:
            return Response("File contents missing", status=404)

        # ---------- DECODE BASE64 ----------
        try:
            clean_b64 = "".join(documentbody.split())
            binary = base64.b64decode(clean_b64)
        except Exception:
            return Response("Corrupted file in Dataverse", status=500)

        # ---------- INLINE FOR IMAGES/VIDEOS/AUDIO ----------
        inline_types = ("image/", "video/", "audio/")
        disposition = "inline" if mime_type.startswith(inline_types) else "attachment"

        resp = Response(binary, mimetype=mime_type)
        resp.headers["Content-Disposition"] = f'{disposition}; filename="{file_name}"'
        resp.headers["Content-Length"] = str(len(binary))
        resp.headers["Cache-Control"] = "no-store"

        return resp

    except Exception as e:
        traceback.print_exc()
        return Response("Server error", status=500)



# ================================================================
# PART 2 — GROUP MEMBERS, MESSAGE EDIT/DELETE, EMPLOYEE SEARCH
# ================================================================

# --------------------------------------------------------------
# GET GROUP MEMBERS (cached)
# --------------------------------------------------------------
@chat_bp.route("/group/<string:conversation_id>/members", methods=["GET"])
def get_group_members(conversation_id):
    try:
        

        q = f"$filter=crc6f_conversation_id eq '{conversation_id}'&$top=500"
        resp = dataverse_get(MEMBERS_ENTITY_SET, q)
        rows = resp.get("value", []) if resp else []

        out = []
        for r in rows:
            uid = r.get("crc6f_user_id")
            name = _get_employee_name_by_id(uid)
            out.append({
                "id": uid,
                "name": name,
                "joined_on": r.get("crc6f_joined_on")
            })

        
        return jsonify(out), 200

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "fetch_members_failed", "details": str(e)}), 500


# --------------------------------------------------------------
# ADD MEMBERS (CREATE NEW ROWS) - POST
# Body: { "members": ["EMP001", "EMP002"] }
# --------------------------------------------------------------
@chat_bp.route("/group/<string:conversation_id>/members/add", methods=["POST"])
def add_group_members(conversation_id):
    try:
        payload = request.get_json() or {}
        members = payload.get("members") or []
        sender_id = payload.get("sender_id")   # ✅ USE ONLY sender_id

        if not members:
            return jsonify({"error": "members_required"}), 400

        # fetch existing members
        q = f"$filter=crc6f_conversation_id eq '{conversation_id}'&$top=1000"
        resp = dataverse_get(MEMBERS_ENTITY_SET, q)
        existing_rows = resp.get("value", []) if resp else []
        existing_ids = {str(r.get("crc6f_user_id")) for r in existing_rows}

        inserted = []
        for uid in members:
            if str(uid) in existing_ids:
                continue

            new_member = {
                "crc6f_conversation_id": conversation_id,
                "crc6f_member_id": str(uuid.uuid4()),
                "crc6f_user_id": uid,
                "crc6f_joined_on": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            }
            dataverse_create(MEMBERS_ENTITY_SET, new_member)
            inserted.append(uid)

           

        
        for r in existing_rows:
            uid = r.get("crc6f_user_id")
            

        # ✅ ✅ ✅ SYSTEM MESSAGE (STORED + REALTIME)
        if sender_id and inserted:
            admin_name = _get_employee_name_by_id(sender_id)
            new_names = [_get_employee_name_by_id(mid) for mid in inserted]
            text = f"{admin_name} added " + ", ".join(new_names)

            sys_payload = {
                "message_id": f"sys_{uuid.uuid4()}",
                "conversation_id": conversation_id,
                "sender_id": "system",
                "message_type": "text",
                "message_text": text,
            }

            dataverse_create(MSG_ENTITY_SET, {
                "crc6f_message_id": sys_payload["message_id"],
                "crc6f_conversation_id": conversation_id,
                "crc6f_sender_id": "system",
                "crc6f_message_type": "text",
                "crc6f_message_text": text,
            })

            emit_socket_event("new_message", sys_payload)

        
        # ✅ REAL-TIME GROUP UPDATE SOCKET
        emit_socket_event("group_add_members", {
            "conversation_id": conversation_id,
            "members": inserted,
            "sender_id": payload.get("sender_id")
        })



        return jsonify({"ok": True, "inserted": inserted}), 200

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "add_members_failed", "details": str(e)}), 500

# --------------------------------------------------------------
# INTERNAL HELPER — delete Dataverse member row by GUID
# --------------------------------------------------------------
def _delete_member_record(rec):
    try:
        guid = rec.get("crc6f_hr_conversation_membersid") or extract_guid(rec)
        if not guid:
            return False

        guid = guid.strip()
        if guid.startswith("(") and guid.endswith(")"):
            guid = guid[1:-1]

        dataverse_delete(MEMBERS_ENTITY_SET, guid)
        return True

    except Exception:
        traceback.print_exc()
        return False


# --------------------------------------------------------------
# REMOVE SINGLE MEMBER
# DELETE /chat/group/<conversation_id>/members/<user_id>
# --------------------------------------------------------------
@chat_bp.route("/group/<string:conversation_id>/members/<string:user_id>", methods=["DELETE"])
def remove_group_member_single(conversation_id, user_id):
    try:
        q = f"$filter=crc6f_conversation_id eq '{conversation_id}' and crc6f_user_id eq '{user_id}'&$top=50"
        resp = dataverse_get(MEMBERS_ENTITY_SET, q)
        rows = resp.get("value", []) if resp else []

        deleted = []
        for r in rows:
            if _delete_member_record(r):
                deleted.append(user_id)

        
        # also invalidate convo_list for remaining members so UI refreshes correctly
        try:
            mq = f"$filter=crc6f_conversation_id eq '{conversation_id}'&$top=500"
            members_resp = dataverse_get(MEMBERS_ENTITY_SET, mq).get("value", [])
            for m in members_resp:
                uid = m.get("crc6f_user_id")
                
        except Exception:
            pass
        emit_socket_event("group_members_removed", {
            "conversation_id": conversation_id,
            "removed": deleted
        })


        return jsonify({"ok": True, "deleted": deleted}), 200

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "remove_member_failed", "details": str(e)}), 500


# --------------------------------------------------------------
# REMOVE MULTIPLE MEMBERS (DELETE or POST)
# Body: { "members": ["EMP007","EMP009"] }
# --------------------------------------------------------------
@chat_bp.route("/group/<string:conversation_id>/members/remove", methods=["POST", "DELETE"])
def remove_group_members(conversation_id):
    try:
        payload = request.get_json() or {}
        members = payload.get("members") or []
        sender_id = payload.get("sender_id")   # ✅ USE ONLY sender_id

        if not members:
            return jsonify({"error": "members_required"}), 400

        or_filters = " or ".join([f"crc6f_user_id eq '{m}'" for m in members])
        q = f"$filter=crc6f_conversation_id eq '{conversation_id}' and ({or_filters})&$top=500"

        resp = dataverse_get(MEMBERS_ENTITY_SET, q)
        rows = resp.get("value", []) if resp else []

        deleted = []
        for r in rows:
            uid = r.get("crc6f_user_id")
            if _delete_member_record(r):
                deleted.append(uid)

     

        try:
            mq = f"$filter=crc6f_conversation_id eq '{conversation_id}'&$top=500"
            members_resp = dataverse_get(MEMBERS_ENTITY_SET, mq).get("value", [])
            for m in members_resp:
                uid = m.get("crc6f_user_id")
                
        except Exception:
            pass

        # ✅ ✅ ✅ SYSTEM MESSAGE (STORED + REALTIME)
        if sender_id and deleted:
            admin_name = _get_employee_name_by_id(sender_id)
            removed_names = [_get_employee_name_by_id(mid) for mid in deleted]
            text = f"{admin_name} removed " + ", ".join(removed_names)

            sys_payload = {
                "message_id": f"sys_{uuid.uuid4()}",
                "conversation_id": conversation_id,
                "sender_id": "system",
                "message_type": "text",
                "message_text": text,
            }

            dataverse_create(MSG_ENTITY_SET, {
                "crc6f_message_id": sys_payload["message_id"],
                "crc6f_conversation_id": conversation_id,
                "crc6f_sender_id": "system",
                "crc6f_message_type": "text",
                "crc6f_message_text": text,
            })

            emit_socket_event("new_message", sys_payload)

        emit_socket_event("group_remove_members", {
            "conversation_id": conversation_id,
            "members": deleted,
            "sender_id": payload.get("sender_id")
        })


        return jsonify({"ok": True, "deleted": deleted}), 200

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "remove_members_failed", "details": str(e)}), 500

# --------------------------------------------------------------
# PATCH — EDIT MESSAGE
# Body: { "new_text": "Hello updated" }
# --------------------------------------------------------------
@chat_bp.route("/messages/<string:message_id>", methods=["PATCH"])
def edit_message(message_id):
    try:
        body = request.get_json() or {}
        new_text = body.get("new_text")
        if new_text is None:
            return jsonify({"error": "new_text required"}), 400

        q = f"$filter=crc6f_message_id eq '{message_id}'&$top=1"
        resp = dataverse_get(MSG_ENTITY_SET, q)
        rows = resp.get("value", []) if resp else []

        if not rows:
            return jsonify({"error": "message_not_found"}), 404

        rec = rows[0]
        guid = rec.get("crc6f_hr_messagesid") or extract_guid(rec)
        if not guid:
            return jsonify({"error": "cannot_determine_record_id"}), 500

        guid = guid.strip()
        if guid.startswith("(") and guid.endswith(")"):
            guid = guid[1:-1]

        dataverse_update(MSG_ENTITY_SET, guid, {
            "crc6f_message_text": new_text
        })

        # Invalidate caches for this conversation
        conv_id = rec.get("crc6f_conversation_id")
        
        try:
                mq = f"$filter=crc6f_conversation_id eq '{conv_id}'&$top=500"
                members_resp = dataverse_get(MEMBERS_ENTITY_SET, mq).get("value", [])
                for m in members_resp:
                    uid = m.get("crc6f_user_id")
                    
        except Exception:
                pass
        emit_socket_event("message_edited", {
            "message_id": message_id,
            "new_text": new_text
        })


        return jsonify({"ok": True, "message_id": message_id})

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "edit_failed", "details": str(e)}), 500


# --------------------------------------------------------------
# DELETE MESSAGE (SOFT DELETE) — Replace text with "[deleted]"
# --------------------------------------------------------------
@chat_bp.route("/messages/<string:message_id>", methods=["DELETE"])
def delete_message(message_id):
    try:
        q = f"$filter=crc6f_message_id eq '{message_id}'&$top=1"
        resp = dataverse_get(MSG_ENTITY_SET, q)
        rows = resp.get("value", []) if resp else []

        if not rows:
            return jsonify({"error": "message_not_found"}), 404

        rec = rows[0]
        guid = rec.get("crc6f_hr_messagesid") or extract_guid(rec)
        if not guid:
            return jsonify({"error": "cannot_determine_record_id"}), 500

        guid = guid.strip()
        if guid.startswith("(") and guid.endswith(")"):
            guid = guid[1:-1]

        dataverse_update(MSG_ENTITY_SET, guid, {
            "crc6f_message_text": "[deleted]"
        })

        # Invalidate caches for this conversation
        conv_id = rec.get("crc6f_conversation_id")
        
        try:
                mq = f"$filter=crc6f_conversation_id eq '{conv_id}'&$top=500"
                members_resp = dataverse_get(MEMBERS_ENTITY_SET, mq).get("value", [])
                for m in members_resp:
                    uid = m.get("crc6f_user_id")
                    
        except Exception:
                pass
        emit_socket_event("message_deleted", {
            "message_id": message_id
        })

        return jsonify({"ok": True, "message_id": message_id})

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "delete_failed", "details": str(e)}), 500


# --------------------------------------------------------------
# EMPLOYEE SEARCH
# --------------------------------------------------------------
@chat_bp.route("/employees/search", methods=["GET"])
def employee_search():
    try:
        q = (request.args.get("q") or "").strip()
        if not q:
            return jsonify([])

        safe = q.replace("'", "''")
        query = (
            f"$filter=contains(crc6f_firstname,'{safe}') or "
            f"contains(crc6f_lastname,'{safe}') or "
            f"contains(crc6f_email,'{safe}')&$top=30"
        )

        resp = dataverse_get(EMPLOYEE_ENTITY_SET, query)
        rows = resp.get("value", []) if resp else []

        out = []
        for r in rows:
            fn = r.get("crc6f_firstname") or ""
            ln = r.get("crc6f_lastname") or ""
            full = (fn + " " + ln).strip()

            emp_id = r.get("crc6f_employeeid") or r.get("crc6f_table12id")
            avatar = (fn[:1] or "U").upper()

            out.append({
                "id": emp_id,
                "name": full or emp_id,
                "email": r.get("crc6f_email"),
                "avatar": avatar
            })

        return jsonify(out)

    except Exception as e:
        traceback.print_exc()
        return jsonify([]), 500


# --------------------------------------------------------------
# EMPLOYEE LIST (ALL)
# --------------------------------------------------------------
@chat_bp.route("/employees/all", methods=["GET"])
def employee_all():
    try:
        resp = dataverse_get(EMPLOYEE_ENTITY_SET, "$top=200")
        rows = resp.get("value", []) if resp else []

        out = []
        for r in rows:
            fn = r.get("crc6f_firstname") or ""
            ln = r.get("crc6f_lastname") or ""
            full = (fn + " " + ln).strip()

            emp_id = r.get("crc6f_employeeid") or r.get("crc6f_table12id")
            avatar = (fn[:1] or "U").upper()

            out.append({
                "id": emp_id,
                "name": full or emp_id,
                "email": r.get("crc6f_email"),
                "avatar": avatar
            })

        return jsonify(out)

    except Exception as e:
        traceback.print_exc()
        return jsonify([]), 500
# --------------------------------------------------------------
# RENAME GROUP
# PATCH /chat/group/<conversation_id>/rename
# Body: { "name": "New Name" }
# --------------------------------------------------------------
@chat_bp.route("/group/<string:conversation_id>/rename", methods=["PATCH"])
def rename_group(conversation_id):
    try:
        body = request.get_json() or {}
        new_name = body.get("name", "").strip()

        if not new_name:
            return jsonify({"error": "name_required"}), 400

        # Fetch conversation row
        q = f"$filter=crc6f_conversationid eq '{conversation_id}'&$top=1"
        resp = dataverse_get(CONV_ENTITY_SET, q).get("value", [])
        if not resp:
            return jsonify({"error": "conversation_not_found"}), 404

        conv = resp[0]
        guid = conv.get("crc6f_hr_chat_conversationid") or extract_guid(conv)
        if not guid:
            return jsonify({"error": "cannot_determine_guid"}), 500

        guid = guid.strip().replace("(", "").replace(")", "")

        dataverse_update(CONV_ENTITY_SET, guid, {
            "crc6f_empname": new_name
        })

        # Invalidate all members' conversation list cache
        try:
            mq = f"$filter=crc6f_conversation_id eq '{conversation_id}'&$top=500"
            mems = dataverse_get(MEMBERS_ENTITY_SET, mq).get("value", [])
            for m in mems:
                uid = m.get("crc6f_user_id")
                
        except:
            pass
        emit_socket_event("group_renamed", {
            "conversation_id": conversation_id,
            "name": new_name
        })


        return jsonify({"ok": True, "name": new_name})

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "rename_failed", "details": str(e)}), 500

# --------------------------------------------------------------
# DELETE GROUP
# DELETE /chat/group/<conversation_id>
# --------------------------------------------------------------
@chat_bp.route("/group/<string:conversation_id>", methods=["DELETE"])
def delete_group(conversation_id):
    try:
        # 1. Fetch all member rows
        q = f"$filter=crc6f_conversation_id eq '{conversation_id}'&$top=500"
        resp = dataverse_get(MEMBERS_ENTITY_SET, q)
        existing_rows = resp.get("value", []) if resp else []

        # 2. Delete all member rows using correct GUID extraction
        for rec in existing_rows:
            _delete_member_record(rec)

        # 3. Delete conversation itself
        cq = f"$filter=crc6f_conversationid eq '{conversation_id}'&$top=1"
        conv_resp = dataverse_get(CONV_ENTITY_SET, cq).get("value", [])
        if conv_resp:
            conv_guid = conv_resp[0].get("crc6f_hr_chat_conversationsid") or extract_guid(conv_resp[0])
            if conv_guid:
                conv_guid = conv_guid.replace("(", "").replace(")", "")
                dataverse_delete(CONV_ENTITY_SET, conv_guid)

        # 4. Clear caches for all involved users
        for rec in existing_rows:
            uid = rec.get("crc6f_user_id")
           
        emit_socket_event("group_deleted", {
            "conversation_id": conversation_id
        })

        return jsonify({"ok": True})

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "group_delete_failed", "details": str(e)}), 500


# --------------------------------------------------------------
# LEAVE DIRECT CHAT (Remove only from the user)
# DELETE /chat/direct/<conversation_id>/<user_id>
# --------------------------------------------------------------
@chat_bp.route("/direct/<string:conversation_id>/<string:user_id>", methods=["DELETE"])
def leave_direct_chat(conversation_id, user_id):
    try:
        # 1. Fetch membership rows for this user in this conversation
        q = (
            f"$filter=crc6f_conversation_id eq '{conversation_id}' "
            f"and crc6f_user_id eq '{user_id}'&$top=10"
        )
        resp = dataverse_get(MEMBERS_ENTITY_SET, q)
        rows = resp.get("value", []) if resp else []

        if not rows:
            return jsonify({"ok": True, "note": "no member rows found"})

        # 2. Delete each member row using correct GUID
        for rec in rows:
            _delete_member_record(rec)

       
        emit_socket_event("direct_left", {
            "conversation_id": conversation_id,
            "user_id": user_id
        })

        return jsonify({"ok": True})

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": "leave_direct_failed", "details": str(e)}), 500

@chat_bp.route("/mark-read", methods=["POST"])
def mark_read():
    try:
        payload = request.get_json() or {}
        conversation_id = payload.get("conversation_id")
        user_id = payload.get("user_id")

        if not conversation_id or not user_id:
            return jsonify({"error": "conversation_id and user_id required"}), 400

        # ✅ OPTIONAL: you can store this in MSGSTATUS_ENTITY_SET later if needed

        emit_socket_event("messages_read", {
            "conversation_id": conversation_id,
            "user_id": user_id
        })

        return jsonify({"ok": True})

    except Exception as e:
        return jsonify({"error": "mark_read_failed", "details": str(e)}), 500

# --------------------------------------------------------------
# OPTIONS HANDLER
# --------------------------------------------------------------
@chat_bp.before_request
def handle_options():
    if request.method == "OPTIONS":
        return jsonify({"ok": True}), 200
