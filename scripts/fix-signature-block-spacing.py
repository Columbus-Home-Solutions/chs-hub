#!/usr/bin/env python3
"""Add client-column vertical spacer above signature line in two-party templates.

Contractor row-1 gets a ~40pt signature image at prep time; client row-1 is only
a pBdr underline. Insert a matching empty paragraph so both columns align.
"""

from __future__ import annotations

import re
import zipfile
from pathlib import Path

TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "src" / "templates"

TWO_PARTY = [
    "CHS-Service-Agreement-Template.docx",
    "CHS-Cost-Plus-Agreement-Template.docx",
    "CHS-Change-Order-Template.docx",
]

# ~40pt empty line (matches embedded contractor-signature.png height in prep-templates.ts)
CLIENT_SIG_SPACER = (
    "<w:p><w:pPr>"
    '<w:spacing w:after="0" w:before="0" w:line="800" w:lineRule="exact"/>'
    "</w:pPr>"
    '<w:r><w:rPr><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>'
    '<w:t xml:space="preserve"></w:t></w:r></w:p>'
)

SPACER_MARKER = 'w:line="800" w:lineRule="exact"'


def find_signature_table(xml: str) -> tuple[int, int] | None:
    for anchor in ("SIGNATURES", "AUTHORIZATION SIGNATURES"):
        idx = xml.find(anchor)
        if idx == -1:
            continue
        tbl_start = xml.find("<w:tbl>", idx)
        if tbl_start == -1:
            continue
        tbl_end = xml.find("</w:tbl>", tbl_start)
        if tbl_end == -1:
            continue
        return tbl_start, tbl_end + len("</w:tbl>")
    return None


def split_row_cells(row_xml: str) -> list[str]:
    return re.findall(r"<w:tc>.*?</w:tc>", row_xml, re.DOTALL)


def join_row_cells(cells: list[str]) -> str:
    return "<w:tr>" + "".join(cells) + "</w:tr>"


def add_client_spacer(row_xml: str) -> str:
    cells = split_row_cells(row_xml)
    if len(cells) < 3:
        raise RuntimeError(f"expected 3-cell signature row, found {len(cells)}")
    client_cell = cells[2]
    if SPACER_MARKER in client_cell:
        return row_xml  # already patched
    if "pBdr" not in client_cell:
        raise RuntimeError("client cell missing signature underline (pBdr)")
    client_cell = client_cell.replace("<w:tcPr>", "<w:tcPr>", 1)
    # Insert spacer immediately before the signature-line paragraph.
    client_cell = re.sub(
        r"(<w:tc>.*?<w:tcPr>.*?</w:tcPr>)",
        rf"\1{CLIENT_SIG_SPACER}",
        client_cell,
        count=1,
        flags=re.DOTALL,
    )
    cells[2] = client_cell
    return join_row_cells(cells)


def patch_docx(path: Path) -> bool:
    with zipfile.ZipFile(path, "r") as zin:
        xml = zin.read("word/document.xml").decode("utf-8")
        span = find_signature_table(xml)
        if span is None:
            raise RuntimeError("signature table not found")
        tbl_start, tbl_end = span
        table = xml[tbl_start:tbl_end]
        rows = re.findall(r"<w:tr>.*?</w:tr>", table, re.DOTALL)
        if len(rows) < 2:
            raise RuntimeError(f"expected at least 2 signature rows, found {len(rows)}")
        new_row1 = add_client_spacer(rows[1])
        if new_row1 == rows[1]:
            return False
        new_table = table.replace(rows[1], new_row1, 1)
        patched = xml[:tbl_start] + new_table + xml[tbl_end:]
        entries = {info.filename: zin.read(info.filename) for info in zin.infolist()}

    entries["word/document.xml"] = patched.encode("utf-8")
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as zout:
        for name, data in entries.items():
            zout.writestr(name, data)
    return True


def main() -> None:
    for name in TWO_PARTY:
        path = TEMPLATES_DIR / name
        if not path.exists():
            raise SystemExit(f"Missing {path}")
        changed = patch_docx(path)
        print(f"{'✓ Patched' if changed else '○ Already OK'} {name}")

    print(
        "○ Skipped CHS-Lien-Waiver-Sub-Unconditional-Template.docx "
        "(single-party sub signature table — no Contractor|Client columns)"
    )


if __name__ == "__main__":
    main()
