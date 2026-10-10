"""Read-only note graph references; no renderer, filesystem or retained bodies.

The legacy Wiki link panel and rename scanner deliberately keep their original
grammar. This scanner recognises both Wiki and Markdown links for the graph.
"""
from __future__ import annotations

import html
import posixpath
import re
import unicodedata
import urllib.parse
from bisect import bisect_left, bisect_right

from note_metadata import frontmatter, escaped_at


_PUNCTUATION_ESCAPE = re.compile(r"\\([!\"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])")
_SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")
_QUOTE = re.compile(r"^ {0,3}>[ \t]?")
_LIST = re.compile(r"^([ \t]*)(?:[-+*]|\d{1,9}[.)])([ \t]+)")
_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")


def _unescape(value: str) -> str:
    return html.unescape(_PUNCTUATION_ESCAPE.sub(r"\1", value))


def _mask(source: str, ranges: list[tuple[int, int]]) -> str:
    if not ranges:
        return source
    merged: list[list[int]] = []
    for start, end in sorted(ranges):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(end, merged[-1][1])
        else:
            merged.append([start, end])
    pieces, position = [], 0
    for start, end in merged:
        pieces.append(source[position:start])
        # Keep newlines and source positions; removed syntax cannot join tokens.
        pieces.append(re.sub(r"[^\n]", " ", source[start:end]))
        position = end
    pieces.append(source[position:])
    return "".join(pieces)


def _quote(line: str) -> tuple[str, int, int]:
    depth, prefix = 0, 0
    while (match := _QUOTE.match(line)) is not None:
        size = match.end()
        prefix += size
        line = line[size:]
        depth += 1
    return line, depth, prefix


def _delimiter_index(source: str) -> tuple[dict[int, int], dict[int, int], dict[int, int]]:
    """Nearest matching delimiters, built once even for many unclosed openers."""
    lengths, ticks, math, nearest_ticks, nearest_math = {}, {}, {}, {}, {}
    position = len(source) - 1
    while position >= 0:
        char = source[position]
        if char in ("`", "$"):
            end = position + 1
            while position > 0 and source[position - 1] == char:
                position -= 1
            size = end - position
            if char == "`":
                lengths[position] = size
                close = nearest_ticks.get(size)
                if close is not None:
                    ticks[position] = close + size
                nearest_ticks[size] = position
            elif size <= 2 and not escaped_at(source, position):
                key = "block" if size == 2 else "inline"
                close = nearest_math.get(key)
                if close is not None:
                    math[position] = close + size
                nearest_math[key] = position
            position -= 1
            continue
        if char == "\n":
            nearest_math.pop("inline", None)
            nearest_math.pop("paren", None)
        elif char in "[]()" and position > 0 and source[position - 1] == "\\":
            start = position - 1
            if not escaped_at(source, start):
                if char in "])":
                    nearest_math["bracket" if char == "]" else "paren"] = start
                else:
                    close = nearest_math.get("bracket" if char == "[" else "paren")
                    if close is not None:
                        math[start] = close + 2
            position -= 2
            continue
        position -= 1
    return lengths, ticks, math


def _comment_source(source: str) -> str:
    lengths, ticks, math = _delimiter_index(source)
    ranges = []
    position = 0
    while position < len(source):
        end = ticks.get(position) or math.get(position)
        if end and not escaped_at(source, position):
            ranges.append((position, end))
            position = end
            continue
        position += lengths.get(position, 1)
    return _mask(source, ranges)


def _block_source(source: str) -> str:
    ranges = []
    header = frontmatter(source)
    header_end = header[1] if header else 0
    if header:
        ranges.append(header)
    fence = None
    html_block = None
    comment = None
    math = None
    list_indent = 0
    offset = 0
    for raw in source.splitlines(keepends=True):
        line = raw.rstrip("\n")
        if offset < header_end:
            offset += len(raw)
            continue
        content, quote_depth, _ = _quote(line)
        indentation = len(content) - len(content.lstrip(" \t"))
        marker = _LIST.match(content)
        if marker:
            list_indent = len(content[:marker.end()].expandtabs(4))
            content = content[marker.end():]
        elif content.strip() and list_indent:
            if len(content[:indentation].expandtabs(4)) >= list_indent:
                consumed, width = 0, 0
                while consumed < indentation and width < list_indent:
                    width += 4 - width % 4 if content[consumed] == "\t" else 1
                    consumed += 1
                content = content[consumed:]
            else:
                list_indent = 0
        if fence and quote_depth < fence[2]:
            fence = None
        fence_marker = _FENCE.match(content)
        if not fence and not html_block:
            if math:
                if content.strip() == math:
                    math = None
                offset += len(raw)
                continue
            if not comment and content.strip() in ("$$", "\\["):
                math = "$$" if content.strip() == "$$" else "\\]"
                offset += len(raw)
                continue
            if comment or not fence_marker:
                previous_comment = comment
                # Hidden comment/math text cannot start a fence that would
                # incorrectly hide the following visible paragraphs.
                comment_source = _comment_source(content) if re.search(r"<!--|-->|%%", content) else content
                for match in re.finditer(r"<!--|-->|%%", content):
                    if not comment and (escaped_at(content, match.start()) or comment_source[match.start():match.end()] != match[0]):
                        continue
                    token = match[0]
                    if comment:
                        if token == comment:
                            comment = None
                    elif token != "-->":
                        comment = "-->" if token == "<!--" else "%%"
                if previous_comment or comment:
                    offset += len(raw)
                    continue
        if fence:
            ranges.append((offset, offset + len(raw)))
            if fence_marker and fence_marker[1][0] == fence[0] and len(fence_marker[1]) >= fence[1] and not fence_marker[2].strip():
                fence = None
        elif html_block:
            if not content.strip() and html_block == "blank":
                html_block = None
            else:
                ranges.append((offset, offset + len(raw)))
                if html_block != "blank" and re.search(r"</" + html_block + r"\s*>", content, re.I):
                    html_block = None
        elif fence_marker:
            if fence_marker[1][0] != "`" or "`" not in fence_marker[2]:
                fence = (fence_marker[1][0], len(fence_marker[1]), quote_depth)
                ranges.append((offset, offset + len(raw)))
        elif content.startswith("\t") or content.startswith("    "):
            ranges.append((offset, offset + len(raw)))
        else:
            block_tag = re.match(r"^ {0,3}<(script|pre|style|textarea)(?:\s|>)", content, re.I)
            if block_tag:
                name = block_tag[1].lower()
                ranges.append((offset, offset + len(raw)))
                if not re.search(r"</" + name + r"\s*>", content, re.I):
                    html_block = name
            elif re.match(r"^ {0,3}</?[A-Za-z][\w-]*(?:\s[^>]*|/?)>[ \t]*$", content):
                ranges.append((offset, offset + len(raw)))
                html_block = "blank"
        offset += len(raw)
    return _mask(source, ranges)


def _protected_source(source: str) -> str:
    source = _block_source(source)
    if not any(token in source for token in ("`", "$", "\\[", "\\(", "<!--", "%%")):
        # Most notes need no inline masking. In particular, malformed ordinary
        # links should not pay for a second full set of destination indexes.
        return source
    brackets = _brackets(source)
    link_index = _LinkIndex(source)
    lengths, ticks, math = _delimiter_index(source)
    ranges = []
    position = 0
    size = len(source)
    line_start, line_end = 0, source.find("\n")
    if line_end < 0:
        line_end = size
    line_marker = source[line_start:line_end].strip()
    while position < size:
        if position > line_end:
            line_start = source.rfind("\n", line_end, position) + 1
            line_end = source.find("\n", position)
            if line_end < 0:
                line_end = size
            line_marker = source[line_start:line_end].strip()
        char = source[position]
        if char == "[" and not escaped_at(source, position):
            label_end = brackets.get(position, -1)
            if label_end >= 0 and source[label_end + 1:label_end + 2] == "(":
                link = _inline_destination(source, label_end + 1, link_index)
                if link:
                    # Escaped parentheses in a real destination are filename
                    # punctuation, not an inline formula delimiter.
                    position = link[1]
                    continue
            elif label_end >= 0 and source[label_end + 1:label_end + 2] == ":":
                destination_start = label_end + 2
                while destination_start < size and source[destination_start].isspace():
                    destination_start += 1
                destination = _destination(source, destination_start, link_index)
                if destination:
                    position = destination[1]
                    continue
        if source.startswith("<!--", position) or source.startswith("%%", position):
            token = "-->" if source.startswith("<!--", position) else "%%"
            if not escaped_at(source, position):
                close = source.find(token, position + (4 if token == "-->" else 2))
                end = close + len(token) if close >= 0 else size
                ranges.append((position, end))
                position = end
                continue
        if char == "`" and not escaped_at(source, position):
            end = ticks.get(position)
            if end is not None:
                ranges.append((position, end))
                position = end
                continue
            position += lengths.get(position, 1)
            continue
        token = None
        if source.startswith(("\\[", "\\("), position) and not escaped_at(source, position):
            token = source[position:position + 2]
        elif char == "$" and not escaped_at(source, position):
            token = "$$" if source.startswith("$$", position) else "$"
        if token:
            end = math.get(position)
            if end is not None:
                ranges.append((position, end))
                position = end
                continue
            if token in ("$$", "\\[") and line_marker == token:
                ranges.append((position, size))
                break
            position += len(token)
            continue
        position += 1
    return _mask(source, ranges)


def _brackets(source: str) -> dict[int, int]:
    """Pair brackets once so many malformed openers do not cause quadratic scans."""
    pairs, stack = {}, []
    position = 0
    while position < len(source):
        char = source[position]
        if char == "\\" and position + 1 < len(source):
            position += 2
            continue
        if char == "[":
            stack.append(position)
        elif char == "]" and stack:
            pairs[stack.pop()] = position
        position += 1
    return pairs


class _LinkIndex:
    """Termination indexes shared by all successful and failed link attempts.

    Bare destinations have balanced parentheses and no unescaped whitespace or
    '<' inside them. Skipping an indexed pair is safe only after checking that
    condition. Titles and angle destinations use their own termination rules,
    so parentheses inside a quoted title/angle path need not be balanced.
    """
    __slots__ = ("parentheses", "breaks", "title_closers", "angles")

    def __init__(self, source: str):
        self.parentheses: dict[int, int] = {}
        self.breaks: list[int] = []
        self.title_closers: dict[str, list[int]] = {"'": [], '"': [], ")": []}
        self.angles: dict[int, int] = {}
        stack: list[int] = []
        angle = None
        position = 0
        while position < len(source):
            char = source[position]
            if char == "\\" and position + 1 < len(source):
                position += 2
                continue
            if char.isspace() or char == "<":
                self.breaks.append(position)
            if char in self.title_closers:
                self.title_closers[char].append(position)
            if char == "(":
                stack.append(position)
            elif char == ")" and stack:
                self.parentheses[stack.pop()] = position
            if char == "<":
                # A second '<' invalidates the previous angle destination.
                angle = position
            elif char == "\n":
                angle = None
            elif char == ">" and angle is not None:
                self.angles[angle] = position + 1
                angle = None
            position += 1


def _destination(source: str, start: int, index: _LinkIndex) -> tuple[str, int] | None:
    position = start
    if source[start:start + 1] == "<":
        end = index.angles.get(start)
        return (source[start + 1:end - 1], end) if end is not None else None
    while position < len(source):
        char = source[position]
        if char == "\\" and position + 1 < len(source):
            position += 2
            continue
        if char.isspace() or char == ")":
            break
        if char == "<":
            return None
        if char == "(":
            end = index.parentheses.get(position)
            if end is None:
                return None
            next_break = bisect_left(index.breaks, position + 1)
            if next_break < len(index.breaks) and index.breaks[next_break] < end:
                return None
            position = end + 1
            continue
        position += 1
    return source[start:position], position


def _title_end(source: str, start: int, index: _LinkIndex) -> int:
    quote = source[start:start + 1]
    if quote not in ("'", '"', "("):
        return -1
    closer = ")" if quote == "(" else quote
    positions = index.title_closers[closer]
    at = bisect_right(positions, start)
    return positions[at] + 1 if at < len(positions) else -1


def _inline_destination(source: str, start: int, index: _LinkIndex) -> tuple[str, int] | None:
    position = start + 1
    while position < len(source) and source[position].isspace():
        position += 1
    parsed = _destination(source, position, index)
    if parsed is None:
        return None
    target, position = parsed
    separator = position
    while position < len(source) and source[position].isspace():
        position += 1
    if source[position:position + 1] != ")" and position > separator:
        position = _title_end(source, position, index)
        if position < 0:
            return None
        while position < len(source) and source[position].isspace():
            position += 1
    return (target, position + 1) if source[position:position + 1] == ")" else None


def _reference_key(value: str) -> str:
    return " ".join(unicodedata.normalize("NFC", _unescape(value)).split()).casefold()


def _definitions(source: str, brackets: dict[int, int], index: _LinkIndex) -> tuple[dict[str, str], list[tuple[int, int]]]:
    definitions, ranges = {}, []
    offset = 0
    for raw in source.splitlines(keepends=True):
        line, _, prefix = _quote(raw.rstrip("\n"))
        indentation = len(line) - len(line.lstrip(" "))
        start = offset + prefix + indentation
        offset += len(raw)
        if indentation > 3 or source[start:start + 1] != "[":
            continue
        close = brackets.get(start, -1)
        if close < 0 or close - start > 1001 or source[close + 1:close + 2] != ":":
            continue
        label = source[start + 1:close]
        if not label.strip() or label.startswith("^") or any(char == "[" and not escaped_at(label, at) for at, char in enumerate(label)):
            continue
        position = close + 2
        while position < len(source) and source[position] in " \t":
            position += 1
        if source[position:position + 1] == "\n":
            position += 1
            while position < len(source) and source[position] in " \t":
                position += 1
        parsed = _destination(source, position, index)
        if parsed is None or not parsed[0]:
            continue
        target, end = parsed
        tail = end
        while tail < len(source) and source[tail] in " \t":
            tail += 1
        if source[tail:tail + 1] not in ("", "\n"):
            title_end = _title_end(source, tail, index)
            if title_end < 0:
                continue
            tail = title_end
            while tail < len(source) and source[tail] in " \t":
                tail += 1
            if source[tail:tail + 1] not in ("", "\n"):
                continue
        elif source[tail:tail + 1] == "\n":
            next_line = tail + 1
            while next_line < len(source) and source[next_line] in " \t":
                next_line += 1
            if source[next_line:next_line + 1] in ("'", '"', "("):
                title_end = _title_end(source, next_line, index)
                if title_end >= 0:
                    after = title_end
                    while after < len(source) and source[after] in " \t":
                        after += 1
                    if source[after:after + 1] in ("", "\n"):
                        tail = after
        definitions.setdefault(_reference_key(label), target)
        ranges.append((start, tail))
    return definitions, ranges


def references(value: str) -> list[dict[str, str]]:
    if "[" not in value:
        return []
    source = _protected_source(value.replace("\r\n", "\n").replace("\r", "\n"))
    brackets = _brackets(source)
    link_index = _LinkIndex(source)
    definitions, ranges = _definitions(source, brackets, link_index)
    if ranges:
        source = _mask(source, ranges)
        brackets = _brackets(source)
        link_index = _LinkIndex(source)
    found: set[tuple[str, str]] = set()
    position = 0
    while position < len(source):
        if source[position] == "\\":
            position += 2
            continue
        image = source.startswith("![", position)
        start = position + 1 if image else position
        if source[start:start + 1] != "[":
            position += 1
            continue
        if source.startswith("[[", start):
            close = brackets.get(start, -1)
            if close >= 0 and source[close - 1:close + 1] == "]]" and "\n" not in source[start:close]:
                if not image:
                    target = source[start + 2:close - 1].split("|", 1)[0].strip()
                    if target:
                        found.add(("wiki", target))
                position = close + 1
                continue
        close = brackets.get(start, -1)
        if close < 0:
            position = start + 1
            continue
        label = source[start + 1:close]
        end = close + 1
        target = None
        if source[end:end + 1] == "(":
            parsed = _inline_destination(source, end, link_index)
            if parsed:
                target, end = parsed
        elif source[end:end + 1] == "[":
            reference_close = brackets.get(end, -1)
            if reference_close >= 0 and reference_close - end <= 1001:
                key = source[end + 1:reference_close] or label
                target = definitions.get(_reference_key(key))
                end = reference_close + 1
        elif len(label) <= 1000:
            target = definitions.get(_reference_key(label))
        if not image and target:
            decoded = _unescape(target)
            path = urllib.parse.unquote(decoded.split("#", 1)[0].split("?", 1)[0])
            if path.lower().endswith(".md") and not _SCHEME.match(path) and not path.startswith(("/", "\\")):
                found.add(("markdown", decoded))
        position = max(end, position + 1)
    return [{"kind": kind, "target": target} for kind, target in sorted(found)]


def path_key(path: str) -> str:
    return unicodedata.normalize("NFC", path).casefold()


def scope_contains(path: str, root: str) -> bool:
    key = path_key(path)
    return key.startswith(path_key(root) + "/") if root else key.split("/", 1)[0] != "customnotebook"


def graph_edges(documents: dict[str, dict], root: str) -> list[dict[str, str]]:
    paths = {}
    exact, stems = {}, {}
    for path in documents:
        key = path_key(path)
        # Distinct filenames can share a normalised lookup key (including
        # Unicode composed/decomposed names). Do not choose by iteration order.
        paths[key] = None if key in paths else path
        relative = path[len(root) + 1:] if root else path
        without_suffix = relative[:-3]
        key = path_key(without_suffix)
        exact[key] = None if key in exact else path
        stems.setdefault(path_key(posixpath.basename(without_suffix)), []).append(path)
    pairs = set()
    for source, document in documents.items():
        for reference in document["graphReferences"]:
            target = reference["target"]
            resolved = None
            if reference["kind"] == "markdown":
                raw = urllib.parse.unquote(target.split("#", 1)[0].split("?", 1)[0]).replace("\\", "/")
                if not raw or raw.startswith("/") or _SCHEME.match(raw):
                    continue
                relative = posixpath.normpath(posixpath.join(posixpath.dirname(source), raw))
                if relative.startswith("../") or relative == ".." or not relative.lower().endswith(".md") or not scope_contains(relative, root):
                    continue
                resolved = paths.get(path_key(relative))
            else:
                raw = target.split("#", 1)[0].split("^", 1)[0].strip()
                raw = urllib.parse.unquote(raw).replace("\\", "/").strip("/")
                if not raw or raw.startswith(".") or _SCHEME.match(raw) or "/../" in "/" + raw + "/":
                    continue
                if raw.lower().endswith(".md"):
                    raw = raw[:-3]
                if path_key(raw).startswith("customnotebook/"):
                    resolved = paths.get(path_key(raw + ".md"))
                else:
                    resolved = exact.get(path_key(raw))
                    if resolved is None and "/" not in raw:
                        candidates = stems.get(path_key(raw), [])
                        if len(candidates) == 1:
                            resolved = candidates[0]
            if resolved and resolved != source:
                pairs.add(tuple(sorted((source, resolved))))
    return [{"from": source, "to": target} for source, target in sorted(pairs)]
