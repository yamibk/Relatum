"""Small, read-only Obsidian tag/frontmatter recognizers (no YAML dependency)."""
import json
import re
import unicodedata


def frontmatter(text):
    match = re.match(r'\A\ufeff?---\r?\n', text)
    if not match:
        return None
    close = re.search(r'^(?:---|\.\.\.)[ \t]*\r?$', text[match.end():65536], re.MULTILINE)
    return (0, match.end() + close.end()) if close else None


def valid_tag(value):
    value = unicodedata.normalize('NFC', value.lstrip('#'))
    allowed = lambda char: char in '_-/\u200d' or unicodedata.category(char)[0] in 'LMN' or unicodedata.category(char) in ('So', 'Sk')
    return value if value and all(allowed(c) for c in value) and not value.isdecimal() and all(value.split('/')) else None


def yaml_tag_values(text):
    values = []
    collecting = False
    for line in text.splitlines()[1:-1]:
        field = re.match(r'^tags:[ \t]*(.*)$', line)
        if field:
            collecting = not field[1].strip() or field[1].lstrip().startswith('#')
            raw = field[1].strip()
            if raw.startswith('['):
                end = raw.rfind(']')
                if end >= 0:
                    values.extend(re.findall(r'"(?:\\.|[^"\\])*"|\'(?:\'\'|[^\'])*\'|[^,]+', raw[1:end]))
            continue
        if collecting:
            item = re.match(r'^[ \t]+-[ \t]+(.*)$', line)
            if item:
                values.append(item[1])
            elif line.strip() and not line.lstrip().startswith('#'):
                collecting = False
    result = []
    for raw in values:
        raw = raw.strip()
        try:
            if raw.startswith('"'):
                raw = json.JSONDecoder().raw_decode(raw)[0]
            elif raw.startswith("'"):
                quoted = re.match(r"^'((?:''|[^'])*)'", raw)
                raw = quoted[1].replace("''", "'") if quoted else ''
            else:
                raw = re.split(r'[ \t]+#', raw, maxsplit=1)[0].strip()
        except (ValueError, TypeError):
            continue
        tag = valid_tag(raw) if isinstance(raw, str) else None
        if tag:
            result.append(tag)
    return result


def escaped_at(text, position):
    count = 0
    while position > 0 and text[position - 1] == '\\':
        count += 1
        position -= 1
    return count % 2 == 1


def strip_math(text):
    regex = r'\\\[([\s\S]+?)\\\]|(?<!\$)\$\$([\s\S]+?)\$\$(?!\$)|\\\(([^\n]+?)\\\)|(?<!\$)\$([^$\n]+?)\$(?!\$)'
    def replace(match):
        size = 1 if match[4] is not None else 2
        return match[0] if escaped_at(text, match.start()) or escaped_at(text, match.end() - size) else ' '
    return re.sub(regex, replace, text)


def note_metadata(text):
    header = frontmatter(text)
    labels = yaml_tag_values(text[:header[1]]) if header else []
    body = text[header[1]:] if header else text
    lines = []
    fence = ''
    for line in body.splitlines():
        marker = re.match(r'^[ \t]{0,3}(`{3,}|~{3,})', line)
        if fence:
            if re.fullmatch(r'[ \t]{0,3}' + re.escape(fence[0]) + '{' + str(len(fence)) + r',}[ \t]*', line):
                fence = ''
            lines.append('')
            continue
        if marker:
            fence = marker[1]
            lines.append('')
        else:
            lines.append('' if re.match(r'^(?: {4}|\t)', line) else line)
    visible = '\n'.join(lines)
    visible = re.sub(r'(`+)[^`\n]*\1', ' ', visible)
    visible = re.sub(r'<!--[\s\S]*?(?:-->|$)|%%[\s\S]*?(?:%%|$)', ' ', visible)
    visible = strip_math(visible)
    visible = re.sub(r'<[^>\n]*>', ' ', visible)
    visible = re.sub(r'!?\[\[[^\]\n]*\]\]|!?\[[^\]\n]*\]\((?:\\.|[^()\n]|\([^()]*\))*\)|https?://\S+|^[ \t]{0,3}\[[^\]\n]+\]:.*', ' ', visible, flags=re.MULTILINE)
    for match in re.finditer(r'#([^\s#]+)', visible):
        before = visible[match.start()-1] if match.start() else ''
        if escaped_at(visible, match.start()) or before and (unicodedata.category(before)[0] in 'LMN' or before in '_/#!'):
            continue
        chars = []
        for char in match[1]:
            if char in '_-/\u200d' or unicodedata.category(char)[0] in 'LMN' or unicodedata.category(char) in ('So', 'Sk'):
                chars.append(char)
            else:
                break
        tag = valid_tag(''.join(chars))
        if tag:
            labels.append(tag)
    tags = {}
    for label in labels:
        tags.setdefault(label.casefold(), label)
    excerpt = re.sub(r'^[ \t]*>[ \t]*\[![\w-]+\][+-]?[ \t]*', '', visible, flags=re.MULTILINE)
    excerpt = '\n'.join('' if '-' in line and re.fullmatch(r'[\s|:-]+', line) else line.replace('|', ' ') for line in excerpt.splitlines())
    excerpt = re.sub(r'(^|\n)[ \t]*[>#*+-]+[ \t]*|[#*_~`]', ' ', excerpt)
    excerpt = re.sub(r'\s+', ' ', excerpt).strip()[:240]
    return {'tags': [{'key': key, 'label': label} for key, label in tags.items()], 'excerpt': excerpt}
