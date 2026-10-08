# CDB 错误日志块（cdb-errorlog）

页面里插一个块：填 **IP / 端口 / 开始时间 / 结束时间**，点「查询」，经 CDB 诊断 MCP 拉 **MySQL 错误日志**，**每条报错一行**展示。外观与 `cdb-slowlog` 完全一致（数据条目卡片 + 深色终端块 `#17191f`）。

- 调的是 MCP 工具 `cdb.error.query_error_logs`（网关 `execute_tools`）。
- **CDB 的入参不是 ip/port**：接口要 `long_instance_id` + `role` + `region`。块会在 host 侧先用 `cdb.metadata.list_instance_metainfo_cdb_preprocess` 反查，也可在「实例 ID」栏手工填 `long_instance_id` 跳过反查。
- 产品分支：`CDB`（ip+port 反查）、`TDSQL-C`（node_uuid + region）、`TDSQL`（ip + port）。

## 行格式（关键需求）

每条报错**压成一行**（`\n` / `\t` / 连续空白都会折叠成单个空格），格式为：

```
时间戳  具体报错
```

若该条带等级或错误码，则在时间戳与内容之间插一个中括号标记：

```
2026-09-20 19:11:47  [ERROR MY-013183] InnoDB: Assertion failure in thread ...
```

**为什么必须压成一行**：MySQL 错误日志的 `content` 常带多行文本与堆栈，原样渲染会让「多少条报错」看不出来。压平后块里**一行 = 一条报错**，行数就是条数。

## 过滤

`where_condition` 由块自动拼装，**始终包含时间范围**（接口硬性要求）：

```sql
log_timestamp > '2026-09-20 18:15:00' AND log_timestamp < '2026-09-20 19:15:00'
  AND level = 'error'          -- 「等级」下拉，留空=全部
  AND content LIKE '%crash%'   -- 「内容含」输入框，可选
```

**安全约束（接口沙箱）**：`where_condition` 不允许分号，也不允许出现 `SELECT / UPDATE / DELETE / DROP / ALTER / CREATE / TRUNCATE / REPLACE / MERGE / GRANT / REVOKE` 等关键词 —— 块在发请求前会先本地校验并报错，不会把非法条件送出去。内容关键词里的单引号会被剥掉，避免拼串越界。

## 接口预算

- 后端**强制 `LIMIT 200`**，且**返回结果不超过 10KB** —— 所以极端窗口下可能拿到不足 200 条，这是接口侧的硬边界，不是块丢数据。
- 窗口越窄越准；查不到就换窗口、放宽等级、或清掉内容过滤。

## 呈现格式（与 mcp-inspector / cdb-slowlog 对齐）

外面是**数据条目卡片**：`#1 · 工具名(cdb.error.query_error_logs) · 上下文(时间窗 · WHERE · 条数) · ⤢ 全屏`。

里面是**深色终端块**（`#17191f` 底 / 等宽 12.5px / `white-space:pre-wrap`），一条一行。

- **复制错误日志**：卡片内与全屏里都能一键复制全文，可直接粘进工单/编辑器。
- **全屏**：点 `⤢` 打开覆盖层（Esc 或点空白关闭）；实现用 React Portal 到 `document.body`（编辑器给 `.page-block` 加了 `overflow:hidden` + `isolation:isolate`，就地 fixed 会被裁掉）。
- **重跑**：卡片内直接重跑当前参数。
- **不会卡死**：单次查询 120 秒超时，失败给明确原因 + 「重试」。

## 示例写法

围栏头：`kind=cdb-errorlog plugin=cdb-errorlog`。围栏体是 JSON，`result` 由块自己写，**不要手写 `result`**。

```md
:::pageBlock {kind=cdb-errorlog plugin=cdb-errorlog id=9a3f21c7}
{
  "product": "CDB",
  "ip": "29.23.168.7",
  "port": "20423",
  "region": "ap-beijing",
  "role": "master",
  "startTime": "2026-09-20 18:15:00",
  "endTime": "2026-09-20 19:15:00",
  "level": "error",
  "keyword": ""
}
:::
```

可写字段：

- `product`：`CDB` / `TDSQL-C` / `TDSQL`。
- `ip` / `port`：实例节点地址（CDB 用来反查 long_instance_id；TDSQL 直接作为检索条件）。
- `region`：CDB / TDSQL-C 需要；留空时 CDB 会跟着 ip 一起反查。
- `role`：`master` / `slave` / `slave1` / `ro`，默认 `master`。
- `longInstanceId`：CDB 长实例 ID；留空自动反查。
- `startTime` / `endTime`：`YYYY-MM-DD HH:MM:SS`；留空默认最近 1 小时。**必须 start < end**。
- `level`：`""`(全部) / `error` / `warning` / `note` / `system`。
- `keyword`：内容子串过滤，留空不过滤。
- `result`：查询结果快照，**块自己写**。

## 接口

- `POST /api/cdb-errorlog/query`：body `{product, ip, port, region, role, longInstanceId, startTime, endTime, level, keyword}`，返回 `{ok, tool, args, startTime, endTime, whereCondition, dataStatus, total, entries[], meta}`，失败返回 `{ok:false, error}`。
  - `entries[]`：`{line, ts, level, code, content, thread}` —— `line` 就是终端块里那一行。
- `GET /api/cdb-errorlog/ping`：自检。

**agent 也可直接调**这个路由（curl 即可，无需人在页面点击），把返回的 `entries` 写进围栏的 `result`，页面打开就有数据。

## 注意事项

- 错误日志只在实例**真的出错**时才有内容；空闲实例查出来为空是正常的（`data_status=empty`）。
- 别把「窗口内无错误日志」当成接口故障 —— 换窗口/放宽等级再试。
- `content` 里的 `\n` 字面量与真实换行都会被折叠，所以**看不到原始多行结构**；要看原始多行请去控制台错误日志页，或用 `mcp-inspector`。
