"""Convert the adjacent architecture Markdown report to a styled .docx using only Python stdlib."""
from pathlib import Path
from xml.sax.saxutils import escape
import re
import zipfile

BASE = Path(__file__).parent
source = BASE / "SentryAI_Architecture_and_Product_Report.md"
target = BASE / "SentryAI_Architecture_and_Product_Report.docx"
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def plain(value):
    value = re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)", r"\1 (\2)", value)
    return value.replace("**", "").replace("`", "").replace("*", "")


def run(value, *, bold=False, italic=False, color=None, size=20, font="Aptos"):
    props = [f'<w:rFonts w:ascii="{font}" w:hAnsi="{font}"/>', f'<w:sz w:val="{size}"/>']
    if bold:
        props.append("<w:b/>")
    if italic:
        props.append("<w:i/>")
    if color:
        props.append(f'<w:color w:val="{color}"/>')
    return f'<w:r><w:rPr>{"".join(props)}</w:rPr><w:t xml:space="preserve">{escape(value)}</w:t></w:r>'


def paragraph(value="", style=None, *, color="26384B", size=20, bold=False, italic=False, before=0, after=100, pagebreak=False):
    style_xml = f'<w:pStyle w:val="{style}"/>' if style else ""
    page_xml = "<w:pageBreakBefore/>" if pagebreak else ""
    spacing = f'<w:spacing w:before="{before}" w:after="{after}" w:line="270" w:lineRule="auto"/>'
    return f'<w:p><w:pPr>{style_xml}{spacing}{page_xml}</w:pPr>{run(plain(value), bold=bold, italic=italic, color=color, size=size)}</w:p>'


def table(rows):
    borders = '<w:tblBorders><w:top w:val="single" w:sz="5" w:color="D8E0EA"/><w:left w:val="single" w:sz="5" w:color="D8E0EA"/><w:bottom w:val="single" w:sz="5" w:color="D8E0EA"/><w:right w:val="single" w:sz="5" w:color="D8E0EA"/><w:insideH w:val="single" w:sz="4" w:color="E4E9F0"/><w:insideV w:val="single" w:sz="4" w:color="E4E9F0"/></w:tblBorders>'
    out = '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/>' + borders + '<w:tblCellMar><w:top w:w="90" w:type="dxa"/><w:start w:w="100" w:type="dxa"/><w:bottom w:w="90" w:type="dxa"/><w:end w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>'
    for ri, row in enumerate(rows):
        out += "<w:tr>"
        for cell in row:
            fill, ink = ("17365D", "FFFFFF") if ri == 0 else (("F2F6FA", "23364D") if ri % 2 else ("FFFFFF", "23364D"))
            out += f'<w:tc><w:tcPr><w:shd w:fill="{fill}"/></w:tcPr>{paragraph(cell, color=ink, size=17, bold=ri == 0, after=0)}</w:tc>'
        out += "</w:tr>"
    return out + "</w:tbl>"


def parse():
    lines = source.read_text(encoding="utf-8").splitlines()
    body, i, code, in_code, first_rule = [], 0, [], False, True
    while i < len(lines):
        raw, s = lines[i], lines[i].strip()
        if s.startswith("```"):
            if in_code:
                body.extend(paragraph(line, style="CodeLine", color="385574", size=16, after=0) for line in code)
                code, in_code = [], False
            else:
                code, in_code = [], True
            i += 1
            continue
        if in_code:
            code.append(raw)
            i += 1
            continue
        if s == "---":
            if first_rule:
                first_rule = False
                body.append(paragraph("REPORT CONTENTS", style="Heading1", color="17365D", size=30, bold=True, before=300, after=180, pagebreak=True))
                for item in ["Executive summary", "1. Product problem and value", "2. System architecture", "3. Classification and data signals", "4. Dashboard capabilities", "5. API and internal interfaces", "6. Source-file guide", "7. Data model and retention", "8. Security, privacy and production-readiness review", "9. Indian framework positioning", "10. Running the local demo", "11. Validation status", "12. Recommended product roadmap", "13. Glossary", "14. Primary official references"]:
                    body.append(paragraph("•  " + item, color="344B63", size=20, after=90))
                body.append(paragraph("", pagebreak=True))
            i += 1
            continue
        if not s:
            i += 1
            continue
        if s.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                if not all(re.fullmatch(r":?-{3,}:?", c.replace(" ", "")) for c in cells):
                    rows.append(cells)
                i += 1
            body.extend([table(rows), paragraph("", after=50)])
            continue
        if s.startswith("# "):
            title = s[2:]
            body.append(paragraph(title, style="Title" if title == "SentryAI" else "Heading1", color="17365D", size=52 if title == "SentryAI" else 31, bold=True, before=0 if title == "SentryAI" else 240, after=50 if title == "SentryAI" else 130, pagebreak=title.startswith(("8. ", "9. ", "10. ", "11. ", "12. ", "13. ", "14. "))))
        elif s.startswith("## "):
            title = s[3:]
            body.append(paragraph(title, style="Subtitle" if title == "Product & Technical Architecture Report" else "Heading1", color="347A8C" if title == "Product & Technical Architecture Report" else "17365D", size=34 if title == "Product & Technical Architecture Report" else 29, bold=True, after=240 if title == "Product & Technical Architecture Report" else 110, before=0 if title == "Product & Technical Architecture Report" else 240))
        elif s.startswith("### "):
            body.append(paragraph(s[4:], style="Heading2", color="24718A", size=23, bold=True, before=160, after=70))
        elif s.startswith("> "):
            body.append(paragraph(s[2:], style="Quote", color="36536F", size=22, italic=True, before=100, after=120))
        elif re.match(r"^\d+\.\s", s):
            body.append(paragraph(s, after=85))
        elif s.startswith("- "):
            body.append(paragraph("•  " + s[2:], after=70))
        else:
            body.append(paragraph(s, style="Subtitle", color="55677B", size=19, after=80) if s.startswith("**Version:**") else paragraph(s))
        i += 1
    return "".join(body)


styles = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="{W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="100" w:line="270" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style><w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:keepNext/><w:outlineLvl w:val="1"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="CodeLine"><w:name w:val="Code line"/><w:pPr><w:ind w:left="260"/><w:spacing w:line="220" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:pPr><w:ind w:left="360" w:right="240"/><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="347A8C"/></w:pBdr></w:pPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style></w:styles>'''
rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer.xml"/></Relationships>'''
content_types = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/header.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>'''
header = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="{W}"><w:p><w:pPr><w:jc w:val="right"/><w:pBdr><w:bottom w:val="single" w:sz="5" w:color="D8E0EA"/></w:pBdr></w:pPr>{run("SENTRYAI  |  PRODUCT & TECHNICAL ARCHITECTURE", bold=True, color="63758A", size=15)}</w:p></w:hdr>'''
footer = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="{W}"><w:p><w:pPr><w:jc w:val="center"/></w:pPr>{run("Confidential working document  ·  Page ", color="7B8794", size=15)}<w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>'''
document = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="{W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>{parse()}<w:sectPr><w:headerReference w:type="default" r:id="rId2"/><w:footerReference w:type="default" r:id="rId3"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="900" w:bottom="1080" w:left="900" w:header="500" w:footer="500" w:gutter="0"/></w:sectPr></w:body></w:document>'''
root_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'''
core = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>SentryAI Product &amp; Technical Architecture Report</dc:title><dc:subject>Executive briefing, product architecture, security and compliance mapping</dc:subject><dc:creator>SentryAI Product &amp; Engineering</dc:creator></cp:coreProperties>'''

with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as doc:
    doc.writestr("[Content_Types].xml", content_types)
    doc.writestr("_rels/.rels", root_rels)
    doc.writestr("docProps/core.xml", core)
    doc.writestr("word/document.xml", document)
    doc.writestr("word/styles.xml", styles)
    doc.writestr("word/_rels/document.xml.rels", rels)
    doc.writestr("word/header.xml", header)
    doc.writestr("word/footer.xml", footer)
print(f"Created {target} ({target.stat().st_size:,} bytes)")
