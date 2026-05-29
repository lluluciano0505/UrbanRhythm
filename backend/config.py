import os
from pathlib import Path

from dotenv import load_dotenv

# Load .env from the repo root (one level above backend/)
_root = Path(__file__).parent.parent
load_dotenv(_root / ".env")

OPENROUTER_API_KEY: str = os.getenv("OPENROUTER_API_KEY", "")
JINA_API_KEY: str = os.getenv("JINA_API_KEY", "")
TAVILY_API_KEY: str = os.getenv("TAVILY_API_KEY", "")

DB_PATH: str = os.getenv("DB_PATH", str(_root / "data" / "urbanrhythm.sqlite"))
BACKEND_PORT: int = int(os.getenv("BACKEND_PORT", "8000"))
