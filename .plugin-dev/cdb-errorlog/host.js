// CDB 错误日志块 —— host 侧
// 路由：POST /api/cdb-errorlog/query
// 调用 MCP：cdb.error.query_error_logs（网关 execute_tools）。只读。

const PLUGIN = 'cdb-errorlog'
const INJECT = ['http', 'mcp']
const MCP_SERVER = 'cloud-dba-ai-cdb-mcpserver'
const TOOL = 'cdb.error.query_error_logs'

function s(v, dflt = '') {
  return typeof v === 'string' && v.trim() ? v.trim() : dflt
}
function pad2(n) { return String(n).padStart(2, '0') }
function fmt(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
}
function normProduct(v) {
  const p = s(v, 'CDB').toUpperCase()
  if (p === 'TDSQL-C' || p === 'TDSQLC' || p === 'CYNOS') return 'TDSQL-C'
  if (p === 'TDSQL') return 'TDSQL'
  return 'CDB'
}
function textOf(res) {
  const r = res ?? {}
  return Array.isArray(r.content)
    ? r.content.map(x => (x && typeof x.text === 'string' ? x.text : '')).filter(Boolean).join('\n')
    : ''
}
function brief(v) {
  return (typeof v === 'string' ? v : JSON.stringify(v ?? '')).replace(/\s+/g, ' ').trim().slice(0, 500)
}
function unwrap(res) {
  const r = res ?? {}
  const txt = textOf(res).trim()
  if (r.isError === true) return { ok: false, data: null, error: brief(txt) || 'MCP 调用失败' }
  let v = res
  if (txt) { try { v = JSON.parse(txt) } catch { v = txt } }
  if (typeof v === 'string') {
    const t = v.trim()
    return /^\[(gateway|error)\]/i.test(t) ? { ok: false, data: v, error: t.slice(0, 500) } : { ok: true, data: t }
  }
  const o = v ?? {}
  if (typeof o.status === 'string' && o.status.toLowerCase() === 'error') {
    return { ok: false, data: o, error: brief(o.error_message ?? o.message ?? 'status=error') }
  }
  return { ok: true, data: o }
}
async function callTool(ctx, toolName, args) {
  try {
    const res = await ctx.mcp.call(MCP_SERVER, 'execute_tools', { tool_name: toolName, arguments: args })
    return unwrap(res)
  } catch (e) {
    return { ok: false, data: null, error: brief(String(e)) }
  }
}
function payloadOf(data) {
  const d = data && data.data
  return d && typeof d === 'object' && !Array.isArray(d) ? d : data
}
async function resolveInstance(ctx, ip, port, startTime, endTime) {
  const r = await callTool(ctx, 'cdb.metadata.list_instance_metainfo_cdb_preprocess',
    { ip, port: Number(port) || port, start_time: startTime, end_time: endTime })
  if (!r.ok) return { error: r.error ?? '反查实例元数据失败' }
  const meta = payloadOf(r.data).instance_meta ?? {}
  return {
    longInstanceId: s(meta.long_instance_id),
    region: s(meta.region),
    instanceId: s(meta.instance_id),
    vip: s(meta.vip),
    vport: meta.vport == null ? '' : String(meta.vport),
  }
}

const FORBIDDEN = /\b(delete|update|insert|drop|alter|create|truncate|replace|merge|grant|revoke|select)\b/i

function buildWhere(startTime, endTime, level, keyword) {
  const parts = [
    "log_timestamp > '" + startTime + "'",
    "log_timestamp < '" + endTime + "'",
  ]
  const lv = s(level)
  if (lv && lv.toLowerCase() !== 'all') parts.push("level = '" + lv + "'")
  const kw = s(keyword)
  if (kw) parts.push("content LIKE '%" + kw.replace(/'/g, '') + "%'")
  return parts.join(' AND ')
}

// 关键：把一条错误日志压成"一行"（去掉换行/制表/连续空白）
function oneLine(v) {
  return s(v)
    .replace(/\\n/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function apply(ctx) {
  ctx.http.route('GET', '/api/cdb-errorlog/ping', (req) => {
    req.send(200, { ok: true, plugin: PLUGIN, tool: TOOL })
  })

  ctx.http.route('POST', '/api/cdb-errorlog/query', async (req) => {
    let body = {}
    try { body = (await req.json()) ?? {} } catch { body = {} }

    const product = normProduct(body.product)
    const ip = s(body.ip)
    const port = s(body.port, '3306')
    const now = new Date()
    const endTime = s(body.endTime, fmt(now))
    const startTime = s(body.startTime, fmt(new Date(now.getTime() - 3600e3)))
    const role = s(body.role, 'master')
    const level = s(body.level)
    const keyword = s(body.keyword)
    const rawLimit = Number(body.limit)
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.round(rawLimit), 200) : 200

    if (!startTime || !endTime || startTime >= endTime) {
      req.send(400, { ok: false, error: '时间范围不合法：startTime 必须早于 endTime（接口要求必带时间范围）' })
      return
    }
    if (product === 'TDSQL-C' && !s(body.region)) { req.send(400, { ok: false, error: 'TDSQL-C 需要填写 region' }); return }
    if (product === 'CDB' && !ip && !s(body.longInstanceId)) { req.send(400, { ok: false, error: 'CDB 需要填写 IP（或直接给 long_instance_id）' }); return }
    if (product === 'TDSQL-C' && !s(body.nodeUuid)) { req.send(400, { ok: false, error: 'TDSQL-C 需要填写 node_uuid' }); return }
    if (product === 'TDSQL' && !ip) { req.send(400, { ok: false, error: 'TDSQL 需要填写 IP' }); return }

    const meta = {}
    let longInstanceId = s(body.longInstanceId)
    let region = s(body.region)
    if (product === 'CDB' && (!longInstanceId || !region)) {
      const r = await resolveInstance(ctx, ip, port, startTime, endTime)
      if (r.error) { req.send(200, { ok: false, error: r.error, need: 'long_instance_id / region' }); return }
      longInstanceId = longInstanceId || r.longInstanceId || ''
      region = region || r.region || ''
      meta.resolved = r
    }
    if (product === 'CDB' && !longInstanceId) {
      req.send(200, { ok: false, error: '没能按 ip+port 解析出 long_instance_id，请手工填写' }); return
    }

    const where = buildWhere(startTime, endTime, level, keyword)
    if (where.includes(';')) { req.send(400, { ok: false, error: 'where_condition 不允许包含分号' }); return }
    if (FORBIDDEN.test(where)) { req.send(400, { ok: false, error: 'where_condition 不允许出现 SELECT/UPDATE 等关键词' }); return }

    const args = { product, region, where_condition: where }
    if (product === 'CDB') { args.long_instance_id = longInstanceId; args.role = role }
    if (product === 'TDSQL-C') args.node_uuid = s(body.nodeUuid)
    if (product === 'TDSQL') { args.host = ip; args.port = Number(port) || port }

    const r = await callTool(ctx, TOOL, args)
    if (!r.ok) { req.send(200, { ok: false, error: r.error ?? '查询失败', args, meta }); return }

    const pl = payloadOf(r.data)
    // 注意：这个接口返回的列表字段是 logs（不是 records），两种都兼容
    const rawList = Array.isArray(pl.logs) ? pl.logs
      : (Array.isArray(pl.records) ? pl.records : [])
    const recs = rawList.filter(x => x && typeof x === 'object')

    const entries = recs.slice(0, limit).map(rec => {
      const ts = s(rec.log_timestamp ?? rec.timestamp)
      const lvl = s(rec.level).toUpperCase()
      const code = s(rec.error_code)
      const content = oneLine(rec.content ?? rec.error ?? rec.message)
      let line = ts
      const tag = [lvl, code].filter(Boolean).join(' ')
      if (tag) line += '  [' + tag + ']'
      line += '  ' + content
      return { line: line.trim(), ts, level: lvl, code, content, thread: rec.thread == null ? null : rec.thread }
    })

    req.send(200, {
      ok: true,
      tool: TOOL,
      args,
      startTime, endTime,
      whereCondition: where,
      dataStatus: typeof pl.data_status === 'string' ? pl.data_status : (entries.length ? 'ok' : 'empty'),
      total: entries.length,
      returnedCount: pl.returned_count == null ? entries.length : pl.returned_count,
      totalCount: pl.total_count == null ? entries.length : pl.total_count,
      truncated: pl.truncated === true,
      entries,
      meta: { product, longInstanceId, region, role, ...meta },
    })
  })
}

export { apply, INJECT as inject, PLUGIN as name }
