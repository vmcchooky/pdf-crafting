"""
Entry point when running with `python -m pdfcraft`.
"""

import sys

from .cli import main

if __name__ == "__main__":
    sys.exit(main())
