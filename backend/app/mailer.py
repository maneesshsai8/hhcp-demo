"""
Minimal SMTP sender. In the demo it targets the local Supabase Mailpit catcher
(SMTP :54325, inbox UI http://127.0.0.1:54324), so "email notifications" are
real and viewable — swap SMTP_* env for a production relay later. Best-effort:
returns True/False, never raises into the request path.
"""
import smtplib
from email.mime.text import MIMEText
from email.utils import formataddr

from app import config


def send_email(to_addrs: list[str], subject: str, body: str) -> bool:
    to_addrs = [a for a in to_addrs if a]
    if not to_addrs:
        return False
    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = subject
    msg["From"] = formataddr(("HHCP Announcements", config.SMTP_FROM))
    msg["To"] = ", ".join(to_addrs)
    try:
        with smtplib.SMTP(config.SMTP_HOST, config.SMTP_PORT, timeout=5) as s:
            s.sendmail(config.SMTP_FROM, to_addrs, msg.as_string())
        return True
    except Exception:
        return False
