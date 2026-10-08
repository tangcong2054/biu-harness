# Processlist 原始快照块（cdb-processlist）

页面里插一个块：填 **IP / 端口 / 开始时间 / 结束时间**，点「查询」，经 CDB 诊断 MCP 拉**原始 processlist 快照**（不聚合、不降采样），**按 `mcp-inspector` 的终端 CSV 格式**分块展示。无头插件，不占窗口。

- 调的是 MCP 工具 `cdb.processlist.query_processlist_raw_logs`（网关 `execute_tools`）。
- 接口语义（决定你能看到多少数据，务必知道）：
  - **时间点模式**（开始 == 结束）：取该时刻往后最近的 1 个采样点，返回整份快照（单快照最多 1000 行）。
  - **时间窗模式**（开始 < 结束）：取窗口内从 start 往后**前 4 个采样点**，每个采样点按 `TIME` 降序取 TopN 行（块里的「TopN/点」，默认 10）。
  - 响应整体 ≤ 20k 字节，`INFO` 超 512 字节会截断；被截断时参数条会标「已截断」。

## 呈现格式（与 mcp-inspector 对齐）

```
---------------2026-09-16 06:38:03---------------
ID,USER,HOST,db,COMMAND,TIME,STATE,INFO
255177,tencentroot,9.172.245.31:53944,,Binlog Dump GTID,15379710,Master has sent all binlog to slave; waiting for more updates,
5140340,replicuser,10.55.109.127:36398,,Binlog Dump GTID,8390166,Master has sent all binlog to slave; waiting for more updates,
10645085,tencentroot,127.0.0.1:46286,,Query,0,executing,"select DATE_FORMAT(NOW(), ...) ORDER BY TIME"
```

- 外面是**数据条目卡片**：`#序号 · 工具名(cdb.processlist.query_processlist_raw_logs) · 上下文(ip:port · 时间窗 · 采样点数 · 行数) · ⤢ 全屏`，与 mcp-inspector 的 `.data-entry / .entry-head` 同构。
- 里面是**深色终端块**（`#17191f` 底 / 等宽 12.5px / `white-space:pre`），每行一个采样点分块：一条 `---------------时间---------------` + CSV 表头 + 数据行。列序固定 `ID,USER,HOST,db,COMMAND,TIME,STATE,INFO`。
- **清洗**：采集链路塞在 `INFO` 尾部的行结束哨兵 `#X_X#Y_Y#` 与 `-----…` 分隔线会被去掉；`NULL` 显示为空；含 `,` 或 `"` 的值按 CSV 规则加引号转义——保证「一行就是一行」，不会被换行/制表符撑破。
- **翻页**：页内分页（100 / 200 / 500 行 + 上一页/下一页），跨页时该采样点标「（接上页）」；另有「采样点」标签可只看某一个采样点（显示 `返回行数/该快照真实总行数 total`）。
- **全屏**：点 `⤢` 打开覆盖层，展示**全部采样点的完整 CSV**（不分页），Esc 或点空白关闭。
- **复制 CSV**：卡片内与全屏里都能一键复制完整 CSV（可直接粘进 Excel / 存成 .csv）。
- **「下一批采样点」按钮**：把起点挪到当前最后一个采样点 +1s 重新查询——接口一次只给窗口内前 4 个采样点，这是唯一继续往后看的方式。

## 示例写法

围栏头：`kind=cdb-processlist plugin=cdb-processlist`。围栏体是 JSON，`result` 由块自己写，**不要手写 `result`**。

```md
:::pageBlock {kind=cdb-processlist plugin=cdb-processlist}
{
  "product": "CDB",
  "ip": "10.0.0.1",
  "port": "3306",
  "startTime": "2025-09-17 10:00:00",
  "endTime": "2025-09-17 10:10:00",
  "limit": 10
}
:::
```

可写字段：

- `product`：`CDB` / `TDSQL-C` / `TDSQL`。
- `ip` / `port`：实例节点地址。
- `startTime` / `endTime`：`YYYY-MM-DD HH:MM:SS`；**相等即时间点模式**（看整份快照），留空默认最近 10 分钟。
- `limit`：时间窗模式下每个采样点的 TopN（按 TIME 降序）。
- `result`：查询结果快照，**块自己写**。

## 接口

- `POST /api/cdb-processlist/query`：body `{product, ip, port, startTime, endTime, limit}`，返回 `{ok, title[], snapshots[{timestamp,total,rows[][]}], dataStatus, truncation}`，失败返回 `{ok:false, error}`。
- `GET /api/cdb-processlist/ping`：自检。
