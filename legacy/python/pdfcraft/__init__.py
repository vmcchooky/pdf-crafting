"""
pdfcraft - A powerful, intuitive tool for manipulating PDF pages:
read, split, extract, move, insert, delete, and reorder.
"""

from .core import (
    DocumentInfo,
    PageInfo,
    PdfDocument,
    compress_pdf,
    decrypt_pdf,
    encrypt_pdf,
    merge_pdfs,
    parse_page_selection,
)
from .office import SUPPORTED_EXTENSIONS, convert_office_to_pdf, find_office_engine

__all__ = [
    "SUPPORTED_EXTENSIONS",
    "DocumentInfo",
    "PageInfo",
    "PdfDocument",
    "compress_pdf",
    "convert_office_to_pdf",
    "decrypt_pdf",
    "encrypt_pdf",
    "find_office_engine",
    "merge_pdfs",
    "parse_page_selection",
]
__version__ = "1.1.0"
