# ai_gemini.py - Gemini AI integration for HR Office Tool
import os
import json
import requests
from typing import Optional
from dotenv import load_dotenv

load_dotenv("id.env")

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
if not GEMINI_API_KEY:
    print("[AI_GEMINI] WARNING: GEMINI_API_KEY environment variable not set!")
GEMINI_MODEL = "models/gemini-2.0-flash"
GEMINI_API_URL = f"https://generativelanguage.googleapis.com/v1/{GEMINI_MODEL}:generateContent"

print(f"[AI_GEMINI] Loaded with model: {GEMINI_MODEL}, API Key present: {bool(GEMINI_API_KEY)}")

def build_system_prompt(user_meta: dict) -> str:
    """Build a system prompt for the HR AI assistant."""
    user_name = user_meta.get("name", "User")
    is_admin = user_meta.get("is_admin", False)
    is_l3 = user_meta.get("is_l3", False)
    user_role = "Admin" if is_admin else "L3" if is_l3 else "Employee"
    emp_id = user_meta.get("employee_id", "Unknown")
    
    return f"""You are an intelligent HR Assistant for VTab Office Tool. You help employees and managers with HR-related queries.

Current User: {user_name} ({emp_id}) - Role: {user_role}

Your capabilities:
- Answer questions about attendance, leaves, timesheets, and HR policies
- Provide summaries of employee data and team statistics
- Help with leave applications, attendance queries, and timesheet information
- Explain HR processes and company policies
- Analyze trends in attendance and leave patterns

Access Level: {user_role}
- Admin/L3: Full access to all data and operations, including employee management
- Employee: Access only to personal data and basic queries

Guidelines:
1. Be concise, professional, and helpful
2. Use the provided data context to give accurate answers
3. If data is not available, clearly state that
4. For sensitive information, strictly enforce access levels:
   - Admin/L3 employees have full access to all functions
   - Regular employees can only access their own data
5. Format responses with clear structure when appropriate
6. Use bullet points and numbers for lists
7. Be friendly but professional

Remember: You only have access to the data provided in the context. Don't make up information."""


def ask_gemini(
    question: str,
    data_context: dict,
    user_meta: dict,
    history: Optional[list] = None
) -> dict:
    """
    Send a question to Gemini with context and get a response.
    
    Args:
        question: User's question
        data_context: Dict containing relevant HR data
        user_meta: User information (name, role, permissions)
        history: Previous conversation turns
    
    Returns:
        Dict with 'answer', 'success', and optional 'error'
    """
    try:
        system_prompt = build_system_prompt(user_meta)
        
        # Build context from data
        context_parts = []
        if data_context:
            context_parts.append("=== AVAILABLE DATA ===")
            for key, value in data_context.items():
                if value:
                    if isinstance(value, (dict, list)):
                        context_parts.append(f"\n{key.upper()}:\n{json.dumps(value, indent=2, default=str)}")
                    else:
                        context_parts.append(f"\n{key.upper()}: {value}")
        
        context_str = "\n".join(context_parts) if context_parts else "No specific data available."
        
        # Build conversation history
        messages = []
        if history:
            for msg in history[-6:]:  # Keep last 6 messages for context
                role = "user" if msg.get("role") == "user" else "model"
                messages.append({
                    "role": role,
                    "parts": [{"text": msg.get("text", "")}]
                })
        
        # Add current question with context
        full_prompt = f"""{system_prompt}

{context_str}

User Question: {question}

Please provide a helpful, accurate response based on the available data."""
        
        messages.append({
            "role": "user",
            "parts": [{"text": full_prompt}]
        })
        
        # Call Gemini API
        headers = {
            "Content-Type": "application/json"
        }
        
        payload = {
            "contents": messages,
            "generationConfig": {
                "temperature": 0.7,
                "topK": 40,
                "topP": 0.95,
                "maxOutputTokens": 1024,
            },
            "safetySettings": [
                {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_MEDIUM_AND_ABOVE"},
                {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_MEDIUM_AND_ABOVE"},
                {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_MEDIUM_AND_ABOVE"},
                {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_MEDIUM_AND_ABOVE"},
            ]
        }
        
        api_url = f"{GEMINI_API_URL}?key={GEMINI_API_KEY}"
        print(f"[AI_GEMINI] Calling API: {GEMINI_API_URL}")
        
        response = requests.post(
            api_url,
            headers=headers,
            json=payload,
            timeout=30
        )
        
        print(f"[AI_GEMINI] Response status: {response.status_code}")
        
        if response.status_code != 200:
            error_text = response.text[:500]
            print(f"[AI_GEMINI] Error response: {error_text}")
            return {
                "success": False,
                "answer": None,
                "error": f"Gemini API error: {response.status_code} - {error_text}"
            }
        
        result = response.json()
        
        # Extract answer from response
        candidates = result.get("candidates", [])
        if not candidates:
            return {
                "success": False,
                "answer": None,
                "error": "No response generated"
            }
        
        content = candidates[0].get("content", {})
        parts = content.get("parts", [])
        answer = parts[0].get("text", "") if parts else ""
        
        return {
            "success": True,
            "answer": answer,
            "error": None
        }
        
    except requests.Timeout:
        return {
            "success": False,
            "answer": None,
            "error": "Request timed out. Please try again."
        }
    except Exception as e:
        return {
            "success": False,
            "answer": None,
            "error": f"Error: {str(e)}"
        }


def quick_answer(question: str, user_name: str = "User") -> str:
    """Quick helper for simple questions without full context."""
    result = ask_gemini(
        question=question,
        data_context={},
        user_meta={"name": user_name, "is_admin": False},
        history=None
    )
    return result.get("answer") or result.get("error", "Unable to get response")
