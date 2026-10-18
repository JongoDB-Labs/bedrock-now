"""What the portal's global search (static/search.js, Ctrl/⌘+K) looks through besides the live sources: the Settings
page's sections and settings (catalog/settings-layout.tsv with each key's label from catalog/settings.tsv, read from the
read-only catalog mount like the Settings page does) and the sections of README.md and docs/*.md — an index built when
the portal's image is built (portal/Dockerfile, stage "docs": `python -m portal.searchindex SRC OUT`), so the running
portal reads no repository files and fetches nothing. Both are presentation only: titles, one-line summaries and
GitHub's heading anchors; never a value of .env.

Building the docs index reads trusted files (this repository's own), line by line, with linear string operations only
(no backtracking regular expression over a whole line)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from . import settings as st

DOCS_INDEX = Path(__file__).parent / "docs-index.json"
MAX_INDEX = 1024 * 1024
MAX_SECTIONS = 2000
MAX_LINE = 2000
EXCERPT = 160
# the page's own rows (no .env key): what the Settings page calls them
OWN_TITLES = {"+devices": "Signed-in devices", "+models": "Model check (Check again)", "+backups": "Backups (Back up now)",
              "+test": "Smoke test", "+check-aws": "AWS key check", "+report": "Status report", "+restart": "Restart a service",
              "+git-hosts": "Git hosts (push, pull, clone)"}


# --- the Settings page ---

def _labels(catalog_dir: Path) -> dict:
    """{KEY: label} from catalog/settings.tsv (its 7th column); {} without a readable file."""
    p = catalog_dir / "settings.tsv"
    out = {}
    try:
        if p.is_symlink() or not p.is_file() or p.stat().st_size > 512 * 1024:
            return {}
        for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
            c = line.split("\t")
            if line.startswith("#") or len(c) < 7 or not st.NAME.fullmatch(c[0]):
                continue
            out[c[0]] = c[6][:120]
    except OSError:
        return {}
    return out


def settings_index(catalog_dir: Path) -> dict:
    """{"sections": [{id, title, lede}], "rows": [{key, section, title, summary, parent}]}: what the search offers of the
    Settings page. A setting shown inside another's row (place "with") leads to that row (#settings/<KEY> opens it)."""
    lay = st.layout(catalog_dir)
    labels = _labels(catalog_dir)
    titles = {s["id"]: s["title"] for s in lay["sections"]}
    rows = []
    for r in lay["rows"]:
        key = r["key"]
        title = OWN_TITLES.get(key) or labels.get(key) or key
        rows.append({"key": key, "section": r["section"], "section_title": titles.get(r["section"], r["section"]),
                     "title": title, "summary": r["summary"], "parent": r["parent"] if r["place"] == "with" else ""})
    return {"sections": [{"id": s["id"], "title": s["title"], "lede": s["lede"]} for s in lay["sections"]], "rows": rows}


# --- README.md and docs/*.md ---

def _strip_inline(text: str) -> str:
    """A heading's text as GitHub shows it: `code` kept without its backticks, [label](url) as its label, ** and *
    emphasis marks dropped, inline HTML tags dropped. One pass, character by character."""
    out, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if c == "`":
            j = text.find("`", i + 1)
            if j > i:
                out.append(text[i + 1:j])
                i = j + 1
                continue
        if c == "!" and i + 1 < n and text[i + 1] == "[":
            i += 1
            continue
        if c == "[":
            j = text.find("](", i + 1)
            k = text.find(")", j + 2) if j > i else -1
            if j > i and k > j:
                out.append(text[i + 1:j])
                i = k + 1
                continue
        if c == "<":
            j = text.find(">", i + 1)
            if j > i and (text[i + 1:i + 2].isalpha() or text[i + 1:i + 2] == "/"):
                i = j + 1
                continue
        if c == "*":
            i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out).strip()


def slug(title: str) -> str:
    """GitHub's anchor for a heading's text: lower case; letters, digits, _ , - and spaces kept, the rest dropped; each
    space a hyphen ("Costs & budgets" -> costs--budgets)."""
    return "".join(c for c in title.lower() if c.isalnum() or c in "_- ").replace(" ", "-")


def _excerpt(lines: list[str]) -> str:
    """The first sentence or so of a section's text (plain words: markup dropped), at most EXCERPT characters."""
    words = []
    for raw in lines:
        t = raw.strip()
        if not t:
            if words:
                break
            continue
        if t.startswith(("|", "```", "<", "---")):
            if words:
                break
            continue
        t = t.lstrip("-*+> ").lstrip("0123456789.").strip()
        words.append(_strip_inline(t))
        if sum(len(w) for w in words) > EXCERPT:
            break
    text = " ".join(w for w in words if w)
    return text if len(text) <= EXCERPT else text[: EXCERPT - 1].rsplit(" ", 1)[0] + "…"


def parse_markdown(text: str) -> tuple[str, list[dict]]:
    """(the page's title, its sections): every ## to #### heading outside fenced code, with GitHub's anchor (a repeated
    one gets -1, -2 …), its level, the heading above it and an excerpt of its first paragraph."""
    title, sections, seen = "", [], {}
    fence = ""
    parents: dict[int, str] = {}
    body: list[str] = []
    cur: dict | None = None
    for line in text.splitlines():
        line = line[:MAX_LINE]
        s = line.lstrip()
        if s.startswith(("```", "~~~")):
            mark = s[:3]
            fence = "" if fence == mark else (fence or mark)
            if cur is not None:
                body.append(line)
            continue
        if fence:
            continue
        level = len(line) - len(line.lstrip("#"))
        if 1 <= level <= 6 and line[level:level + 1] == " ":
            name = _strip_inline(line[level + 1:].strip().rstrip("#").strip())
            if cur is not None:
                cur["text"] = _excerpt(body)
            body, cur = [], None
            base = slug(name)
            n = seen.get(base, 0)
            seen[base] = n + 1
            anchor = base if n == 0 else f"{base}-{n}"
            if level == 1 and not title:
                title = name
                continue
            if 2 <= level <= 4 and name and len(sections) < MAX_SECTIONS:
                cur = {"anchor": anchor, "title": name[:160], "level": level,
                       "parent": next((parents[k] for k in range(level - 1, 1, -1) if k in parents), "")[:160], "text": ""}
                sections.append(cur)
            parents[level] = name
            for k in [k for k in parents if k > level]:
                del parents[k]
            continue
        if cur is not None and len(body) < 40:
            body.append(line)
    if cur is not None:
        cur["text"] = _excerpt(body)
    return title, sections


def build_docs(src: Path) -> dict:
    """The docs index of a checkout (README.md, docs/*.md): {"pages": [{file, title, sections}]}. Missing files are
    left out (a portal image built without the repository has an empty index)."""
    pages = []
    files = [src / "README.md"] + sorted((src / "docs").glob("*.md")) if (src / "docs").is_dir() else [src / "README.md"]
    for f in files:
        if not f.is_file() or f.is_symlink() or f.stat().st_size > 2 * 1024 * 1024:
            continue
        title, sections = parse_markdown(f.read_text(encoding="utf-8", errors="replace"))
        rel = f.name if f.parent == src else f"docs/{f.name}"
        pages.append({"file": rel, "title": title or rel, "sections": sections})
    return {"version": 1, "pages": pages}


_docs_cache: dict = {}


def docs_index(path: Path | None = None) -> dict:
    """The index built into the image (DOCS_INDEX), type-checked; {"pages": []} without one (a dev checkout, or an image
    built without the repository's files)."""
    path = DOCS_INDEX if path is None else path
    try:
        stt = path.stat()
        stamp = (stt.st_mtime_ns, stt.st_size)
        if _docs_cache.get("stamp") == stamp and _docs_cache.get("path") == str(path):
            return _docs_cache["value"]
        if path.is_symlink() or stt.st_size > MAX_INDEX:
            return {"pages": []}
        d = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"pages": []}
    pages = []
    for p in d.get("pages") or [] if isinstance(d, dict) else []:
        if not isinstance(p, dict) or not isinstance(p.get("file"), str) or not st.DOC.fullmatch(p["file"]):
            continue
        secs = [{"anchor": x["anchor"][:120], "title": str(x.get("title", ""))[:160], "level": x.get("level") if x.get("level") in (2, 3, 4) else 2,
                 "parent": str(x.get("parent") or "")[:160], "text": str(x.get("text") or "")[:EXCERPT + 1]}
                for x in p.get("sections") or [] if isinstance(x, dict) and isinstance(x.get("anchor"), str)
                and all(c.isalnum() or c in "_-" for c in x["anchor"])][:MAX_SECTIONS]
        pages.append({"file": p["file"], "title": str(p.get("title") or p["file"])[:160], "sections": secs})
    value = {"pages": pages}
    _docs_cache.update(path=str(path), stamp=stamp, value=value)
    return value


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: python -m portal.searchindex SRC_DIR OUT_JSON", file=sys.stderr)
        return 2
    idx = build_docs(Path(argv[0]))
    Path(argv[1]).write_text(json.dumps(idx, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    n = sum(len(p["sections"]) for p in idx["pages"])
    print(f"docs index: {len(idx['pages'])} pages, {n} sections")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
