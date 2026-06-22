#!/usr/bin/env python3
"""Remove contractor-side Date label + underline from two-party signature tables."""

from __future__ import annotations

import re
import zipfile
from pathlib import Path

TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "src" / "templates"

# Two-party signature tables: row 5 = date underlines, row 6 = Date labels (3 cells each).
TWO_PARTY = [
    "CHS-Service-Agreement-Template.docx",
    "CHS-Cost-Plus-Agreement-Template.docx",
    "CHS-Change-Order-Template.docx",
]

PBDR_BOTTOM = (
    '<w:pBdr><w:bottom w:val="single" w:color="000000" w:sz="4" w:space="1"/></w:pBdr>'
)
EMPTY_PARA = (
    "<w:p><w:pPr><w:spacing w:after=\"60\" w:before=\"60\"/></w:pPr>"
    '<w:r><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>'
    '<w:t xml:space="preserve"></w:t></w:r></w:p>'
)


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


def clear_contractor_date_cells(xml: str) -> str:
    span = find_signature_table(xml)
    if span is None:
        raise RuntimeError("signature table not found")

    tbl_start, tbl_end = span
    table = xml[tbl_start:tbl_end]
    rows = re.findall(r"<w:tr>.*?</w:tr>", table, re.DOTALL)
    if len(rows) < 7:
        raise RuntimeError(f"expected 7 signature rows, found {len(rows)}")

    # Row 5: contractor date underline (left cell) → empty paragraph.
    row5_cells = split_row_cells(rows[5])
    if len(row5_cells) < 3:
        raise RuntimeError(f"row 5 expected 3 cells, found {len(row5_cells)}")
    if PBDR_BOTTOM not in row5_cells[0]:
        raise RuntimeError("row 5 left cell missing date underline (pBdr)")
    row5_cells[0] = re.sub(
        r"<w:p>.*?</w:p>",
        EMPTY_PARA,
        row5_cells[0],
        count=1,
        flags=re.DOTALL,
    )
    rows[5] = join_row_cells(row5_cells)

    # Row 6: contractor "Date" label (left cell) → empty paragraph.
    row6_cells = split_row_cells(rows[6])
    if len(row6_cells) < 3:
        raise RuntimeError(f"row 6 expected 3 cells, found {len(row6_cells)}")
    if ">Date<" not in row6_cells[0]:
        raise RuntimeError('row 6 left cell missing "Date" label')
    row6_cells[0] = re.sub(
        r"<w:p>.*?</w:p>",
        EMPTY_PARA,
        row6_cells[0],
        count=1,
        flags=re.DOTALL,
    )
    rows[6] = join_row_cells(row6_cells)

    new_rows_xml = "".join(rows)
    new_table = re.sub(r"(<w:tblPr>.*?</w:tblPr>).*?(</w:tbl>)", rf"\1{new_rows_xml}\2", table, count=1, flags=re.DOTALL)
    return xml[:tbl_start] + new_table + xml[tbl_end:]


def patch_docx(path: Path) -> None:
    with zipfile.ZipFile(path, "r") as zin:
        xml = zin.read("word/document.xml").decode("utf-8")
        patched = clear_contractor_date_cells(xml)
        entries = {info.filename: zin.read(info.filename) for info in zin.infolist()}

    entries["word/document.xml"] = patched.encode("utf-8")
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as zout:
        for name, data in entries.items():
            zout.writestr(name, data)
    print(f"✓ Patched {path.name}")


def main() -> None:
    for name in TWO_PARTY:
        path = TEMPLATES_DIR / name
        if not path.exists():
            raise SystemExit(f"Missing {path}")
        patch_docx(path)

    sub_path = TEMPLATES_DIR / "CHS-Lien-Waiver-Sub-Unconditional-Template.docx"
    if sub_path.exists():
        print(f"○ Skipped {sub_path.name} (single-party sub signature — no contractor Date column)")


if __name__ == "__main__":
    main()
