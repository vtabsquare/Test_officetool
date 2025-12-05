from flask import Flask, jsonify, request, session, current_app
from flask_mail import Mail, Message
import os
import traceback
import smtplib
import socket
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from dotenv import load_dotenv

# Load env for local dev
if os.path.exists("id.env"):
    load_dotenv("id.env")
load_dotenv()

# Standalone app for backward compatibility (not used when imported)
app = Flask(__name__)
app.config['MAIL_SERVER'] = os.getenv('MAIL_SERVER', 'smtp.gmail.com')
app.config['MAIL_PORT'] = 587
app.config['MAIL_USE_TLS'] = True
app.config['MAIL_USERNAME'] = os.getenv('MAIL_USERNAME')
app.config['MAIL_PASSWORD'] = os.getenv('MAIL_PASSWORD')
app.config['MAIL_DEFAULT_SENDER'] = os.getenv('MAIL_DEFAULT_SENDER', app.config['MAIL_USERNAME'])
app.config['MAIL_TIMEOUT'] = 10  # 10 second timeout
mail = Mail(app)

print("DEBUG: MAIL_USERNAME =", os.getenv("MAIL_USERNAME"))
print("DEBUG: MAIL_DEFAULT_SENDER =", os.getenv("MAIL_DEFAULT_SENDER"))


# ------------------------------
# ✉️ Email Send Function
# ------------------------------
def send_email_smtp_direct(subject, recipients, body, html=None):
    """
    Send email using direct SMTP with timeout.
    Fallback method that doesn't rely on Flask-Mail.
    """
    mail_server = os.getenv('MAIL_SERVER', 'smtp.gmail.com')
    mail_port = int(os.getenv('MAIL_PORT', 587))
    mail_username = os.getenv('MAIL_USERNAME')
    mail_password = os.getenv('MAIL_PASSWORD')
    mail_sender = os.getenv('MAIL_DEFAULT_SENDER', mail_username)
    
    print(f"[MAIL-SMTP] Connecting to {mail_server}:{mail_port}", flush=True)
    
    # Create message
    msg = MIMEMultipart('alternative')
    msg['Subject'] = subject
    msg['From'] = mail_sender
    msg['To'] = ', '.join(recipients) if isinstance(recipients, list) else recipients
    
    # Attach text and HTML parts
    msg.attach(MIMEText(body, 'plain'))
    if html:
        msg.attach(MIMEText(html, 'html'))
    
    # Set socket timeout
    socket.setdefaulttimeout(15)
    
    try:
        server = smtplib.SMTP(mail_server, mail_port, timeout=15)
        server.ehlo()
        server.starttls()
        server.ehlo()
        print(f"[MAIL-SMTP] Logging in as {mail_username}", flush=True)
        server.login(mail_username, mail_password)
        print("[MAIL-SMTP] Sending message...", flush=True)
        server.sendmail(mail_sender, recipients, msg.as_string())
        server.quit()
        print(f"[MAIL-SMTP] Email sent successfully -> {recipients}", flush=True)
        return True
    except smtplib.SMTPAuthenticationError as e:
        print(f"[MAIL-SMTP] Authentication failed: {e}", flush=True)
        return False
    except socket.timeout:
        print("[MAIL-SMTP] Connection timed out", flush=True)
        return False
    except Exception as e:
        print(f"[MAIL-SMTP] Error: {e}", flush=True)
        traceback.print_exc()
        return False
    finally:
        socket.setdefaulttimeout(None)


def send_email(subject, recipients, body, html=None, cc=None, attachments=None):
    """
    Send email - uses direct SMTP with timeout to avoid worker death.
    """
    print(f"[MAIL] send_email called: to={recipients}, subject={subject}", flush=True)
    
    # Use direct SMTP method with proper timeout handling
    # This avoids Flask-Mail's potential hanging issues
    if not attachments:
        return send_email_smtp_direct(subject, recipients, body, html)
    
    # Fall back to Flask-Mail for attachments
    print("[MAIL] Using Flask-Mail for attachments", flush=True)
    try:
        flask_app = current_app._get_current_object()
        mail_instance = flask_app.extensions.get('mail')
        if not mail_instance:
            flask_app = app
            mail_instance = mail
    except RuntimeError:
        flask_app = app
        mail_instance = mail

    try:
        with flask_app.app_context():
            msg = Message(subject=subject, recipients=recipients, cc=cc, body=body, html=html)
            if attachments:
                for filename, file_data in attachments:
                    msg.attach(filename=filename, content_type='application/pdf', data=file_data)
                    print(f"[MAIL] Attached: {filename}", flush=True)
            mail_instance.send(msg)
            print(f"[MAIL] Email sent successfully -> {recipients}", flush=True)
            return True
    except Exception as e:
        print(f"[MAIL] Failed to send email to {recipients}: {e}", flush=True)
        traceback.print_exc()
        return False
    
    
