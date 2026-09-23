# 原始慢日志块（cdb-slowlog）

页面里插一个块：填 **IP / 端口 / 开始时间 / 结束时间**，点「查询」，经 CDB 诊断 MCP 拉**原始慢日志**（逐条返回，不经 pt-query-digest 聚合），**按 `mcp-inspector` 的格式**渲染成 MySQL 原始慢日志文本。无头插件，不占窗口。

- 调的是 MCP 工具 `cdb.slow.export_raw_slow_log`（网关 `execute_tools`）。
- **CDB 的入参不是 ip/port**：接口要 `long_instance_id` + `role` + `region`。块会在 host 侧先用 `cdb.metadata.list_instance_metainfo_cdb_preprocess`（用你填的 ip+port+时间窗）反查 `long_instance_id` / `region`，查到的实例信息会回显在状态行；也可以在「高级」里手工填 `long_instance_id` 跳过反查。
- 产品分支：`CDB`（ip+port 反查 / 手工 long_instance_id + region + role）、`TDSQL-C`（node_uuid + region）、`TDSQL`（ip + port，走 CLS，不支持 conditions）。
- 过滤与排序：`query_time ≥ N 秒`（CDB / TDSQL-C 生效）、排序可选时间升序/降序、`query_time` 降序。
- **翻页是真翻页**：每页按 `limit` 取，下一页带游标 `conditions: [{field:"log_timestamp", operator:">", value:<上页最后一条时间>}]` 继续拉。已翻过的页缓存在块里，上一页/第一页不需要重新请求。本页返回条数不足一页即到底。

## 呈现格式（与 mcp-inspector 对齐）

外面是**数据条目卡片**：`#序号 · 工具名(cdb.slow.export_raw_slow_log) · 上下文(instance/时间窗/region/条数) · ⤢ 全屏`，与 mcp-inspector 的 `.data-entry / .entry-head` 同构。

里面是**深色终端块**（`#17191f` 底 / 等宽 12.5px / `white-space:pre-wrap`），每条记录还原成 MySQL slow log 原文，空行分隔：

```
# Time: 260916  6:39:11
# User@Host: replicuser[replicuser] @  [10.55.109.127]  Id: 0
# Query_time: 8390233.626881  Lock_time: 0 Rows_sent: 1  Rows_examined: 0
SET timestamp=1789511951;
Binlog Dump GTID

# Time: 260916  7:01:44
# User@Host: etl_user[etl_user] @  [10.97.128.66]  Id: 0
# Query_time: 14.092064  Lock_time: 0.000040999999999999994 Rows_sent: 1  Rows_examined: 26712153
SET timestamp=1789513304;
select min(id), max(id), count(*) from notice_send_history where (created_at >= '2026-07-17 00:00:00' and created_at < '2026-07-18 00:00:00')
```

字段规则（照抄 mcp-inspector 的实现）：

- `# Time:` → `YYMMDD  H:MM:SS`（如 `2026-09-16T06:39:11+08:00` → `260916  6:39:11`）。
- `# User@Host:` → `user[user] @  [host]  Id: thread_id`（`user_host` 里已带 `@` 或 `[` 就原样输出）。
- `# Query_time:` → 只拼有值的字段，标点间距与 MySQL 一致（`Query_time:  X  Lock_time: Y Rows_sent: Z  Rows_examined: W`）。
- `SET timestamp=` → 时间转 unix 秒（毫秒值自动 /1000）。
- SQL 原文取 `sql_raw_text` → `sql_text` → `content`，**多行 SQL 的换行原样保留**。
- 命中「复制慢日志」可一键复制当前页全部文本（可直接粘进编辑器当 slow log 用）；`⤢` 全屏看同内容（Esc 关闭）。
- **不会卡死**：单次查询 120 秒超时，失败给明确原因 + 「重试」按钮。

## 示例写法

围栏头：`kind=cdb-slowlog plugin=cdb-slowlog`。围栏体是 JSON，`pages` 由块自己写，**不要手写 `pages`**。

```md
:::pageBlock {kind=cdb-slowlog plugin=cdb-slowlog}
{
  "product": "CDB",
  "ip": "10.0.0.1",
  "port": "3306",
  "region": "",
  "role": "master",
  "startTime": "2025-09-17 10:00:00",
  "endTime": "2025-09-17 11:00:00",
  "pageSize": 50,
  "orderBy": "log_timestamp asc"
}
:::
```

可写字段：

- `product`：`CDB` / `TDSQL-C` / `TDSQL`。
- `ip` / `port`：实例节点地址（CDB 用来反查 long_instance_id；TDSQL 直接作为检索条件）。
- `region`：CDB / TDSQL-C 需要；留空时 CDB 会跟着 ip 一起反查。
- `role`：`master` / `slave` / `slave1` / `ro`，默认 `master`。
- `longInstanceId`：CDB 长实例 ID；留空自动反查。
- `nodeUuid`：TDSQL-C 节点 UUID。
- `startTime` / `endTime`：`YYYY-MM-DD HH:MM:SS`；留空默认最近 1 小时。
- `pageSize`：每页条数（默认 50，上限 500）。
- `minQueryTime`：`query_time` 下限（秒），留空不过滤。
- `orderBy`：`log_timestamp asc|desc` / `query_time asc|desc`。
- `pages`：分页缓存，**块自己写**。

## 接口

- `POST /api/cdb-slowlog/query`：body `{product, ip, port, region, role, longInstanceId, nodeUuid, startTime, endTime, pageSize, cursor, minQueryTime, orderBy}`，返回 `{ok, tool, args, columns[], records[], nextCursor, dataStatus, meta}`，失败返回 `{ok:false, error}`。
- `GET /api/cdb-slowlog/ping`：自检。
