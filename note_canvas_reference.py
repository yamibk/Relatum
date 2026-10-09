"""Lightweight Markdown reference handling; no file reads or canvas runtime.

Only standalone Markdown image tokens outside code, frontmatter and HTML are
embeds. Shared by note moves and the optional canvas store.
"""
from __future__ import annotations

import posixpath
import re
import urllib.parse


CANVAS_DIRECTORY = "canvases"


def canvas_target(note: str, target: str) -> str | None:
    value = urllib.parse.unquote(target)
    if not value or "\\" in value or re.match(r"^(?:[a-z][a-z0-9+.-]*:|/)", value, re.I):
        return None
    path = posixpath.normpath(posixpath.join(posixpath.dirname(note), value))
    parts = path.split("/")
    if len(parts) != 2 or parts[0].casefold() != CANVAS_DIRECTORY or not parts[1].lower().endswith(".canvas"):
        return None
    return CANVAS_DIRECTORY + "/" + parts[1]


def _closing(value: str, start: int, opener: str, closer: str) -> int:
    depth = 0
    escaped = False
    for i in range(start, len(value)):
        char = value[i]
        if escaped:
            escaped = False
        elif char == "\\":
            escaped = True
        elif char == opener:
            depth += 1
        elif char == closer:
            depth -= 1
            if depth == 0:
                return i
    return -1


def references(text: str) -> list[dict]:
    result = []
    fence = None
    html = False
    html_comment = False
    percent_comment = False
    header = re.match(r"^\ufeff?---\r?\n", text)
    close = re.search(r"^(?:---|\.\.\.)[ \t]*\r?$", text[header.end():65536], re.M) if header else None
    header_end = header.end() + close.end() if close else 0
    offset = 0
    for number, original in enumerate(text.splitlines(keepends=True)):
        line = original.rstrip("\r\n")
        stripped = line.strip()
        if offset >= header_end:
            marker = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", line)
            if fence:
                if marker and marker[1][0] == fence[0] and len(marker[1]) >= len(fence) and not marker[2].strip():
                    fence = None
            elif html:
                if (html_comment and "-->" in line) or (not html_comment and not stripped):
                    html = html_comment = False
            elif percent_comment:
                if line.count("%%") % 2:
                    percent_comment = not percent_comment
            elif marker:
                fence = marker[1]
            elif "%%" in line:
                percent_comment = bool(line.count("%%") % 2)
            elif "<!--" in line or re.match(r"^ {0,3}<(?:[A-Za-z/!?])", line):
                if "<!--" in line:
                    html = "-->" not in line[line.index("<!--") + 4:]
                    html_comment = html
                else:
                    html = bool(stripped)
            elif re.match(r"^ {0,3}!\[", line):
                start = line.index("![")
                end_label = _closing(line, start + 1, "[", "]")
                if end_label >= 0 and line[end_label + 1:end_label + 2] == "(":
                    end = _closing(line, end_label + 1, "(", ")")
                    if end >= 0 and not line[end + 1:].strip():
                        destination = line[end_label + 2:end].strip()
                        match = re.fullmatch(r'<([^>\n]+)>(?:\s+(?:"[^"]*"|\x27[^\x27]*\x27))?', destination)
                        if not match:
                            match = re.fullmatch(r'(\S+?)(?:\s+(?:"[^"]*"|\x27[^\x27]*\x27))?', destination)
                        if match and urllib.parse.unquote(match[1]).lower().endswith(".canvas"):
                            target = match[1]
                            target_at = end_label + 2 + line[end_label + 2:end].index(target)
                            result.append({"from": offset + start, "to": offset + end + 1,
                                "targetFrom": offset + target_at, "targetTo": offset + target_at + len(target),
                                "labelFrom": offset + start + 2, "labelTo": offset + end_label,
                                "label": line[start + 2:end_label], "target": target})
        offset += len(original)
    return result


def rewrite(text: str, note: str, *, new_note: str | None = None,
            renamed: dict[str, str] | None = None) -> str:
    changes = []
    for ref in references(text):
        old = canvas_target(note, ref["target"])
        if not old:
            continue
        key = next((key for key in (renamed or {}) if key.casefold() == old.casefold()), None)
        target = renamed[key] if key is not None else old
        if target == old and (new_note is None or new_note == note):
            continue
        relative = posixpath.relpath(target, posixpath.dirname(new_note or note) or ".")
        # Encode spaces/parentheses in generated paths without changing syntax.
        relative = urllib.parse.quote(relative, safe="/.-_~")
        changes.append((ref["targetFrom"], ref["targetTo"], relative))
        if target != old:
            label = ref["label"]
            size = re.search(r"\|[1-9]\d*(?:[xX][1-9]\d*)?$", label)
            caption = label[:size.start()] if size else label
            basename = posixpath.basename(old)
            decoded_caption = re.sub(r"\\([\\\[\]])", r"\1", caption)
            if decoded_caption.casefold() in {basename.casefold(), basename[:-7].casefold()}:
                replacement = posixpath.basename(target)
                if decoded_caption.casefold() == basename[:-7].casefold():
                    replacement = replacement[:-7]
                replacement = re.sub(r"([\\\[\]])", r"\\\1", replacement)
                changes.append((ref["labelFrom"], ref["labelTo"], replacement + (size[0] if size else "")))
    for start, end, replacement in sorted(changes, reverse=True):
        text = text[:start] + replacement + text[end:]
    return text
