"""Fixed file locations. No path is ever derived from user input."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = ROOT / "config"
DATA_DIR = ROOT / "data"
CORPUS_DIR = DATA_DIR / "corpus"
VOCABULARY = CONFIG_DIR / "vocabulary.json"
TRUST_RULES = CONFIG_DIR / "trust_rules.json"
PEOPLE = DATA_DIR / "people.json"
CLAIMS = DATA_DIR / "claims.json"
RESOLUTIONS = DATA_DIR / "resolutions.json"
QUESTIONS_LOG = DATA_DIR / "questions_log.json"
EVAL_DIR = ROOT / "eval"
EVAL_RESULTS = EVAL_DIR / "results.json"
EVAL_RESULTS_MD = EVAL_DIR / "results.md"
