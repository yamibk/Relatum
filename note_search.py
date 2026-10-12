"""Literal, offline note search. Offsets refer to the original UTF-16 source."""
from __future__ import annotations

import re
import unicodedata
from bisect import bisect_left, bisect_right
from operator import itemgetter

from note_metadata import frontmatter

_segment_end = itemgetter(1)


def normalize(value: str) -> str:
    return unicodedata.normalize("NFC", value).casefold()


def terms(value: str) -> list[str]:
    if not isinstance(value, str) or len(value) > 512:
        raise ValueError("搜索内容最多 512 个字符")
    result, buffer, quoted, escaped = [], [], False, False
    for char in value.strip():
        if escaped:
            buffer.append(char); escaped = False
        elif char == "\\" and quoted:
            escaped = True
        elif char == '"':
            quoted = not quoted
        elif char.isspace() and not quoted:
            if buffer:
                result.append(normalize("".join(buffer))); buffer = []
        else:
            buffer.append(char)
    if quoted or escaped:
        raise ValueError("请补齐短语的双引号")
    if buffer:
        result.append(normalize("".join(buffer)))
    if len(result) > 32:
        raise ValueError("每次最多搜索 32 个关键词")
    return list(dict.fromkeys(result))


def short_grams(text: str) -> str:
    # Encoded tokens cannot be interpreted as FTS operators or punctuation.
    chars = set(text) - set(" \t\r\n")
    pairs = set()
    for begin in range(0, len(text) - 1, 4096):
        pairs.update(text[i:i + 2] for i in range(begin, min(begin + 4096, len(text) - 1)) if not text[i:i + 2].isspace())
        if len(text) > 65536:
            import time
            time.sleep(0)
    return " ".join([*("g1" + char.encode("utf-8").hex() for char in sorted(chars)),
                     *("g2" + pair.encode("utf-8").hex() for pair in sorted(pairs))])


def match_expression(words: list[str], *, short: bool = False) -> str:
    values = [("g" + str(len(word)) + word.encode("utf-8").hex()) if short else word
              for word in words]
    return " AND ".join('"' + value.replace('"', '""') + '"' for value in values)


def projection(source: str, cooperate=None) -> tuple[str, dict]:
    """Remove invisible metadata/Markdown markers, retaining literal code.

    Most source text has a linear offset map; only removed markup, emoji,
    normalization and decoded image text introduce extra mapping segments.
    """
    output, mapping, display = [], [], []
    offset = source_offset = character_offset = 0

    def emit(text, start, end=None):
        nonlocal offset
        if not text:
            return
        normalized = normalize(text)
        width = len(text.encode('utf-16-le')) // 2
        if end is None and len(normalized) == width and unicodedata.normalize('NFC', text) == text:
            if normalized != text:
                display.append([offset, offset + len(normalized), text])
            if mapping and mapping[-1][1] == offset and mapping[-1][3] == start \
                    and mapping[-1][1] - mapping[-1][0] == mapping[-1][3] - mapping[-1][2]:
                mapping[-1][1] += len(normalized); mapping[-1][3] += width
            else:
                mapping.append([offset, offset + len(normalized), start, start + width])
            output.append(normalized); offset += len(normalized)
            return
        # Normalize combining sequences together, so NFC queries can match NFD.
        for cluster in re.findall(r"[\u1100-\u1112][\u1161-\u1175][\u11a8-\u11c2]?|[^\u0300-\u036f][\u0300-\u036f]*|[\u0300-\u036f]+", text):
            normalized = normalize(cluster)
            if normalized != cluster:
                display.append([offset, offset + len(normalized), cluster])
            width = len(cluster.encode("utf-16-le")) // 2
            stop = start + width if end is None else end
            linear = end is None and len(normalized) == width
            if mapping and linear and mapping[-1][1] == offset and mapping[-1][3] == start \
                    and mapping[-1][1] - mapping[-1][0] == mapping[-1][3] - mapping[-1][2]:
                mapping[-1][1] += len(normalized); mapping[-1][3] = stop
            else:
                mapping.append([offset, offset + len(normalized), start, stop])
            output.append(normalized); offset += len(normalized)
            if end is None:
                start = stop

    header = frontmatter(source)
    fence, comment = "", ''
    tokens = re.compile(r'(`+)([^\n]*?)\1|<!--|%%|\*\*|__|~~|==|^ {0,3}#{1,6} +'
        r'|!?\[\[[^\]\n]*\]\]|!?\[[^\]\n]*\]\((?:\\.|[^()\n]|\([^()\n]*\))*\)'
        r'|<[^>\n]+>')
    for number, line in enumerate(source.splitlines(keepends=True)):
        if cooperate and number % 64 == 0:
            cooperate()
        width = len(line.encode("utf-16-le")) // 2
        if header and character_offset < header[1]:
            emit("\n", source_offset + max(0, width - 1)); source_offset += width
            character_offset += len(line)
            continue
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})", line)
        if marker and not comment:
            token = marker[1]
            if not fence:
                fence = token
            elif token[0] == fence[0] and len(token) >= len(fence) and not line[marker.end():].strip():
                fence = ""
            emit("\n", source_offset + max(0, width - 1)); source_offset += width; character_offset += len(line)
            continue
        if fence:
            emit(line, source_offset); source_offset += width; character_offset += len(line); continue
        position = 0
        while position < len(line):
            if comment:
                close = line.find(comment, position)
                if close < 0:
                    position = len(line); break
                position = close + len(comment); comment = ''; continue
            token = tokens.search(line, position)
            stop = token.start() if token else len(line)
            emit(line[position:stop], source_offset + len(line[:position].encode('utf-16-le')) // 2)
            if not token:
                break
            value = token[0]
            position = token.end()
            if token[2] is not None:
                emit(token[2], source_offset + len(line[:token.start(2)].encode('utf-16-le')) // 2)
            elif value in ('<!--', '%%'):
                if value == '<!--':
                    image = re.fullmatch(r'<!--relatum:image-text:v1:([A-Za-z0-9_-]+)-->\s*', line[token.start():])
                    if image:
                        # The same validator as the renderer/statistics: only
                        # valid visible overlays on a standalone local image.
                        from notes_library import _decode_image_text_items, _standalone_local_image_target
                        if _standalone_local_image_target(line[:token.start()].rstrip()):
                            texts = _decode_image_text_items(image[1])
                            if texts:
                                emit(' ' + ' '.join(texts), source_offset, source_offset + width)
                comment = '-->' if value == '<!--' else '%%'
            elif value.startswith(('[[', '![[')):
                inner_start = token.start() + (3 if value.startswith('!') else 2)
                inner = value[(3 if value.startswith('!') else 2):-2]
                label = inner.rsplit('|', 1)[-1]
                emit(label, source_offset + len(line[:inner_start + len(inner) - len(label)].encode('utf-16-le')) // 2)
            elif value.startswith(('[', '![')):
                label_start = token.start() + (2 if value.startswith('!') else 1)
                label_end = line.find(']', label_start)
                emit(line[label_start:label_end], source_offset + len(line[:label_start].encode('utf-16-le')) // 2)
            elif value.startswith('<'):
                # Attributes and data URLs are not visible text.
                continue
            else:
                continue
        if not line.endswith("\n") or comment:
            emit("\n", source_offset + max(0, width - 1))
        source_offset += width
        character_offset += len(line)
    return "".join(output), {'source': mapping, 'display': display}


def source_range(mapping, start, end):
    if isinstance(mapping, dict):
        mapping = mapping['source']
    left = right = None
    # Projection segments are ordered by their non-overlapping text offsets.
    # Keep the original boundary rules while skipping segments before the hit.
    first = bisect_left(mapping, min(start + 1, end), key=_segment_end)
    for index in range(first, len(mapping)):
        a, b, c, d = mapping[index]
        if left is None and a <= start < b:
            left = c + start - a if b - a == d - c else c
        if a < end <= b:
            right = c + end - a if b - a == d - c else d
            break
    return [left or 0, right if right is not None else left or 0]


def literal_ranges(value, words):
    normalized, mapping, offset, source_offset = [], [], 0, 0
    for cluster in re.findall(r'[\u1100-\u1112][\u1161-\u1175][\u11a8-\u11c2]?|[^\u0300-\u036f][\u0300-\u036f]*|[\u0300-\u036f]+', value):
        text = normalize(cluster); width = len(cluster.encode('utf-16-le')) // 2
        normalized.append(text); mapping.append([offset, offset + len(text), source_offset, source_offset + width])
        offset += len(text); source_offset += width
    text = ''.join(normalized)
    return [source_range(mapping, match.start(), match.end()) for word in words for match in re.finditer(re.escape(word), text)]


def hit(body: str, words: list[str], mapping, offset=0) -> dict:
    positions = [(body.find(word), word) for word in words if body.find(word) >= 0]
    positions.sort()
    first, word = positions[0] if positions else (0, '')
    begin = max(0, first - 70); end = min(len(body), begin + 240)
    excerpt = body[begin:end]
    normalized_excerpt = excerpt
    parts, spans, cursor, display_offset = [], [], begin + offset, 0
    def append(a, b, value):
        nonlocal display_offset
        parts.append(value); spans.append([a, b, display_offset, display_offset + len(value)])
        display_offset += len(value)
    display = mapping.get('display', []) if isinstance(mapping, dict) else []
    first_display = bisect_right(display, cursor, key=_segment_end)
    for index in range(first_display, len(display)):
        a, b, original = display[index]
        if a >= end + offset:
            break
        left, right = max(a, cursor), min(b, end + offset)
        if left > cursor:
            append(cursor, left, body[cursor - offset:left - offset])
        value = original[left - a:right - a] if b - a == len(original) else original
        append(left, right, value); cursor = right
    if cursor < end + offset:
        append(cursor, end + offset, body[cursor - offset:end])
    excerpt = ''.join(parts)
    highlights = []
    for value in words:
        for match in re.finditer(re.escape(value), normalized_excerpt):
            left, right = source_range(spans, offset + begin + match.start(), offset + begin + match.end())
            highlights.append([len(excerpt[:left].encode("utf-16-le")) // 2,
                               len(excerpt[:right].encode("utf-16-le")) // 2])
    return {"excerpt": excerpt, "highlights": highlights,
            "sourceRange": source_range(mapping, offset + first, offset + first + len(word)) if positions else None}
