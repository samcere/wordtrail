"""Wordtrail local MVP: persistent vocabulary plans and printable PDFs."""
from __future__ import annotations

import base64, csv, hashlib, io, json, math, mimetypes, os, random, re, shutil, subprocess, sys, tempfile, uuid, zipfile
from datetime import datetime
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse
from xml.etree import ElementTree as ET

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.graphics import renderPDF
from reportlab.graphics.barcode import qr
from reportlab.graphics.shapes import Drawing
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parent
DATA_DIR, DOC_DIR = ROOT / "data", ROOT / "documents"
DATA_FILE = DATA_DIR / "wordtrail.json"
DICTIONARY_FILE = ROOT / "dictionary" / "ecdict.csv"
OMR_ROOT = ROOT / "vendor" / "OMRChecker"
OMR_ASSET_DIR = ROOT / "omr"
OMR_TEMPLATE_FILE = OMR_ASSET_DIR / "template.json"
OMR_REFERENCE_FILE = OMR_ASSET_DIR / "wordtrail-card-reference.png"
OMR_MARKER_FILE = OMR_ASSET_DIR / "omr_marker.png"
OMR_CONFIG_FILE = OMR_ASSET_DIR / "config.json"
DICTIONARY_VERSION = "ECDICT 2026.09 (MIT)"
_DICTIONARY: dict[str, dict] | None = None
FONT = "STSong-Light"
pdfmetrics.registerFont(UnicodeCIDFont(FONT))
LATIN_FONT = "WordtrailLatin"
try:
    pdfmetrics.registerFont(TTFont(LATIN_FONT, r"C:\Windows\Fonts\arial.ttf"))
except Exception:
    LATIN_FONT = "Helvetica"

ITEMS_PER_PAGE = 30
CARDS_PER_PAGE, CARD_COLUMNS, CARD_ROWS = 150, 10, 15
# The card is normalized to this canvas before OMRChecker applies its template.
OMR_PAGE_WIDTH, OMR_PAGE_HEIGHT = 2100, 2970
# Four 8 mm bullseye markers are printed at (10, 10), (200, 10),
# (10, 287), and (200, 287) mm. CropOnMarkers maps their centres to this
# normalized canvas, including camera perspective correction.
OMR_CELL_WIDTH, OMR_CELL_HEIGHT = 192, 145
OMR_CARD_LEFT, OMR_CARD_TOP = 88, 332
OMR_BUBBLE_LEFT, OMR_BUBBLE_TOP = 105, 389
OMR_BUBBLE_SIZE, OMR_BUBBLE_GAP = 36, 50

def now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M")

def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"

def safe_name(value: str) -> str:
    value = re.sub(r"[\\/:*?\"<>|]+", "_", value).strip()
    return value[:48] or "词轨文档"

def default_data() -> dict:
    return {"wordbooks": [], "plans": [], "documents": [], "active_plan_id": None}

def load_data() -> dict:
    DATA_DIR.mkdir(exist_ok=True); DOC_DIR.mkdir(exist_ok=True)
    if not DATA_FILE.exists():
        data = default_data(); save_data(data); return data
    try: return json.loads(DATA_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError): return default_data()

def save_data(data: dict) -> None:
    DATA_DIR.mkdir(exist_ok=True)
    DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

def ensure_omr_assets() -> None:
    """Create the OMRChecker reference image and its 150-field template.

    Keeping this geometry in one place means the exported card and scan template
    cannot silently drift apart as the PDF layout evolves.
    """
    from PIL import Image, ImageDraw, ImageFont

    OMR_ASSET_DIR.mkdir(parents=True, exist_ok=True)
    image = Image.new("L", (OMR_PAGE_WIDTH, OMR_PAGE_HEIGHT), 255)
    draw = ImageDraw.Draw(image)
    try:
        number_font = ImageFont.truetype(r"C:\Windows\Fonts\arial.ttf", 25)
        label_font = ImageFont.truetype(r"C:\Windows\Fonts\arial.ttf", 31)
    except OSError:
        number_font = label_font = ImageFont.load_default()
    draw.text((180, 205), "WORDTRAIL  |  OMR ERROR CARD  |  FILL LEFT BUBBLE FOR WRONG", fill=35, font=label_font)
    for x, y in ((120, 120), (1940, 120), (120, 2770), (1940, 2770)):
        draw.rectangle((x, y, x + 40, y + 40), fill=0)
    for index in range(CARDS_PER_PAGE):
        row, col = divmod(index, CARD_COLUMNS)
        left = OMR_CARD_LEFT + col * OMR_CELL_WIDTH
        top = OMR_CARD_TOP + row * OMR_CELL_HEIGHT
        draw.rectangle((left, top, left + OMR_CELL_WIDTH, top + OMR_CELL_HEIGHT), outline=125, width=4)
        for bubble_left in (OMR_BUBBLE_LEFT + col * OMR_CELL_WIDTH, OMR_BUBBLE_LEFT + col * OMR_CELL_WIDTH + OMR_BUBBLE_GAP):
            draw.ellipse((bubble_left, OMR_BUBBLE_TOP + row * OMR_CELL_HEIGHT, bubble_left + OMR_BUBBLE_SIZE, OMR_BUBBLE_TOP + row * OMR_CELL_HEIGHT + OMR_BUBBLE_SIZE), outline=70, width=3)
        draw.text((left + 112, top + 51), f"{index + 1:03d}", fill=25, font=number_font)
    image.save(OMR_REFERENCE_FILE)
    marker = Image.new("L", (160, 160), 255)
    marker_draw = ImageDraw.Draw(marker)
    for bounds, fill in (((4, 4, 156, 156), 0), ((34, 34, 126, 126), 255), ((55, 55, 105, 105), 0), ((70, 70, 90, 90), 255), ((75, 75, 85, 85), 0)):
        marker_draw.ellipse(bounds, fill=fill)
    marker.save(OMR_MARKER_FILE)
    OMR_CONFIG_FILE.write_text(json.dumps({"dimensions": {"processing_width": 666, "processing_height": 942}, "outputs": {"save_detections": False}}), encoding="utf-8")
    field_blocks = {}
    for col in range(CARD_COLUMNS):
        field_blocks[f"column_{col + 1}"] = {
            "origin": [OMR_BUBBLE_LEFT + col * OMR_CELL_WIDTH, OMR_BUBBLE_TOP],
            "bubblesGap": OMR_BUBBLE_GAP,
            "labelsGap": OMR_CELL_HEIGHT,
            "bubbleValues": ["X", ""],
            "direction": "horizontal",
            # The card is printed row-first (1..10 on its first row), while a
            # field block runs top-to-bottom inside one visual column.
            "fieldLabels": [f"q{row * CARD_COLUMNS + col + 1}" for row in range(CARD_ROWS)],
        }
    template = {
        "pageDimensions": [OMR_PAGE_WIDTH, OMR_PAGE_HEIGHT],
        "bubbleDimensions": [OMR_BUBBLE_SIZE, OMR_BUBBLE_SIZE],
        "emptyValue": "",
        "outputColumns": [f"q{i}" for i in range(1, CARDS_PER_PAGE + 1)],
        "fieldBlocks": field_blocks,
        "preProcessors": [{"name": "CropOnMarkers", "options": {"relativePath": OMR_MARKER_FILE.name, "sheetToMarkerWidthRatio": 26, "marker_rescale_range": [40, 160], "marker_rescale_steps": 12, "min_matching_threshold": .36}}],
    }
    OMR_TEMPLATE_FILE.write_text(json.dumps(template, ensure_ascii=False, indent=2), encoding="utf-8")

def scan_omr_card(raw: bytes) -> set[int]:
    """Run the vendored OMRChecker engine and return relative marked slots 1..150."""
    if not OMR_ROOT.exists():
        raise ValueError("OMR 识别组件未安装，请重新打开本项目后重试。")
    try:
        from PIL import Image
        Image.open(io.BytesIO(raw)).verify()
    except Exception as exc:
        raise ValueError("图片无法读取，请上传清晰的 JPG、PNG 或拍照图片。") from exc
    ensure_omr_assets()
    # OpenCV on Windows cannot reliably open non-ASCII paths. Use the system
    # temp directory (ASCII on the bundled desktop setup) for OMRChecker's
    # image files, while keeping user data in the normal application folder.
    run_dir = Path(tempfile.mkdtemp(prefix="wordtrail-omr-"))
    input_dir, output_dir = run_dir / "input", run_dir / "output"
    try:
        input_dir.mkdir(parents=True)
        shutil.copy2(OMR_TEMPLATE_FILE, input_dir / "template.json")
        shutil.copy2(OMR_MARKER_FILE, input_dir / OMR_MARKER_FILE.name)
        shutil.copy2(OMR_CONFIG_FILE, input_dir / "config.json")
        image = Image.open(io.BytesIO(raw)).convert("RGB")
        image.save(input_dir / "upload.png", format="PNG", optimize=True)
        command = [sys.executable, str(OMR_ROOT / "main.py"), "--inputDir", str(input_dir), "--outputDir", str(output_dir)]
        # OMRChecker logs file paths. Explicit UTF-8 keeps a desktop folder
        # such as “词轨_最终版” from turning a successful run into a GBK decode error.
        completed = subprocess.run(command, cwd=OMR_ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=35, check=False,
                                   env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
        result_files = list((output_dir / "Results").glob("*.csv"))
        if completed.returncode != 0 or not result_files:
            raise ValueError("未能定位答题卡。请平铺整页、避免反光，并完整拍到四个黑色定位角后重试。")
        with result_files[0].open(encoding="utf-8-sig", newline="") as stream:
            rows = list(csv.DictReader(stream))
        if not rows:
            raise ValueError("未读到答题卡结果。请重新拍摄整张勾选卡后上传。")
        response = rows[-1]
        return {index for index in range(1, CARDS_PER_PAGE + 1) if response.get(f"q{index}") == "X"}
    except subprocess.TimeoutExpired as exc:
        raise ValueError("识别时间过长，请上传更清晰、只包含一张勾选卡的图片。") from exc
    finally:
        shutil.rmtree(run_dir, ignore_errors=True)

def find_by_id(items: list[dict], item_id: str) -> dict | None:
    return next((item for item in items if item["id"] == item_id), None)

def find_plan(data: dict, plan_id: str | None = None) -> dict:
    plan = find_by_id(data["plans"], plan_id or data.get("active_plan_id"))
    if not plan: raise ValueError("找不到学习计划")
    return plan

def plan_words(data: dict, plan: dict, frozen: bool = False) -> list[dict]:
    book = find_by_id(data["wordbooks"], plan["wordbook_id"])
    ids = plan["week"].get("frozen_word_ids") if frozen and plan["week"].get("frozen_word_ids") else plan["week"]["word_ids"]
    lookup = {word["id"]: word for word in book["words"]}
    return [lookup[x] for x in ids if x in lookup]

def build_cycle(plan: dict, book: dict) -> dict | None:
    cycles = plan.setdefault("cycles", [])
    target = max(1, int(plan.get("weekly_target") or len(book["words"]) or 1))
    prior_ids = [word_id for cycle in cycles for word_id in cycle.get("new_word_ids", [])]
    unseen = [word["id"] for word in book["words"] if word["id"] not in prior_ids]
    if not unseen: return None
    number = len(cycles) + 1
    history = [word_id for cycle in cycles for word_id in cycle.get("word_ids", [])]
    review_count = min(len(history), max(1, round(target * .1))) if number > 1 else 0
    new_count = min(len(unseen), max(1, target - review_count))
    if len(unseen) < target - review_count:
        review_count = min(len(history), max(0, target - new_count))
    wrong_first = [word_id for cycle in reversed(cycles) for word_id in cycle.get("wrong_word_ids", [])]
    pool = list(dict.fromkeys(wrong_first + list(reversed(history))))
    review = random.Random(f"{plan['id']}:review:{number}").sample(pool, min(review_count, len(pool))) if review_count else []
    new_words = unseen[:new_count]
    all_words = new_words + review
    random.Random(f"{plan['id']}:cycle:{number}").shuffle(all_words)
    cycle = {"id": new_id("week"), "number": number, "word_ids": all_words, "new_word_ids": new_words, "previous_word_ids": review, "frozen_word_ids": [], "papers": [], "status": "active", "created_at": now()}
    cycles.append(cycle); plan["week"] = cycle
    return cycle

def estimate_cycles(total: int, weekly_target: int) -> int:
    if total <= 0: return 0
    if total <= weekly_target: return 1
    old = max(1, round(weekly_target * .1))
    return 1 + math.ceil((total - weekly_target) / max(1, weekly_target - old))

def cycle_grade(cycle: dict) -> str:
    papers = cycle.get("papers", [])
    first = next((paper for paper in papers if paper["version"] == 1), None)
    second = next((paper for paper in papers if paper["version"] == 2), None)
    if not first or not second or "wrong_numbers" not in first or "wrong_numbers" not in second: return ""
    first_score = 1 - len(first["wrong_numbers"]) / max(1, len(first["items"]))
    second_score = 1 - len(second["wrong_numbers"]) / max(1, len(second["items"]))
    score = round((first_score * .6 + second_score * .4) * 100)
    cycle["score"] = score
    cycle["wrong_word_ids"] = [item["word"]["id"] for item in second["items"] if item["no"] in second["wrong_numbers"]]
    if score >= 95 and not second["wrong_numbers"]: return "S+"
    if score >= 90: return "S"
    if score >= 80: return "A"
    if score >= 70: return "B"
    if score >= 60: return "C"
    return "D"

def json_hash(value: object) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:16]

def column_index(cell_ref: str) -> int:
    letters = re.sub(r"\d", "", cell_ref)
    out = 0
    for char in letters: out = out * 26 + ord(char.upper()) - 64
    return out - 1

def parse_xlsx(raw: bytes) -> list[tuple[str, list[list[str]]]]:
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        shared = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            shared = ["".join(node.itertext()) for node in root]
        sheets = [name for name in archive.namelist() if name.startswith("xl/worksheets/sheet") and name.endswith(".xml")]
        if not sheets: raise ValueError("XLSX 中没有可读取的工作表")
        results = []
        for sheet_number, sheet in enumerate(sorted(sheets), 1):
            root = ET.fromstring(archive.read(sheet)); ns = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}; rows = []
            for row in root.findall(".//x:sheetData/x:row", ns):
                values = []
                for cell in row.findall("x:c", ns):
                    idx = column_index(cell.get("r", "A1"))
                    while len(values) <= idx: values.append("")
                    value = cell.findtext("x:v", default="", namespaces=ns)
                    if cell.get("t") == "s" and value: value = shared[int(value)]
                    elif cell.get("t") == "inlineStr": value = "".join(cell.itertext())
                    values[idx] = value.strip()
                if any(values): rows.append(values)
            if rows: results.append((f"工作表 {sheet_number}", rows))
    return results

FIELD_ALIASES = {
    "单词":"word", "英文":"word", "英语":"word", "词汇":"word", "word":"word", "english":"word", "term":"word",
    "释义":"meaning", "中文":"meaning", "翻译":"meaning", "definition":"meaning", "translation":"meaning", "meaning":"meaning",
    "音标":"phonetic", "phonetic":"phonetic", "词性":"part_of_speech", "partofspeech":"part_of_speech", "例句":"example", "备注":"note", "notes":"note",
}

def canonical_field(value: object) -> str:
    key = re.sub(r"[\s_-]+", "", str(value or "").strip().lower())
    return FIELD_ALIASES.get(key, key)

WORD_PATTERN = re.compile(r"(?i)(?<![a-z0-9])([a-z]+(?:[-'][a-z]+)*)(?![a-z0-9])")

def normalized_word(value: str) -> str:
    return value.strip().replace("’", "'").lower()

def extract_word(value: object) -> str | None:
    text = str(value or "").replace("\u200b", "").strip().strip("\"'“”‘’（）()[]")
    match = WORD_PATTERN.search(text)
    return match.group(1) if match else None

def decode_text(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-16", "gb18030"):
        try: return raw.decode(encoding)
        except UnicodeDecodeError: pass
    return raw.decode("utf-8", errors="replace")

def compact_meanings(value: str) -> str:
    parts = []
    for line in str(value or "").replace("\\n", "\n").splitlines():
        line = re.sub(r"\[.*?\]", "", line).strip(" ，,;；")
        if not line or line.startswith("["): continue
        prefix = re.match(r"^((?:n|v|vi|vt|adj|adv|prep|conj|pron|art|aux)\.)\s*", line, re.I)
        senses = [piece.strip(" ，,;；") for piece in re.split(r"[；;,，]", line[prefix.end():] if prefix else line) if piece.strip(" ，,;；")]
        for index, sense in enumerate(senses):
            parts.append(f"{prefix.group(1)} {sense}" if prefix and index == 0 else sense)
            if len(parts) == 3: break
        if len(parts) == 3: break
    return "；".join(parts)

def dictionary() -> dict[str, dict]:
    global _DICTIONARY
    if _DICTIONARY is not None: return _DICTIONARY
    entries: dict[str, dict] = {}
    if not DICTIONARY_FILE.exists():
        _DICTIONARY = entries
        return entries
    with DICTIONARY_FILE.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            word = str(row.get("word") or "").strip()
            meaning = compact_meanings(row.get("translation") or "")
            key = normalized_word(word)
            if key and meaning and key not in entries:
                entries[key] = {"lemma": word, "meaning": meaning, "phonetic": str(row.get("phonetic") or "").strip(), "part_of_speech": str(row.get("pos") or "").strip(), "definition": compact_meanings(row.get("definition") or "")}
    _DICTIONARY = entries
    return entries

def dictionary_lookup(word: str) -> dict | None:
    return dictionary().get(normalized_word(word))

def study_examples(word: str, hit: dict | None) -> list[str]:
    definition = (hit or {}).get("definition", "")
    lead = definition.split("；")[0] if definition else "its common meaning"
    return [f"I reviewed “{word}” in today's lesson.", f"The common sense of “{word}” is: {lead}.", f"Please recall “{word}” before moving on."]

def candidate(word: str, source: str) -> dict | None:
    cleaned = extract_word(word)
    if not cleaned: return None
    return {"word": cleaned, "normalized": normalized_word(cleaned), "source": source}

def candidates_from_rows(rows: list[list[str]], source_name: str) -> list[dict]:
    if not rows: return []
    headers = [canonical_field(cell) for cell in rows[0]]
    word_columns = [index for index, name in enumerate(headers) if name == "word"]
    start = 1 if word_columns or "word" in headers else 0
    found = []
    for row_number, row in enumerate(rows[start:], start + 1):
        cells = [row[index] for index in word_columns if index < len(row)] if word_columns else row
        for cell in cells:
            item = candidate(cell, f"{source_name} · 第 {row_number} 行")
            if item:
                found.append(item)
                break
    return found

def parse_xls(raw: bytes) -> list[tuple[str, list[list[str]]]]:
    vendor = ROOT / "vendor"
    if str(vendor) not in sys.path: sys.path.insert(0, str(vendor))
    try: import xlrd
    except ImportError as exc: raise ValueError("缺少 XLS 读取组件，请重新安装词轨完整文件") from exc
    try: workbook = xlrd.open_workbook(file_contents=raw)
    except Exception as exc: raise ValueError("无法读取 XLS 文件，请确认文件未损坏或加密") from exc
    return [(sheet.name or f"工作表 {index + 1}", [[str(cell.value).strip() for cell in sheet.row(row)] for row in range(sheet.nrows)]) for index, sheet in enumerate(workbook.sheets())]

def candidates_from_json(value: object, path: str = "$") -> list[dict]:
    found = []
    if isinstance(value, str):
        item = candidate(value, path)
        return [item] if item else []
    if isinstance(value, list):
        for index, child in enumerate(value): found.extend(candidates_from_json(child, f"{path}[{index}]"))
        return found
    if isinstance(value, dict):
        preferred = next((value[key] for key in value if canonical_field(key) == "word"), None)
        if preferred is not None:
            item = candidate(preferred, path)
            return [item] if item else []
        containers = [key for key in value if canonical_field(key) in {"words", "data", "items", "vocabulary", "list"}]
        if containers:
            for key in containers: found.extend(candidates_from_json(value[key], f"{path}.{key}"))
            return found
        ignored = {"meaning", "phonetic", "part_of_speech", "example", "note"}
        for key, child in value.items():
            if canonical_field(key) not in ignored: found.extend(candidates_from_json(child, f"{path}.{key}"))
    return found

def import_candidates(filename: str, content_b64: str) -> list[dict]:
    raw = base64.b64decode(content_b64.split(",")[-1]); suffix = Path(filename).suffix.lower(); found = []
    if suffix == ".txt":
        for line_number, line in enumerate(decode_text(raw).splitlines(), 1):
            line = line.strip()
            if not line or line.startswith(("#", "//")) or canonical_field(line) == "word": continue
            item = candidate(line, f"第 {line_number} 行")
            if item: found.append(item)
    elif suffix == ".csv":
        sample = decode_text(raw)
        try: dialect = csv.Sniffer().sniff(sample[:4096], delimiters=",，;；\t")
        except csv.Error: dialect = csv.excel
        found = candidates_from_rows(list(csv.reader(io.StringIO(sample), dialect)), "CSV")
    elif suffix == ".xlsx":
        for sheet, rows in parse_xlsx(raw): found.extend(candidates_from_rows(rows, sheet))
    elif suffix == ".xls":
        for sheet, rows in parse_xls(raw): found.extend(candidates_from_rows(rows, sheet))
    elif suffix == ".json":
        try: found = candidates_from_json(json.loads(decode_text(raw)))
        except json.JSONDecodeError as exc: raise ValueError("JSON 格式不正确") from exc
    else: raise ValueError("只支持 TXT、JSON、CSV、XLS 或 XLSX 文件")
    if not found: raise ValueError("未识别到英文单词。请确认文件中包含英文词条。")
    return found

def prepared_import(filename: str, content_b64: str, selected_words: list[str] | None = None) -> tuple[list[dict], dict]:
    selected = {normalized_word(word) for word in selected_words} if selected_words is not None else None
    seen, records, duplicates, matched = set(), [], 0, 0
    for item in import_candidates(filename, content_b64):
        key = item["normalized"]
        if selected is not None and key not in selected: continue
        if key in seen:
            duplicates += 1
            continue
        seen.add(key)
        hit = dictionary_lookup(item["word"])
        if hit: matched += 1
        records.append({
            "id": new_id("w"), "word": item["word"], "meaning": hit["meaning"] if hit else "", "phonetic": hit["phonetic"] if hit else "", "part_of_speech": hit["part_of_speech"] if hit else "", "example": "", "note": "", "source_row": item["source"],
            "normalized_word": key, "dictionary_lemma": hit["lemma"] if hit else "", "dictionary_senses": [hit["meaning"]] if hit else [], "meaning_source": "dictionary" if hit else "unresolved", "dictionary_version": DICTIONARY_VERSION if hit else "", "match_status": "matched" if hit else "unresolved",
        })
    if not records: raise ValueError("请至少保留 1 个可导入的英文词")
    return records, {"candidate_count": len(records), "duplicate_count": duplicates, "matched_count": matched, "unresolved_count": len(records) - matched}

def manual_word_record(value: str) -> dict | None:
    word = extract_word(value)
    if not word: return None
    hit = dictionary_lookup(word)
    return {"id": new_id("w"), "word": word, "meaning": hit["meaning"] if hit else "", "phonetic": hit["phonetic"] if hit else "", "part_of_speech": hit["part_of_speech"] if hit else "", "example": "", "note": "", "source_row": "手动添加", "normalized_word": normalized_word(word), "dictionary_lemma": hit["lemma"] if hit else "", "dictionary_senses": [hit["meaning"]] if hit else [], "meaning_source": "dictionary" if hit else "unresolved", "dictionary_version": DICTIONARY_VERSION if hit else "", "match_status": "matched" if hit else "unresolved"}

def draw_page_header(pdf, title: str, meta: str, page: int) -> None:
    width, height = A4
    pdf.setStrokeColorRGB(.15, .27, .45); pdf.setLineWidth(.6); pdf.line(18*mm, height-19*mm, width-18*mm, height-19*mm)
    pdf.setFillColorRGB(.06, .14, .25); pdf.setFont(FONT, 18); pdf.drawString(18*mm, height-15*mm, title)
    pdf.setFillColorRGB(.35, .41, .46); pdf.setFont(FONT, 8.5); pdf.drawRightString(width-18*mm, height-14.5*mm, meta)
    pdf.drawRightString(width-18*mm, 12*mm, f"词轨 Wordtrail · {page}")

def trim(text: str, limit: int) -> str:
    text = str(text or "")
    return text if len(text) <= limit else text[:limit-1] + "…"

def create_study_pdf(path: Path, plan: dict, words: list[dict]) -> None:
    pdf = canvas.Canvas(str(path), pagesize=A4); width, height = A4
    page_count = max(1, -(-len(words)//ITEMS_PER_PAGE))
    for page in range(1, page_count+1):
        page_words = words[(page-1)*ITEMS_PER_PAGE:page*ITEMS_PER_PAGE]
        y = height-37*mm
        draw_page_header(pdf, "背诵表", f"{plan['name']} · {plan['start_week']} · {now()}", page)
        pdf.setFillColorRGB(.22,.35,.48); pdf.setFont(FONT,8); labels=["序号","单词","音标 / 词性","释义","已熟悉","笔记"]; xs=[18,31,70,112,164,181]
        for x,label in zip(xs,labels): pdf.drawString(x*mm,y,label)
        pdf.setStrokeColorRGB(.78,.82,.83); pdf.line(18*mm,y-2*mm,width-18*mm,y-2*mm)
        for offset, word in enumerate(page_words):
            index = (page-1)*ITEMS_PER_PAGE + offset + 1; y -= 7*mm
            pdf.setFillColorRGB(0,0,0); pdf.setFont(FONT,8.5); pdf.drawString(18*mm,y,str(index).zfill(2)); pdf.setFont(LATIN_FONT,8.5); pdf.drawString(31*mm,y,trim(word['word'],22)); pdf.setFont(LATIN_FONT,7); pdf.setFillColorRGB(.31,.40,.47)
            pdf.drawString(70*mm,y,trim((word.get('phonetic','')+' '+word.get('part_of_speech','')).strip(),27)); pdf.setFillColorRGB(0,0,0); pdf.setFont(FONT,8.5); pdf.drawString(112*mm,y,trim(word.get('meaning',''),23))
            pdf.rect(166*mm,y-2*mm,3.5*mm,3.5*mm,stroke=1,fill=0); pdf.setStrokeColorRGB(.82,.84,.84); pdf.line(181*mm,y-.8*mm,width-18*mm,y-.8*mm)
        pdf.setFillColorRGB(.35,.41,.46); pdf.setFont(FONT,8); pdf.drawString(18*mm,18*mm,f"本页 {len(page_words)} 词 · 每页最多 {ITEMS_PER_PAGE} 词")
        if page < page_count: pdf.showPage()
    pdf.save()

def draw_omr_marker(pdf: canvas.Canvas, center_x: float, center_y: float) -> None:
    """Draw the same bullseye used by OMRChecker's CropOnMarkers processor."""
    for radius, fill in ((4, 1), (2.45, 0), (1.35, 1), (.55, 0), (.28, 1)):
        pdf.setFillColorRGB(0 if fill else 1, 0 if fill else 1, 0 if fill else 1)
        pdf.circle(center_x * mm, center_y * mm, radius * mm, stroke=0, fill=1)

def card_qr_payload(plan: dict, paper: dict, card_page: int) -> str:
    """Stable, self-checking page identity embedded in every answer card."""
    unsigned = "|".join(("WT1", plan["id"], plan["week"]["id"], paper["id"], str(paper["version"]), str(card_page)))
    checksum = hashlib.sha256(unsigned.encode("utf-8")).hexdigest()[:12]
    return f"{unsigned}|{checksum}"

def parse_card_qr(payload: str) -> dict | None:
    fields = payload.strip().split("|")
    if len(fields) != 7 or fields[0] != "WT1": return None
    unsigned = "|".join(fields[:-1])
    if hashlib.sha256(unsigned.encode("utf-8")).hexdigest()[:12] != fields[-1]: return None
    try: version, card_page = int(fields[4]), int(fields[5])
    except ValueError: return None
    return {"plan_id": fields[1], "week_id": fields[2], "paper_id": fields[3], "version": version, "card_page": card_page}

def read_card_qr(raw: bytes) -> dict | None:
    """Read the page identity before interpreting any marked answer bubbles."""
    import cv2
    import numpy as np
    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None: return None
    detector = cv2.QRCodeDetector()
    text, _points, _straight = detector.detectAndDecode(image)
    return parse_card_qr(text) if text else None

def draw_card_qr(pdf: canvas.Canvas, payload: str, x: float, y: float, size: float) -> None:
    widget = qr.QrCodeWidget(payload)
    x0, y0, x1, y1 = widget.getBounds()
    drawing = Drawing(size, size, transform=[size / (x1 - x0), 0, 0, size / (y1 - y0), 0, 0])
    drawing.add(widget)
    renderPDF.draw(drawing, pdf, x, y)

def create_exam_pdf(path: Path, plan: dict, paper: dict, answer: bool = False) -> None:
    pdf = canvas.Canvas(str(path), pagesize=A4); width, height = A4
    title = paper.get("label", f"考试表 {paper['version']}") + (" · 答案表" if answer else "")
    items = paper['items']; page_count = max(1, -(-len(items)//ITEMS_PER_PAGE))
    for page in range(1, page_count+1):
        page_items = items[(page-1)*ITEMS_PER_PAGE:page*ITEMS_PER_PAGE]
        draw_page_header(pdf, title, f"{plan['name']} · {plan['start_week']} · {now()}", page)
        if not answer:
            # A compact 30-row answer table: every blank has a learning purpose.
            pdf.setFillColorRGB(.32,.39,.45); pdf.setFont(FONT,8)
            pdf.drawString(18*mm,height-29*mm,"姓名：__________________    日期：__________________    看英文填写常用中文义；完成后在独立的错题勾选卡标记错题。")
            top, row_h = height-36*mm, 7*mm; xs=[18,31,75,159,176,192]
            labels=["序号","英文单词","中文释义（手写）","把握","复盘"]
            pdf.setFillColorRGB(.22,.35,.48); pdf.setFont(FONT,8)
            for x, label in zip(xs, labels): pdf.drawString(x*mm, top, label)
            pdf.setStrokeColorRGB(.67,.73,.74); pdf.setLineWidth(.45)
            for x in xs: pdf.line(x*mm, top-2*mm, x*mm, top-(len(page_items)*row_h+2)*mm)
            pdf.line(18*mm,top-2*mm,width-18*mm,top-2*mm)
            for offset, item in enumerate(page_items):
                y=top-(offset+1)*row_h; word=item['word']
                pdf.setFillColorRGB(.06,.14,.25); pdf.setFont(FONT,8.5); pdf.drawString(19*mm,y+1.8*mm,str(item['no']).zfill(2))
                pdf.setFont(LATIN_FONT,9); pdf.drawString(32*mm,y+1.8*mm,trim(word['word'],24))
                pdf.setStrokeColorRGB(.60,.66,.69); pdf.setLineWidth(.3); pdf.line(77*mm,y+1.2*mm,157*mm,y+1.2*mm)
                pdf.setFillColorRGB(.34,.42,.48); pdf.setFont(FONT,7); pdf.drawString(160*mm,y+1.6*mm,"□ 熟 □ 犹豫")
                pdf.drawString(177*mm,y+1.6*mm,"□ 复习")
                pdf.setStrokeColorRGB(.76,.80,.80); pdf.setLineWidth(.35); pdf.line(18*mm,y-2*mm,width-18*mm,y-2*mm)
        else:
            y = height-37*mm
            pdf.setFillColorRGB(.22,.35,.48); pdf.setFont(FONT,8); pdf.drawString(18*mm,height-31*mm,"题号"); pdf.drawString(33*mm,height-31*mm,"单词"); pdf.drawString(76*mm,height-31*mm,"音标 / 词性"); pdf.drawString(122*mm,height-31*mm,"释义")
            pdf.setStrokeColorRGB(.78,.82,.83); pdf.line(18*mm,height-33*mm,width-18*mm,height-33*mm)
            for item in page_items:
                y -= 7*mm; word = item['word']; pdf.setFillColorRGB(.06,.14,.25)
                pdf.setFont(FONT,8.5); pdf.drawString(18*mm,y,str(item['no']).zfill(2)); pdf.setFont(LATIN_FONT,8.5); pdf.drawString(33*mm,y,trim(word['word'],28)); pdf.setFont(LATIN_FONT,7); pdf.setFillColorRGB(.31,.40,.47); pdf.drawString(76*mm,y,trim((word.get('phonetic','')+' '+word.get('part_of_speech','')).strip(),29)); pdf.setFillColorRGB(0,0,0); pdf.setFont(FONT,8.5); pdf.drawString(122*mm,y,trim(word.get('meaning',''),27)); pdf.setStrokeColorRGB(.85,.87,.87); pdf.line(18*mm,y-2.5*mm,width-18*mm,y-2.5*mm)
        if not answer:
            pdf.setFillColorRGB(.35,.41,.46); pdf.setFont(FONT,8); pdf.drawString(18*mm,18*mm,"本页 30 题 · 请将错题统一标记在试题后的「错题勾选卡」。")
        if page < page_count or not answer: pdf.showPage()
    # The error card never shares a page with test questions. Its geometry is
    # mirrored by ensure_omr_assets(), so OMRChecker can align a phone photo.
    if not answer:
        cards_per_page, card_pages = CARDS_PER_PAGE, max(1, -(-len(items)//CARDS_PER_PAGE))
        for card_page in range(1, card_pages+1):
            card_items=items[(card_page-1)*cards_per_page:card_page*cards_per_page]
            draw_page_header(pdf, f"{paper.get('label','考试')} · 错题勾选卡", f"第 {card_page} / {card_pages} 张 · 请完整拍摄此页", page_count+card_page)
            for x,y in [(10,10),(200,10),(10,287),(200,287)]: draw_omr_marker(pdf, x, y)
            pdf.setFillColorRGB(.22,.35,.48); pdf.setFont(FONT,9); pdf.drawString(18*mm,height-29*mm,"答错时涂满左侧圆圈；右侧圆圈请留空。上传时请平拍整页并拍清四个黑色定位角。")
            cols, cell_w, cell_h, start_x, top_y = CARD_COLUMNS, 17.4*mm, 13.5*mm, 18*mm, height-41*mm
            for index,item in enumerate(card_items):
                row,col=divmod(index,cols); x=start_x+col*cell_w; y=top_y-(row+1)*cell_h
                pdf.setStrokeColorRGB(.50,.59,.63); pdf.setLineWidth(.55); pdf.rect(x,y,cell_w,cell_h,stroke=1,fill=0)
                pdf.setStrokeColorRGB(.28,.35,.39); pdf.setLineWidth(.5)
                pdf.circle(x+3.2*mm,y+6.5*mm,1.7*mm,stroke=1,fill=0)
                pdf.circle(x+7.7*mm,y+6.5*mm,1.7*mm,stroke=1,fill=0)
                pdf.setFillColorRGB(.06,.14,.25); pdf.setFont(FONT,8); pdf.drawString(x+11.2*mm,y+5.1*mm,str(item['no']).zfill(3))
            draw_card_qr(pdf, card_qr_payload(plan, paper, card_page), 18*mm, 22*mm, 18*mm)
            pdf.setFillColorRGB(.35,.41,.46); pdf.setFont(FONT,7.6); pdf.drawString(39*mm,28*mm,"页面核验码：上传时自动确认本考试与本答题卡页码")
            pdf.setFont(FONT,8); pdf.drawString(39*mm,18*mm,f"错题勾选卡 {card_page}/{card_pages} · 共 {len(card_items)} 题 · OMR 模板 WT-OMR-QR-2026.09")
            if card_page < card_pages: pdf.showPage()
    pdf.save()

def paper_for_version(data: dict, plan: dict, version: int) -> dict:
    papers = plan['week']['papers']; existing = next((p for p in papers if p['version'] == version), None)
    if existing: return existing
    words = plan_words(data, plan, frozen=True)
    if version == 1:
        if not words: raise ValueError("请先至少加入 1 个本周词条")
        plan['week']['frozen_word_ids'] = list(plan['week']['word_ids']); words = plan_words(data, plan, frozen=True)
        random.Random(plan['id']).shuffle(words); item_types = ['base'] * len(words)
    else:
        if version != 2: raise ValueError("v1.3 每个周期只包含周测与一次复测")
        previous = next((p for p in papers if p['version'] == version-1), None)
        if not previous or 'wrong_numbers' not in previous: raise ValueError(f"请先提交考试表 {version-1} 的错词")
        wrong_set = set(previous['wrong_numbers']); wrong = [item['word'] for item in previous['items'] if item['no'] in wrong_set]
        correct = [item['word'] for item in previous['items'] if item['no'] not in wrong_set]
        sample_count = max(1, -(-len(correct)//5)) if correct else 0
        review = random.Random(f"{plan['id']}:{version}:{previous.get('result_at','')}").sample(correct, min(sample_count, len(correct)))
        words, item_types = wrong + review, ['error']*len(wrong) + ['review']*len(review)
        paired = list(zip(words, item_types)); random.Random(f"shuffle:{plan['id']}:{version}").shuffle(paired); words, item_types = map(list, zip(*paired)) if paired else ([], [])
    paper = {"id":new_id("paper"),"version":version,"label":"周测" if version == 1 else "复测","created_at":now(),"items":[{"no":i+1,"word":word,"source_type":item_types[i]} for i,word in enumerate(words)]}
    papers.append(paper); return paper

def document_for(data: dict, plan: dict, kind: str, version: int | None = None) -> dict:
    paper = paper_for_version(data, plan, version) if kind in ('exam','answer') else None
    snapshot = {"kind":kind,"plan":plan['id'],"week":plan['week']['id'],"version":version,"words":paper['items'] if paper else plan_words(data,plan),"template":"v7-omrchecker-qr-150-per-page-card"}
    key = json_hash(snapshot)
    existing = next((d for d in data['documents'] if d['content_hash'] == key and d['status'] == 'ready'), None)
    if existing: return existing
    peers = [d for d in data['documents'] if d['plan_id'] == plan['id'] and d['type'] == kind and d.get('exam_version') == version]
    revision = len(peers)+1
    label = {'study':'背诵表','exam':f'考试表{version}','answer':f'考试表{version}_答案'}[kind]
    filename = f"{safe_name(plan['name'])}_{plan['start_week']}_{label}_rev.{revision}.pdf"; target = DOC_DIR / filename
    if kind == 'study': create_study_pdf(target, plan, plan_words(data,plan, frozen=bool(plan['week'].get('frozen_word_ids'))))
    else: create_exam_pdf(target, plan, paper, answer=kind == 'answer')
    record = {"id":new_id("doc"),"type":kind,"label":label,"plan_id":plan['id'],"week_id":plan['week']['id'],"exam_version":version,"revision":revision,"file_name":filename,"file_key":filename,"content_hash":key,"status":"ready","created_at":now(),"snapshot":snapshot}
    data['documents'].insert(0,record); return record

class AppHandler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs): super().__init__(*args,directory=str(ROOT),**kwargs)
    def log_message(self, fmt, *args): print("[wordtrail]", fmt % args)
    def send_json(self, payload, status=200):
        raw = json.dumps(payload, ensure_ascii=False).encode(); self.send_response(status); self.send_header("Content-Type","application/json; charset=utf-8"); self.send_header("Content-Length",str(len(raw))); self.end_headers(); self.wfile.write(raw)
    def read_json(self):
        size = int(self.headers.get('Content-Length','0')); return json.loads(self.rfile.read(size).decode('utf-8'))
    def document_payload(self, doc):
        output = dict(doc); output['download_url'] = f"/api/documents/{doc['id']}/download"; output['preview_url'] = f"/api/documents/{doc['id']}/preview"; output.pop('snapshot',None); return output
    def state_payload(self, data):
        output = {"wordbooks":[{"id":b['id'],"name":b['name'],"created_at":b['created_at'],"word_count":len(b['words']),"matched_count":sum(1 for w in b['words'] if w.get('meaning_source') == 'dictionary'),"unresolved_count":sum(1 for w in b['words'] if w.get('meaning_source') == 'unresolved'),"words":b['words']} for b in data['wordbooks']],"plans":data['plans'],"active_plan_id":data.get('active_plan_id'),"documents":[self.document_payload(d) for d in data['documents']]}
        return output
    def do_GET(self):
        parsed = urlparse(self.path); path = unquote(parsed.path); data = load_data()
        if path == '/api/state': return self.send_json(self.state_payload(data))
        if path == '/api/dictionary/lookup':
            word = parse_qs(parsed.query).get('word', [''])[0]
            hit = dictionary_lookup(word)
            return self.send_json({"word": word, "dictionary_version": DICTIONARY_VERSION, "match_status": "matched" if hit else "unresolved", "lemma": hit['lemma'] if hit else "", "phonetic": hit['phonetic'] if hit else "", "part_of_speech": hit['part_of_speech'] if hit else "", "display_meanings": hit['meaning'] if hit else ""})
        match = re.fullmatch(r'/api/exams/(\d+)/online', path)
        if match:
            plan = find_plan(data, parse_qs(parsed.query).get('plan_id', [None])[0]); paper = paper_for_version(data, plan, int(match.group(1)))
            try: index = int(parse_qs(parsed.query).get('index', ['0'])[0])
            except ValueError: index = 0
            if index < 0 or index >= len(paper['items']): return self.send_json({'error':'题号超出范围'},400)
            item = paper['items'][index]; word = item['word']
            # Return one question only. This keeps a large legacy wordbook from
            # creating an enormous O(n²) response and lets the test stay usable.
            meanings = list(dict.fromkeys(candidate['meaning'] for book in data['wordbooks'] for candidate in book['words'] if candidate['id'] != word['id'] and candidate.get('meaning')))
            if len(meanings) < 2:
                meanings.extend(entry['meaning'] for entry in dictionary().values() if entry.get('meaning') and entry['meaning'] != word.get('meaning'))
            random.Random(f"{paper['id']}:{item['no']}").shuffle(meanings)
            choices = list(dict.fromkeys([word.get('meaning') or '尚未补全释义'] + meanings))[:3]
            random.Random(f"choices:{paper['id']}:{item['no']}").shuffle(choices)
            hit = dictionary_lookup(word['word']); question = {"no":item['no'],"word":word['word'],"choices":choices,"answer":word.get('meaning') or '尚未补全释义',"meaning":word.get('meaning',''),"phonetic":word.get('phonetic',''),"part_of_speech":word.get('part_of_speech',''),"examples":study_examples(word['word'],hit)}
            save_data(data); return self.send_json({"paper":{"version":paper['version'],"label":paper.get('label','周测')},"question":question,"index":index,"total":len(paper['items'])})
        if path == '/api/template':
            raw = 'word\nresilient\nabandon 放弃\nbenefit,好处\n'.encode('utf-8-sig')
            self.send_response(200); self.send_header('Content-Type','text/csv; charset=utf-8'); self.send_header('Content-Disposition','attachment; filename="wordtrail_template.csv"'); self.send_header('Content-Length',str(len(raw))); self.end_headers(); return self.wfile.write(raw)
        match = re.fullmatch(r'/api/documents/([^/]+)/(download|preview)', path)
        if match:
            doc = find_by_id(data['documents'], match.group(1))
            file = DOC_DIR / doc['file_key'] if doc else None
            if not doc or not file.exists(): return self.send_json({'error':'文档不存在'},404)
            raw = file.read_bytes(); self.send_response(200); self.send_header('Content-Type','application/pdf'); disposition = 'attachment' if match.group(2) == 'download' else 'inline'; fallback = 'wordtrail.pdf'; encoded_name = quote(doc['file_name']); self.send_header('Content-Disposition',f"{disposition}; filename=\"{fallback}\"; filename*=UTF-8''{encoded_name}"); self.send_header('Content-Length',str(len(raw))); self.end_headers(); return self.wfile.write(raw)
        if path == '/': self.path = '/index.html'
        return super().do_GET()
    def do_POST(self):
        try:
            path = urlparse(self.path).path; body = self.read_json(); data = load_data()
            if path == '/api/import/preview':
                words, summary = prepared_import(body.get('filename',''), body.get('content',''))
                preview = [{"word": word['word'], "normalized_word": word['normalized_word'], "meaning": word['meaning'], "phonetic": word['phonetic'], "part_of_speech": word['part_of_speech'], "source": word['source_row'], "match_status": word['match_status'], "dictionary_lemma": word['dictionary_lemma']} for word in words]
                return self.send_json({"preview": preview, "summary": summary, "dictionary_version": DICTIONARY_VERSION})
            if path in ('/api/import/confirm', '/api/import'):
                words, summary = prepared_import(body.get('filename',''), body.get('content',''), body.get('selected_words'))
                if body.get('shuffle'):
                    random.SystemRandom().shuffle(words)
                book = {'id':new_id('wb'),'name':body.get('name') or Path(body.get('filename','')).stem or '未命名词表','created_at':now(),'words':words,'dictionary_version':DICTIONARY_VERSION}
                data['wordbooks'].append(book); save_data(data)
                return self.send_json({'wordbook':{'id':book['id'],'name':book['name'],'word_count':len(words),**summary}})
            match = re.fullmatch(r'/api/wordbooks/([^/]+)$', path)
            if match:
                book = find_by_id(data['wordbooks'], match.group(1))
                if not book: raise ValueError('找不到词表')
                name = str(body.get('name','')).strip()
                if name: book['name'] = name
                additions = str(body.get('add_words','')).splitlines()
                known = {word['normalized_word'] for word in book['words']}
                for raw in additions:
                    record = manual_word_record(raw)
                    if record and record['normalized_word'] not in known:
                        book['words'].append(record); known.add(record['normalized_word'])
                save_data(data); return self.send_json({'wordbook':book})
            match = re.fullmatch(r'/api/wordbooks/([^/]+)/delete-words', path)
            if match:
                book = find_by_id(data['wordbooks'], match.group(1))
                if not book: raise ValueError('找不到词表')
                remove = set(body.get('word_ids', []))
                used = {word_id for plan in data['plans'] if plan['wordbook_id'] == book['id'] for cycle in plan.get('cycles', [plan.get('week', {})]) for word_id in cycle.get('word_ids', [])}
                if remove & used: raise ValueError('选中的词正在学习计划中使用；请先删除关联计划后再移除。')
                keep = [word for word in book['words'] if word['id'] not in remove]
                if not keep: raise ValueError('词表至少需保留 1 个词')
                book['words'] = keep; save_data(data); return self.send_json({'ok':True})
            match = re.fullmatch(r'/api/wordbooks/([^/]+)/delete', path)
            if match:
                book_id = match.group(1)
                if any(plan['wordbook_id'] == book_id for plan in data['plans']): raise ValueError('此词表仍关联学习计划；请先删除计划。')
                if not find_by_id(data['wordbooks'], book_id): raise ValueError('找不到词表')
                data['wordbooks'] = [book for book in data['wordbooks'] if book['id'] != book_id]; save_data(data); return self.send_json({'ok':True})
            if path == '/api/plans':
                book = find_by_id(data['wordbooks'],body.get('wordbook_id')); 
                if not book: raise ValueError('请选择有效词表')
                target = int(body.get('weekly_target') or 0)
                if target < 1: raise ValueError('请填写每周期至少学习 1 个词')
                plan = {'id':new_id('plan'),'name':body.get('name','未命名计划').strip() or '未命名计划','wordbook_id':book['id'],'start_week':body.get('start_week') or datetime.now().strftime('%Y-%m-%d'),'weekly_target':target,'estimated_cycles':estimate_cycles(len(book['words']),target),'status':'active','cycles':[],'created_at':now()}
                build_cycle(plan, book); data['plans'].append(plan); data['active_plan_id']=plan['id']; save_data(data); return self.send_json({'plan':plan})
            match = re.fullmatch(r'/api/plans/([^/]+)$', path)
            if match:
                plan = find_plan(data, match.group(1)); book = find_by_id(data['wordbooks'], plan['wordbook_id'])
                name = str(body.get('name','')).strip()
                if name: plan['name'] = name
                if body.get('start_week'): plan['start_week'] = body['start_week']
                if body.get('weekly_target') is not None:
                    target = int(body['weekly_target'])
                    if target < 1: raise ValueError('每周期数量至少为 1')
                    plan['weekly_target'] = target; plan['estimated_cycles'] = estimate_cycles(len(book['words']), target)
                save_data(data); return self.send_json({'plan':plan})
            match = re.fullmatch(r'/api/plans/([^/]+)/delete', path)
            if match:
                plan_id = match.group(1); find_plan(data, plan_id)
                data['plans'] = [plan for plan in data['plans'] if plan['id'] != plan_id]
                if data.get('active_plan_id') == plan_id: data['active_plan_id'] = data['plans'][0]['id'] if data['plans'] else None
                save_data(data); return self.send_json({'ok':True})
            if path == '/api/active-plan':
                find_plan(data,body.get('plan_id')); data['active_plan_id']=body['plan_id']; save_data(data); return self.send_json({'ok':True})
            match = re.fullmatch(r'/api/plans/([^/]+)/words',path)
            if match:
                plan = find_plan(data,match.group(1));
                if plan['week'].get('frozen_word_ids'): raise ValueError('考试表 1 已生成，本周词条已冻结')
                book=find_by_id(data['wordbooks'],plan['wordbook_id']); valid=[x for x in body.get('word_ids',[]) if find_by_id(book['words'],x)]
                if not valid: raise ValueError('请至少保留 1 个本周词条')
                plan['week']['word_ids']=valid; save_data(data); return self.send_json({'week':plan['week']})
            match = re.fullmatch(r'/api/exams/([^/]+)/result',path)
            if match:
                plan=find_plan(data,body.get('plan_id')); paper=next((p for p in plan['week']['papers'] if p['version']==int(match.group(1))),None)
                if not paper: raise ValueError('请先生成考试表')
                allowed={i['no'] for i in paper['items']}; paper['wrong_numbers']=sorted({int(x) for x in body.get('wrong_numbers',[]) if int(x) in allowed}); paper['result_at']=now()
                grade = ""
                if paper['version'] == 2:
                    grade = cycle_grade(plan['week']); plan['week']['grade'] = grade; plan['week']['status'] = 'completed'
                    book = find_by_id(data['wordbooks'], plan['wordbook_id'])
                    if build_cycle(plan, book) is None: plan['status'] = 'completed'
                save_data(data); return self.send_json({'paper':paper,'grade':grade,'next_cycle':plan.get('week',{}).get('number') if grade else None})
            match = re.fullmatch(r'/api/exams/([^/]+)/scan', path)
            if match:
                plan = find_plan(data, body.get('plan_id')); paper = next((p for p in plan['week']['papers'] if p['version'] == int(match.group(1))), None)
                if not paper: raise ValueError('请先生成周测或复测')
                try:
                    raw = base64.b64decode(str(body.get('image','')).split(',')[-1])
                except Exception as exc: raise ValueError('图片无法读取，请上传清晰的 JPG 或 PNG') from exc
                qr_identity = read_card_qr(raw)
                if not qr_identity:
                    raise ValueError('未读取到页面核验码。请上传新版错题勾选卡的完整照片，并确保左下角二维码清晰可见。')
                if qr_identity['plan_id'] != plan['id'] or qr_identity['week_id'] != plan['week']['id'] or qr_identity['paper_id'] != paper['id'] or qr_identity['version'] != paper['version']:
                    raise ValueError('这张勾选卡不属于当前考试，已拒绝导入；请上传对应考试表中的答题卡。')
                card_page = qr_identity['card_page']
                card_pages = max(1, -(-len(paper['items']) // CARDS_PER_PAGE))
                if card_page > card_pages: raise ValueError(f'本次考试仅有 {card_pages} 张勾选卡，请选择正确页码。')
                marked_slots = scan_omr_card(raw)
                start = (card_page - 1) * CARDS_PER_PAGE; card_items = paper['items'][start:start + CARDS_PER_PAGE]
                selected = [item['no'] for index, item in enumerate(card_items, 1) if index in marked_slots]
                return self.send_json({'suggested_wrong_numbers': selected, 'message': f'页面核验通过：这是当前考试的第 {card_page}/{card_pages} 张勾选卡；识别到 {len(selected)} 个错词。请在题号网格中核对后保存。'})
            if path == '/api/documents/generate':
                plan=find_plan(data,body.get('plan_id')); kind=body.get('type'); version=body.get('exam_version', body.get('version'))
                if kind not in ('study','exam','answer'): raise ValueError('未知文档类型')
                if kind in ('exam','answer'):
                    version=int(version or 1)
                    if version not in (1,2): raise ValueError('v1.3 每个周期仅支持周测（1）与复测（2）')
                else: version=None
                doc=document_for(data,plan,kind,version); save_data(data); return self.send_json({'document':self.document_payload(doc)})
            return self.send_json({'error':'接口不存在'},404)
        except (ValueError, KeyError, json.JSONDecodeError, zipfile.BadZipFile) as exc:
            return self.send_json({'error':str(exc)},400)
        except Exception as exc:
            print('[wordtrail] unexpected',repr(exc),file=sys.stderr); return self.send_json({'error':'处理失败，请重试。'},500)

if __name__ == '__main__':
    host = os.environ.get('WORDTRAIL_HOST', '127.0.0.1')
    port = int(os.environ.get('PORT', os.environ.get('WORDTRAIL_PORT', '4173')))
    print(f'Wordtrail is ready at http://{host}:{port}')
    ThreadingHTTPServer((host, port),AppHandler).serve_forever()
