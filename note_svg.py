"""Bounded validation for local, static SVG images; rendering stays in the browser.

Keep the original bytes. This is deliberately an image subset, not an SVG editor
or a sanitizer that silently rewrites a user's drawing.
"""
import math
import re
from xml.parsers import expat


SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
_EDITOR_NAMESPACES = frozenset(('http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd',
                               'http://www.inkscape.org/namespaces/inkscape'))
MAX_SVG_BYTES = 4 * 1024 * 1024
MAX_SVG_ELEMENTS = 10_000
MAX_SVG_DEPTH = 64
_ACTIVE_ELEMENTS = frozenset((
    'script', 'foreignobject', 'animate', 'animatecolor', 'animatemotion',
    'animatetransform', 'set', 'discard', 'handler',
))
_CSS_ATTRIBUTES = frozenset((
    'style', 'fill', 'stroke', 'filter', 'clip-path', 'mask', 'cursor',
    'marker', 'marker-start', 'marker-mid', 'marker-end', 'color-profile',
))
_CSS_URL = re.compile(r'url\s*\(', re.IGNORECASE)
_DIMENSION = re.compile(r'([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*([a-z%]*)', re.IGNORECASE)
_ABSOLUTE_UNITS = {'': 1, 'px': 1, 'in': 96, 'cm': 96 / 2.54, 'mm': 96 / 25.4,
                   'q': 96 / 101.6, 'pt': 96 / 72, 'pc': 16}


class SvgImageError(ValueError):
    def __init__(self, message, *, too_large=False):
        super().__init__(message)
        self.too_large = too_large


def _check_css(value: str) -> None:
    # Escapes and at-rules are outside the static subset. Together with the
    # resource response's CSP this also covers CSS imports and external fonts.
    # Find delimiters once. A regex that retries an unterminated comment/URL at
    # every opening delimiter can become quadratic on malformed large files.
    parts, offset = [], 0
    while (start := value.find('/*', offset)) >= 0:
        parts.append(value[offset:start])
        end = value.find('*/', start + 2)
        if end < 0:
            raise SvgImageError('SVG 的样式注释不完整')
        offset = end + 2
    parts.append(value[offset:])
    value = ''.join(parts)
    if '\\' in value or '@' in value or re.search(
            r'(?:^|[;{])\s*(?:-\w+-)?(?:animation|transition)[\w-]*\s*:', value, re.IGNORECASE):
        raise SvgImageError('SVG 暂不支持动画、CSS 转义或外部样式')
    offset = 0
    while match := _CSS_URL.search(value, offset):
        end = value.find(')', match.end())
        if end < 0:
            raise SvgImageError('SVG 的样式资源引用无效')
        target = value[match.end():end].strip().strip('\"\'').strip()
        if not target.startswith('#') or any(char.isspace() for char in target):
            raise SvgImageError('SVG 只支持文件内部的资源引用')
        offset = end + 1


def _check_dimensions(attributes: dict[str, str]) -> None:
    dimensions = {}
    for name in ('width', 'height'):
        value = attributes.get(name, '').strip()
        if not value or value == 'auto':
            continue
        match = _DIMENSION.fullmatch(value)
        if not match:
            raise SvgImageError('SVG 的图片尺寸无效')
        number, unit = float(match[1]), match[2].lower()
        if not math.isfinite(number) or number <= 0:
            raise SvgImageError('SVG 的图片尺寸无效')
        if unit in _ABSOLUTE_UNITS:
            dimensions[name] = number * _ABSOLUTE_UNITS[unit]
        elif unit not in ('%', 'em', 'ex', 'ch', 'rem'):
            raise SvgImageError('SVG 的图片尺寸单位暂不支持')
    if (any(value > 32768 for value in dimensions.values())
            or dimensions.get('width', 0) * dimensions.get('height', 0) > 64 * 1024 * 1024):
        raise SvgImageError('SVG 图片尺寸过大，请缩小后插入', too_large=True)
    if 'viewBox' in attributes:
        try:
            values = [float(value) for value in re.split(r'[\s,]+', attributes['viewBox'].strip(), maxsplit=4)]
        except ValueError:
            values = []
        # viewBox coordinates are drawing units, not raster pixel dimensions.
        if len(values) != 4 or not all(math.isfinite(value) for value in values) or min(values[2:]) <= 0:
            raise SvgImageError('SVG 的 viewBox 无效')


def validate_svg(content: bytes) -> None:
    if len(content) > MAX_SVG_BYTES:
        raise SvgImageError('SVG 图片过大（上限 4MiB）', too_large=True)
    parser = expat.ParserCreate(namespace_separator='}')
    parser.buffer_text = True
    stack = []
    elements = 0
    style = None

    def start(name, attributes):
        nonlocal elements, style
        namespace, _, local = name.rpartition('}')
        if not stack and name != SVG_NAMESPACE + '}svg':
            raise SvgImageError('图片内容不是有效的 SVG')
        elements += 1
        if elements > MAX_SVG_ELEMENTS or len(stack) >= MAX_SVG_DEPTH:
            raise SvgImageError('SVG 结构过于复杂，请简化后插入', too_large=True)
        if local.lower() in _ACTIVE_ELEMENTS:
            raise SvgImageError('SVG 仅支持静态图片，不支持脚本、动画或内嵌网页')
        if (namespace != SVG_NAMESPACE and namespace not in _EDITOR_NAMESPACES
                and SVG_NAMESPACE + '}metadata' not in stack):
            raise SvgImageError('SVG 包含不支持的非图形内容')
        for key, value in attributes.items():
            attribute = key.rsplit('}', 1)[-1].lower()
            if attribute.startswith('on') or attribute in ('base', 'src'):
                raise SvgImageError('SVG 不支持事件脚本或外部资源')
            if attribute == 'href' and value.strip() and not value.strip().startswith('#'):
                raise SvgImageError('SVG 只支持文件内部的资源引用')
            if attribute in _CSS_ATTRIBUTES:
                _check_css(value)
        if not stack:
            _check_dimensions(attributes)
        stack.append(name)
        if name == SVG_NAMESPACE + '}style':
            if style is not None:
                raise SvgImageError('SVG 的样式结构无效')
            style = []

    def end(name):
        nonlocal style
        if name == SVG_NAMESPACE + '}style':
            _check_css(''.join(style))
            style = None
        stack.pop()

    def characters(value):
        if style is not None:
            style.append(value)

    def declaration(*_):
        raise SvgImageError('SVG 不支持 DTD、实体或外部样式声明')

    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.CharacterDataHandler = characters
    parser.StartDoctypeDeclHandler = declaration
    parser.EntityDeclHandler = declaration
    parser.ExternalEntityRefHandler = declaration
    parser.ProcessingInstructionHandler = declaration
    try:
        parser.Parse(content, True)
    except SvgImageError:
        raise
    except (expat.ExpatError, LookupError, ValueError) as error:
        raise SvgImageError('SVG 文件内容无效或不完整') from error
