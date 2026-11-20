"""Query and projection rules for charts over one note database."""

import hashlib
import json
import math
import re
import uuid
from bisect import bisect_right
from fractions import Fraction

from notes_library import NotesError


QUERY_BUDGET_SECONDS = 1
MAX_GROUPS = 500
MAX_DOUGHNUT_GROUPS = 24
MAX_CARDS = 16
MAX_SERIES = 12
MAX_SCATTER_POINTS = 2000
_BARS = ('column', 'bar')
_CATEGORIES = (*_BARS, 'doughnut')
_GROUP_TYPES = {
    'date': (*_BARS, 'line'), 'status': _CATEGORIES, 'select': _CATEGORIES,
    'checkbox': _CATEGORIES, 'text': _CATEGORIES, 'multiSelect': _BARS,
}
_DATE_BUCKETS = {
    'day': 'g.value',
    'week': "date(g.value, '-' || ((CAST(strftime('%w', g.value) AS INTEGER) + 6) % 7) || ' days')",
    'month': "date(g.value, 'start of month')",
}
_NUMERIC_AGGREGATES = {
    'sum': 'chart_total(m.value, 0)', 'avg': 'chart_total(m.value, 1)',
    'min': 'MIN(m.value)', 'max': 'MAX(m.value)',
}
_SUBNORMAL_SCALE = 1 << 1074
_PALETTES = frozenset({'vivid', 'soft', 'deep', 'contrast'})
_LEGACY_PALETTES = {'fresh': 'soft', 'earth': 'deep'}
_HUES = ('blue', 'coral', 'mint', 'iris', 'amber', 'rose', 'teal', 'olive', 'sky', 'apricot', 'lemon', 'leaf')
_SWATCHES = frozenset(hue + suffix for hue in _HUES for suffix in ('', '-light', '-medium'))
_COLOR_KEY = re.compile(r'[0-9a-f]{64}')
_STYLE_REVISION = re.compile(r'[0-9a-f]{32}')
MAX_CATEGORY_COLORS = 128


class _NumericTotal:
    """Sum exactly in units of the smallest binary64 value, then round once."""

    def __init__(self):
        self.units = 0
        self.count = 0
        self.average = False

    def step(self, value, average):
        if value is not None:
            numerator, denominator = value.as_integer_ratio()
            self.units += numerator << (1075 - denominator.bit_length())
            self.count += 1
            self.average = average

    def finalize(self):
        if self.count == 0:
            return None
        divisor = _SUBNORMAL_SCALE * (self.count if self.average else 1)
        try:
            return self.units / divisor
        except OverflowError:
            return math.inf


def missing_chart(*, deleted=False):
    return {'exists': False, 'deleted': deleted, 'revision': None, 'fields': [], 'chart': None, 'groups': []}


def _default_chart(columns):
    visible = [column for column in columns.values() if not column['hidden']]
    for kind in _GROUP_TYPES:
        column = next((field for field in visible if field['type'] == kind), None)
        if column:
            return {'type': 'line' if kind == 'date' else 'column', 'groupBy': column['id'],
                    'metric': {'op': 'count'}}
    return None


def configuration(columns, chart):
    if chart is None:
        chart = _default_chart(columns)
        if chart is None:
            return None
    if not isinstance(chart, dict):
        raise NotesError('图表配置格式无效', code='invalid_chart')
    chart_type = chart.get('type')
    if chart_type == 'number':
        metric = _metric(columns, chart.get('metric', {'op': 'count'}), ratio=True)
        return {'type': 'number', 'metric': metric}
    group_id = chart.get('groupBy')
    column = columns.get(group_id) if isinstance(group_id, str) else None
    if column is None:
        raise NotesError('图表分组列不存在，请重新选择', code='invalid_chart')
    kind = column['type']
    if kind == 'number' and chart_type == 'histogram':
        bins = chart.get('bins', 10)
        if type(bins) is not int or not 4 <= bins <= 30:
            raise NotesError('直方图支持 4–30 个区间', code='invalid_chart')
        return {'type': chart_type, 'groupBy': group_id, 'bins': bins, 'metric': {'op': 'count'}}
    if kind == 'number' and chart_type == 'scatter':
        metric = chart.get('metric')
        target = metric.get('column') if isinstance(metric, dict) else None
        if not isinstance(target, str) or target == group_id or columns.get(target, {}).get('type') != 'number':
            raise NotesError('请选择两个不同的数字字段', code='invalid_chart')
        return {'type': chart_type, 'groupBy': group_id, 'metric': {'op': 'value', 'column': target}}
    if chart_type not in _GROUP_TYPES.get(kind, ()):
        raise NotesError('此分组列不支持该图表类型', code='invalid_chart')
    metric = _metric(columns, chart.get('metric', {'op': 'count'}), ratio=chart_type != 'doughnut')
    if kind == 'multiSelect' and metric['op'] != 'count':
        raise NotesError('请选择有效的数字指标列与分组列', code='invalid_chart')
    spec = {'type': chart_type, 'groupBy': group_id, 'metric': metric}
    bucket = chart.get('bucket', 'day' if kind == 'date' else None)
    if kind == 'date':
        if not isinstance(bucket, str) or bucket not in _DATE_BUCKETS:
            raise NotesError('日期分组粒度无效', code='invalid_chart')
        spec['bucket'] = bucket
    elif bucket is not None:
        raise NotesError('日期粒度仅适用于日期列', code='invalid_chart')
    series = chart.get('seriesBy')
    comparison = chart.get('compare')
    if series is not None or comparison is not None:
        if chart_type == 'doughnut' or kind == 'multiSelect' or (series is not None and comparison is not None):
            raise NotesError('此图表不支持所选系列', code='invalid_chart')
        if series is not None:
            if (not isinstance(series, str) or series == group_id or
                    columns.get(series, {}).get('type') not in ('select', 'status', 'checkbox', 'text')):
                raise NotesError('请选择有效的系列字段', code='invalid_chart')
            spec['seriesBy'] = series
        else:
            metric_column = metric.get('column')
            if (metric['op'] not in _NUMERIC_AGGREGATES or not isinstance(comparison, str)
                    or comparison == metric_column or columns.get(comparison, {}).get('type') != 'number'
                    or _display_unit(columns[metric_column]) != _display_unit(columns[comparison])):
                raise NotesError('请选择两个显示单位相同的数字字段', code='invalid_chart')
            spec['compare'] = comparison
        if chart.get('stack') is True:
            if chart_type not in _BARS or series is None or metric['op'] not in ('count', 'sum'):
                raise NotesError('堆叠仅支持按类别拆分的记录数或求和', code='invalid_chart')
            spec['stack'] = True
    return spec


def _display_unit(field):
    appearance = field.get('numberFormat', {})
    return appearance.get('percent', False), appearance.get('unit', '')


def _metric(columns, metric, *, ratio):
    op = metric.get('op') if isinstance(metric, dict) else None
    if not isinstance(op, str):
        raise NotesError('图表汇总方式无效', code='invalid_chart')
    column = metric.get('column')
    if op == 'count' and column is None:
        return {'op': op}
    if isinstance(column, str):
        kind = columns.get(column, {}).get('type')
        if (op in _NUMERIC_AGGREGATES and kind == 'number') or (ratio and op == 'checkedRate' and kind == 'checkbox'):
            return {'op': op, 'column': column}
    raise NotesError('图表汇总方式或指标字段无效', code='invalid_chart')


def _fields(columns):
    return [
        {'id': field['id'], 'name': field['name'], 'type': field['type'], 'hidden': bool(field['hidden']),
         'groupCharts': ['histogram', 'scatter'] if field['type'] == 'number' else list(_GROUP_TYPES.get(field['type'], ())),
         'metrics': list(_NUMERIC_AGGREGATES) if field['type'] == 'number' else [],
         **({'numberFormat': field['numberFormat']} if field.get('numberFormat') else {})}
        for field in columns.values() if field['type'] in _GROUP_TYPES or field['type'] == 'number'
    ]


def chart_options(columns):
    return {'fields': _fields(columns), 'suggested': configuration(columns, None), 'maxCards': MAX_CARDS}


def _has_views(connection):
    return connection.execute("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='chart_views'").fetchone() is not None


def _appearance(value):
    if not isinstance(value, dict) or not value.keys() <= {'palette', 'primary', 'categories'}:
        raise NotesError('图表配色格式无效', code='invalid_chart_style')
    style = {}
    for key, choices in (('palette', _PALETTES), ('primary', _SWATCHES)):
        selected = value.get(key)
        if selected is not None:
            if not isinstance(selected, str):
                raise NotesError('图表配色选项无效', code='invalid_chart_style')
            if key == 'palette':
                selected = _LEGACY_PALETTES.get(selected, selected)
            if selected not in choices:
                raise NotesError('图表配色选项无效', code='invalid_chart_style')
            style[key] = selected
    categories = value.get('categories', {})
    if (not isinstance(categories, dict) or len(categories) > MAX_CATEGORY_COLORS
            or any(not isinstance(key, str) or not _COLOR_KEY.fullmatch(key) or not isinstance(tone, str)
                   or tone not in _SWATCHES for key, tone in categories.items())):
        raise NotesError('图表分类配色无效或超过数量上限', code='invalid_chart_style')
    if categories:
        style['categories'] = categories
    return style


def _read_cards(connection, database_id):
    display = {'showData': False, 'orientation': 'vertical', 'hideTitles': False}
    if not _has_views(connection):
        return 'data', [], display
    saved = connection.execute('SELECT mode,chart FROM chart_views WHERE database_id=?', (database_id,)).fetchone()
    if not saved:
        return 'data', [], display
    cards = []
    try:
        chart = json.loads(saved['chart'])
        if isinstance(chart, dict):
            if isinstance(chart.get('cards'), list):
                display['showData'] = chart.get('showData') is True
                display['hideTitles'] = chart.get('hideTitles') is True
                if chart.get('orientation') == 'horizontal':
                    display['orientation'] = 'horizontal'
                cards = [card for card in chart['cards'] if isinstance(card, dict) and isinstance(card.get('id'), str)
                         and isinstance(card.get('chart'), dict)]
            else:
                style = chart.pop('style', {})
                revision = chart.pop('styleRevision', None)
                cards = [{'id': 'default', 'name': '', 'chart': chart, 'query': {},
                          'style': style, 'styleRevision': revision}]
    except (ValueError, RecursionError):
        pass
    for card in cards:
        try:
            card['style'] = _appearance(card.get('style', {}))
        except NotesError:
            card['style'] = {}
        revision = card.get('styleRevision')
        if not isinstance(revision, str) or not _STYLE_REVISION.fullmatch(revision):
            card['styleRevision'] = None
    return saved['mode'], cards, display


def read_views(connection, database_id, columns):
    mode, cards, display = _read_cards(connection, database_id)
    for card in cards:
        try:
            card['valid'] = configuration(columns, card['chart']) is not None
        except NotesError:
            card['valid'] = False
    first = cards[0] if cards else {'chart': None, 'valid': False, 'style': {}, 'styleRevision': None}
    view = {'mode': mode, **{key: first[key] for key in ('chart', 'valid', 'style', 'styleRevision')}}
    return view, cards, display


def load_card(connection, database_id, card_id):
    _, cards, _ = _read_cards(connection, database_id)
    card = next((item for item in cards if item['id'] == card_id), None)
    if card is None:
        raise NotesError('图表已移除，请刷新后重试', status=409, code='revision_conflict')
    return card


def _write_views(connection, database_id, mode, cards, display):
    connection.execute('''CREATE TABLE IF NOT EXISTS chart_views(
        database_id TEXT PRIMARY KEY REFERENCES databases(id),
        mode TEXT NOT NULL CHECK(mode IN ('data','chart')), chart TEXT NOT NULL)''')
    payload = {'cards': cards, **display}
    connection.execute('''INSERT INTO chart_views(database_id,mode,chart) VALUES(?,?,?)
        ON CONFLICT(database_id) DO UPDATE SET mode=excluded.mode,chart=excluded.chart''',
        (database_id, mode, json.dumps(payload, ensure_ascii=False, separators=(',', ':'))))


def _new_card(chart, identity='default', name='', query=None):
    return {'id': identity, 'name': name, 'chart': chart, 'query': query or {},
            'style': {}, 'styleRevision': None}


def _set_configuration(card, chart):
    if card['style'].get('categories') and any(chart.get(key) != card['chart'].get(key)
                                               for key in ('groupBy', 'bucket', 'seriesBy')):
        card['style'].pop('categories')
        card['styleRevision'] = uuid.uuid4().hex
    card['chart'] = chart


def set_view(connection, database_id, columns, action):
    previous_mode, cards, display = _read_cards(connection, database_id)
    mode = action.get('mode')
    previous_chart = cards[0]['chart'] if cards else None
    chart = previous_chart
    if mode == 'chart':
        if 'chart' in action:
            if action['chart'] is None:
                raise NotesError('请先选择图表配置', code='invalid_chart')
            chart = configuration(columns, action['chart'])
        elif not cards:
            raise NotesError('请先选择图表配置', code='invalid_chart')
        elif len(cards) == 1:
            configuration(columns, chart)
    elif mode != 'data' or 'chart' in action:
        raise NotesError('图表视图格式无效', code='invalid_chart')
    if mode == previous_mode and previous_chart == chart:
        return False
    if chart != previous_chart:
        if cards:
            _set_configuration(cards[0], chart)
        else:
            cards.append(_new_card(chart))
    _write_views(connection, database_id, mode, cards, display)
    return True


def set_card(connection, database_id, columns, action, validate_query):
    mode, cards, display = _read_cards(connection, database_id)
    operation = action.get('operation')
    if operation == 'arrange':
        layout = action.get('layout')
        display = {key: action.get(key, value) for key, value in display.items()}
        if display['orientation'] not in ('vertical', 'horizontal'):
            raise NotesError('图表排列方式无效', code='invalid_chart')
        if type(display['showData']) is not bool or type(display['hideTitles']) is not bool:
            raise NotesError('图表显示设置无效', code='invalid_chart')
        positions = {item['id']: item for item in cards}
        if (not isinstance(layout, list) or len(layout) != len(cards)
                or any(not isinstance(item, dict) or not isinstance(item.get('id'), str)
                       or type(item.get('hidden')) is not bool for item in layout)
                or {item['id'] for item in layout} != positions.keys()):
            raise NotesError('图表列表已变化，请重新打开', status=409, code='revision_conflict')
        ordered = [{**positions[item['id']], 'hidden': item['hidden']} for item in layout]
        _write_views(connection, database_id, mode, ordered, display)
        return None
    card = next((item for item in cards if item['id'] == action.get('chartId')), None)
    if operation != 'add' and card is None:
        raise NotesError('图表已移除，请刷新后重试', status=409, code='revision_conflict')
    if operation == 'delete':
        cards.remove(card)
        if not cards:
            display['showData'] = False
        _write_views(connection, database_id, mode if cards else 'data', cards, display)
        return None
    if operation not in ('add', 'edit', 'duplicate', 'rename'):
        raise NotesError('图表操作无效', code='invalid_chart')
    if operation in ('add', 'duplicate') and len(cards) >= MAX_CARDS:
        raise NotesError(f'每张表最多保存 {MAX_CARDS} 张图表', code='chart_limit')
    name = action.get('name', card['name'] if card else '')
    if not isinstance(name, str) or len(name) > 120 or any(ord(char) < 32 for char in name):
        raise NotesError('图表名称无效', code='invalid_chart')
    name = name.strip()
    if operation == 'rename':
        if not name:
            raise NotesError('图表名称不能为空', code='invalid_chart')
        if name == card['name']:
            return None
        card['name'] = name
        _write_views(connection, database_id, mode, cards, display)
        return card['id']
    if operation == 'duplicate':
        card = {**card, 'id': uuid.uuid4().hex, 'name': name}
        cards.append(card)
    else:
        config = action.get('chart', card['chart'] if card else None)
        chart = configuration(columns, config) if config is not None else None
        if chart is None:
            raise NotesError('请先选择图表配置', code='invalid_chart')
        query = action.get('query', card['query'] if card else {})
        if not isinstance(query, dict) or not query.keys() <= {'search', 'filters'}:
            raise NotesError('图表筛选格式无效', code='invalid_chart')
        validate_query(query)
        if operation == 'add':
            card = _new_card(chart, uuid.uuid4().hex, name, query)
            cards.append(card)
        else:
            _set_configuration(card, chart)
            card.update(name=name, query=query)
    _write_views(connection, database_id, 'chart' if operation == 'add' or action.get('show') is True else mode,
                 cards, display)
    return card['id']


def set_appearance(connection, database_id, columns, action):
    mode, cards, display = _read_cards(connection, database_id)
    identity = action.get('chartId', cards[0]['id'] if cards else None)
    current = next((card for card in cards if card['id'] == identity), None)
    if mode != 'chart' or current is None or action.get('styleRevision') != current['styleRevision']:
        raise NotesError('图表配色已修改，请重新载入', status=409, code='chart_style_conflict')
    configuration(columns, current['chart'])
    style = _appearance(action.get('style'))
    if style != current['style']:
        current.update(style=style, styleRevision=uuid.uuid4().hex)
        _write_views(connection, database_id, mode, cards, display)


def delete_views(connection, identities):
    if _has_views(connection):
        connection.executemany('DELETE FROM chart_views WHERE database_id=?', ((identity,) for identity in identities))


def _chart_query(connection, columns, spec):
    joins, arguments, group, series = '', [], None, None

    def cell(alias, column, optional=False):
        nonlocal joins
        joins += f' {"LEFT " if optional else ""}JOIN cells AS {alias} ON {alias}.database_id=r.database_id AND {alias}.row_id=r.id AND {alias}.column_id=?'
        arguments.append(column)
        return f'{alias}.value'

    def category(alias, column):
        nonlocal joins
        kind = columns[column]['type']
        expression = cell(alias, column, kind == 'checkbox')
        if kind == 'checkbox':
            return f'COALESCE({expression}, 0)'
        if kind == 'date':
            return _DATE_BUCKETS[spec['bucket']]
        if kind == 'multiSelect':
            joins += ' JOIN json_each(g.value) AS tag'
            return 'tag.value'
        return expression

    if 'groupBy' in spec:
        group = category('g', spec['groupBy'])
    if 'seriesBy' in spec:
        series = category('s', spec['seriesBy'])
    metric = spec['metric']
    op = metric['op']
    aggregate = 'COUNT(*)'
    if op != 'count':
        cell('m', metric['column'], True)
        if op in ('sum', 'avg'):
            connection.create_aggregate('chart_total', 2, _NumericTotal)
        if op == 'checkedRate':
            aggregate = '1.0 * COUNT(CASE WHEN m.value = 1 THEN 1 END) / NULLIF(COUNT(*), 0)'
        elif op == 'value':
            aggregate = 'm.value'
        else:
            aggregate = _NUMERIC_AGGREGATES[op]
    comparison = None
    if 'compare' in spec:
        cell('n', spec['compare'], True)
        comparison = aggregate.replace('m.value', 'n.value')
    return joins, arguments, group, series, aggregate, comparison


def _histogram_bounds(connection, source, parameters, bins):
    minimum, maximum = connection.execute('SELECT MIN(g.value), MAX(g.value)' + source, parameters).fetchone()
    if minimum is None:
        return []
    if minimum == maximum:
        connection.create_function('chart_bin', 1, lambda value: 0, deterministic=True)
        return [minimum, maximum]
    # Round boundaries once so bin labels and exact decimal boundaries agree.
    low, high = Fraction(minimum), Fraction(maximum)
    inner = {float(low + (high - low) * i / bins) for i in range(1, bins)}
    edges = [minimum, *sorted(edge for edge in inner if minimum < edge < maximum), maximum]
    connection.create_function('chart_bin', 1, lambda value: min(len(edges) - 2, bisect_right(edges, value) - 1),
                               deterministic=True)
    return edges


def detail_rows(connection, columns, where, parameters, spec, detail, size):
    if (not isinstance(detail, dict) or type(detail.get('page', 1)) is not int or not 1 <= detail.get('page', 1) <= 100000
            or any(not isinstance(detail.get(key, ''), str) or len(detail.get(key, '')) > 65536 for key in ('key', 'series'))):
        raise NotesError('图表明细格式无效', code='invalid_chart')
    joins, arguments, group, series, _, _ = _chart_query(connection, columns, spec)
    values = [*arguments, *parameters]
    if spec['type'] == 'histogram':
        bounds = _histogram_bounds(connection, f' FROM records AS r{joins}{where}', values, spec['bins'])
        if not bounds:
            return {}, 1, 0
        group = 'chart_bin(g.value)'
    elif spec['type'] == 'scatter':
        group = 'r.id'
        where += ' AND m.value IS NOT NULL'
    for expression, key in ((group, 'key'), (series, 'series')):
        if expression is not None:
            where += f' AND CAST({expression} AS TEXT)=?'
            values.append(detail.get(key, ''))
    op = spec['metric']['op']
    if op in _NUMERIC_AGGREGATES:
        alias = 'n' if detail.get('series') == spec.get('compare') and 'compare' in spec else 'm'
        where += f' AND {alias}.value IS NOT NULL'
    source = f' FROM records AS r{joins}{where}'
    total = connection.execute('SELECT COUNT(DISTINCT r.id)' + source, values).fetchone()[0]
    page = min(detail.get('page', 1), max(1, (total + size - 1) // size))
    records = {row['id']: {'id': row['id'], 'values': {}} for row in connection.execute(
        'SELECT DISTINCT r.id, r.position' + source + ' ORDER BY r.position LIMIT ? OFFSET ?',
        [*values, size, (page - 1) * size])}
    return records, page, total


def _check_value(value):
    if value is not None and not math.isfinite(value):
        raise NotesError('图表汇总数值超出范围', status=422, code='chart_numeric_range')
    return value


def summarize(connection, columns, where, parameters, chart):
    spec = configuration(columns, chart)
    result = {'fields': _fields(columns), 'chart': spec, 'groups': []}
    if spec is None:
        return result
    joins, arguments, group, series, aggregate, comparison = _chart_query(connection, columns, spec)
    source = f' FROM records AS r{joins}{where}'
    values = [*arguments, *parameters]
    if spec['type'] == 'histogram':
        bounds = _histogram_bounds(connection, source, values, spec['bins'])
        if bounds:
            counts = dict(connection.execute('SELECT chart_bin(g.value) AS bucket, COUNT(*)' + source +
                                             ' GROUP BY bucket', values).fetchall())
            result['groups'] = [{'key': str(i), 'label': '', 'lower': start, 'upper': stop, 'value': counts.get(i, 0)}
                                for i, (start, stop) in enumerate(zip(bounds, bounds[1:]))]
        return result
    if spec['type'] == 'scatter':
        points = connection.execute('SELECT r.id, g.value, m.value' + source +
                                    ' AND m.value IS NOT NULL ORDER BY r.position LIMIT ?', [*values, MAX_SCATTER_POINTS + 1]).fetchall()
        if len(points) > MAX_SCATTER_POINTS:
            raise NotesError(f'散点图超过 {MAX_SCATTER_POINTS} 个点，请缩小筛选范围', status=422, code='chart_point_limit')
        result['groups'] = [{'key': key, 'label': '', 'x': x, 'value': y} for key, x, y in points]
        return result
    if group is None:
        value = connection.execute(f'SELECT {aggregate}' + source, values).fetchone()[0]
        result['groups'] = [{'key': '', 'label': '', 'value': _check_value(value)}]
        return result
    limit = MAX_DOUGHNUT_GROUPS if spec['type'] == 'doughnut' else MAX_GROUPS
    rows = connection.execute(f'SELECT {group} AS bucket, {aggregate} AS metric, {series or "NULL"} AS series, '
                              f'{comparison or "NULL"} AS comparison' + source +
                              ' GROUP BY bucket, series ORDER BY bucket, series LIMIT ?',
                              [*arguments, *parameters, limit * (MAX_SERIES if series else 1) + 1]).fetchall()
    if len({row['bucket'] for row in rows}) > limit:
        raise NotesError(f'图表分组超过 {limit} 个，请缩小筛选范围或使用更粗的日期粒度',
                         status=422, code='chart_group_limit')
    if len({row['series'] for row in rows}) > MAX_SERIES:
        raise NotesError(f'图表系列超过 {MAX_SERIES} 个，请缩小筛选范围', status=422, code='chart_series_limit')
    column = columns[spec['groupBy']]
    labels = column.get('choice_ids', {})
    groups = {}
    series_points = {}
    if comparison:
        for key in (spec['metric']['column'], spec['compare']):
            series_points[key] = {'key': key, 'label': columns[key]['name'], 'values': {}}
    series_labels = columns[spec['seriesBy']].get('choice_ids', {}) if series else {}
    for key, value, series_key, compared in rows:
        point = {'key': str(key), 'label': labels.get(key, str(key)), 'value': _check_value(value)}
        if spec['type'] in _CATEGORIES:
            point['colorKey'] = hashlib.sha256(point['key'].encode('utf-8')).hexdigest()
        groups.setdefault(key, point)
        if series:
            entry = series_points.setdefault(series_key, {'key': str(series_key),
                'label': series_labels.get(series_key, str(series_key)),
                'colorKey': hashlib.sha256(str(series_key).encode('utf-8')).hexdigest(), 'values': {}})
            entry['values'][point['key']] = point['value']
        elif comparison:
            series_points[spec['metric']['column']]['values'][point['key']] = point['value']
            series_points[spec['compare']]['values'][point['key']] = _check_value(compared)
    groups = list(groups.values())
    if labels:
        order = {key: index for index, key in enumerate(labels)}
        groups.sort(key=lambda point: order.get(point['key'], len(order)))
    values = [point['value'] for point in groups if point['value'] is not None]
    if spec['type'] == 'doughnut' and values and (min(values) < 0 or max(values) == 0):
        raise NotesError('环形图需要非负的汇总值，且至少有一组大于零', status=422, code='chart_metric_domain')
    result['groups'] = groups
    if series_points:
        if series_labels:
            order = {key: index for index, key in enumerate(series_labels)}
            series_points = dict(sorted(series_points.items(), key=lambda item: order.get(item[0], len(order))))
        result['series'] = list(series_points.values())
    return result
