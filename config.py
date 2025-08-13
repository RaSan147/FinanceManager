import os
from dotenv import load_dotenv

load_dotenv()

class Config:
    SECRET_KEY = os.getenv('SECRET_KEY', 'your-secret-key-here')
    MONGO_URI = os.getenv('MONGO_URI', 'mongodb://localhost:27017/finance_tracker')
    GEMINI_API_KEY = os.getenv('GEMINI_API_KEY')
    PASTEBIN_API_KEY = os.getenv('PASTEBIN_API_KEY')
    ONLY_ALLOWED_EMAILS = [e.strip() for e in os.getenv('ONLY_ALLOWED_EMAILS', '').split(',')]
    ONLY_ALLOWED_EMAILS = [e for e in ONLY_ALLOWED_EMAILS if e]
    ONLY_ALLOWED_EMAIL_DOMAINS = [d.strip() for d in os.getenv('ONLY_ALLOWED_EMAIL_DOMAINS', '').split(',')]
    ONLY_ALLOWED_EMAIL_DOMAINS = [d for d in ONLY_ALLOWED_EMAIL_DOMAINS if d]

    MONGO_URI_LIMITER = os.getenv('MONGO_URI_LIMITER', MONGO_URI)

    # If set to '1' (or any truthy value below) will force showing full traceback
    # in custom error pages and JSON responses even when debug=False (production).
    SHOW_DETAILED_ERRORS = str(os.getenv('SHOW_DETAILED_ERRORS', '0')).lower() in {'1','true','yes','on'}