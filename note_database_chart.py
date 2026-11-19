"""Query and projection rules for charts over one note database."""

import json
import math

from notes_library import NotesError


QUERY_BUDGET_SECONDS = 1
MAX_GROUPS = 500
MAX_DOUGHNUT_GROUPS = 24
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


def _configuration(columns, chart):
    if chart is None:
        chart = _default_chart(columns)
        if chart is None:
            return None
    if not isinstance(chart, dict):
        raise NotesError('图表配置格式无效', code='invalid_chart')
    group_id = chart.get('groupBy')
    column = columns.get(group_id) if isinstance(group_id, str) else None
    if column is None:
        raise NotesError('图表分组列不存在，请重新选择', code='invalid_chart')
    kind, chart_type = column['type'], chart.get('type')
    if chart_type not in _GROUP_TYPES.get(kind, ()):
        raise NotesError('此分组列不支持该图表类型', code='invalid_chart')
    metric = chart.get('metric', {'op': 'count'})
    op = metric.get('op') if isinstance(metric, dict) else None
    if not isinstance(op, str) or (op != 'count' and op not in _NUMERIC_AGGREGATES):
        raise NotesError('图表汇总方式无效', code='invalid_chart')
    metric_column = metric.get('column')
    if op == 'count':
        if metric_column is not None:
            raise NotesError('记录数无需选择指标列', code='invalid_chart')
    elif (kind == 'multiSelect' or not isinstance(metric_column, str)
          or columns.get(metric_column, {}).get('type') != 'number'):
        raise NotesError('请选择有效的数字指标列与分组列', code='invalid_chart')
    spec = {'type': chart_type, 'groupBy': group_id, 'metric': {'op': op}}
    if metric_column is not None:
        spec['metric']['column'] = metric_column
    bucket = chart.get('bucket', 'day' if kind == 'date' else None)
    if kind == 'date':
        if not isinstance(bucket, str) or bucket not in _DATE_BUCKETS:
            raise NotesError('日期分组粒度无效', code='invalid_chart')
        spec['bucket'] = bucket
    elif bucket is not None:
        raise NotesError('日期粒度仅适用于日期列', code='invalid_chart')
    return spec


def _fields(columns):
    return [
        {'id': field['id'], 'name': field['name'], 'type': field['type'], 'hidden': bool(field['hidden']),
         'groupCharts': list(_GROUP_TYPES.get(field['type'], ())),
         'metrics': list(_NUMERIC_AGGREGATES) if field['type'] == 'number' else []}
        for field in columns.values() if field['type'] in _GROUP_TYPES or field['type'] == 'number'
    ]


def chart_options(columns):
    return {'fields': _fields(columns), 'suggested': _configuration(columns, None)}


def _has_views(connection):
    return connection.execute("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='chart_views'").fetchone() is not None


def read_view(connection, database_id, columns):
    result = {'mode': 'data', 'chart': None, 'valid': False}
    if not _has_views(connection):
        return result
    saved = connection.execute('SELECT mode,chart FROM chart_views WHERE database_id=?', (database_id,)).fetchone()
    if not saved:
        return result
    result['mode'] = saved['mode']
    try:
        result['chart'] = json.loads(saved['chart'])
        result['valid'] = result['chart'] is not None and _configuration(columns, result['chart']) is not None
    except (ValueError, RecursionError):
        pass
    return result


def set_view(connection, database_id, columns, action):
    current = read_view(connection, database_id, columns)
    mode = action.get('mode')
    chart = current['chart']
    if mode == 'chart':
        chart = action.get('chart', chart)
        if chart is None:
            raise NotesError('请先选择图表配置', code='invalid_chart')
        chart = _configuration(columns, chart)
    elif mode != 'data' or 'chart' in action:
        raise NotesError('图表视图格式无效', code='invalid_chart')
    if mode == current['mode'] and chart == current['chart']:
        return False
    connection.execute('''CREATE TABLE IF NOT EXISTS chart_views(
        database_id TEXT PRIMARY KEY REFERENCES databases(id),
        mode TEXT NOT NULL CHECK(mode IN ('data','chart')), chart TEXT NOT NULL)''')
    connection.execute('''INSERT INTO chart_views(database_id,mode,chart) VALUES(?,?,?)
        ON CONFLICT(database_id) DO UPDATE SET mode=excluded.mode,chart=excluded.chart''',
        (database_id, mode, json.dumps(chart, separators=(',', ':'))))
    return True


def delete_views(connection, identities):
    if _has_views(connection):
        connection.executemany('DELETE FROM chart_views WHERE database_id=?', ((identity,) for identity in identities))


def summarize(connection, columns, where, parameters, chart):
    spec = _configuration(columns, chart)
    result = {'fields': _fields(columns), 'chart': spec, 'groups': []}
    if spec is None:
        return result

    column = columns[spec['groupBy']]
    kind = column['type']
    group = _DATE_BUCKETS[spec['bucket']] if kind == 'date' else 'g.value'
    joins = ' JOIN cells AS g ON g.database_id=r.database_id AND g.row_id=r.id AND g.column_id=?'
    if kind == 'checkbox':
        # The table displays both an unset checkbox and a stored false as unchecked.
        joins = ' LEFT' + joins
        group = 'COALESCE(g.value, 0)'
    elif kind == 'multiSelect':
        joins += ' JOIN json_each(g.value) AS tag'
        group = 'tag.value'
    arguments = [column['id']]
    metric = spec['metric']
    op = metric['op']
    aggregate = 'COUNT(*)'
    if op != 'count':
        joins += ' LEFT JOIN cells AS m ON m.database_id=r.database_id AND m.row_id=r.id AND m.column_id=?'
        arguments.append(metric['column'])
        if op in ('sum', 'avg'):
            connection.create_aggregate('chart_total', 2, _NumericTotal)
        aggregate = _NUMERIC_AGGREGATES[op]
    limit = MAX_DOUGHNUT_GROUPS if spec['type'] == 'doughnut' else MAX_GROUPS
    rows = connection.execute(f'SELECT {group} AS bucket, {aggregate} AS metric FROM records AS r{joins}{where}'
                              ' GROUP BY bucket ORDER BY bucket LIMIT ?', [*arguments, *parameters, limit + 1]).fetchall()
    if len(rows) > limit:
        raise NotesError(f'图表分组超过 {limit} 个，请缩小筛选范围或使用更粗的日期粒度',
                         status=422, code='chart_group_limit')
    labels = column.get('choice_ids', {})
    groups = []
    for key, value in rows:
        if value is not None and not math.isfinite(value):
            raise NotesError('图表汇总数值超出范围', status=422, code='chart_numeric_range')
        groups.append({'key': str(key), 'label': labels.get(key, str(key)), 'value': value})
    if labels:
        order = {key: index for index, key in enumerate(labels)}
        groups.sort(key=lambda point: order.get(point['key'], len(order)))
    values = [point['value'] for point in groups if point['value'] is not None]
    if spec['type'] == 'doughnut' and values and (min(values) < 0 or max(values) == 0):
        raise NotesError('环形图需要非负的汇总值，且至少有一组大于零', status=422, code='chart_metric_domain')
    result['groups'] = groups
    return result
