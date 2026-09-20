# SQL 限流下发（cdb-limit-onclick）

页面里插一个块，把**一条 SQL** 直接变成 DBbrain 的 SQL 限流规则：解析关键词 → 填并发/时长 → 点「创建限流」下发；顺手能看/终止该实例上的限流任务。

和 `dbbrain-limit` 的区别：那个是「会话 + 限流」的综合面板（多页签、按条件过滤会话、批量 Kill）；这个只干一件事——**一条 SQL 一键下发限流**，关键词从 SQL 里自动解析出来，少点几下、少填几个框。

## 它做什么

| 能力 | DBbrain 接口 | 凭证要求 |
| --- | --- | --- |
| 下发限流 | `CreateSqlFilter` | CAM 签名 + `VerifyUserAccount` → `SessionToken` |
| 查限流任务 | `DescribeSqlFilters` | 仅 CAM 签名 |
| 终止限流 | `ModifySqlFilters`（只支持 `Status=TERMINATED`） | 同上 |

域名 `dbbrain.tencentcloudapi.com`，Version `2021-05-27`。

## 关键词怎么解析出来的

DBbrain 的 `FilterKey` 是**对 SQL 原文做子串匹配**，多个关键词用 `,` 分隔表示**逻辑与**（全部出现才命中）。本块的 `parseSql()` 抽两类词：

1. **表名**：`from|join|update|into` 后面那个标识符，**去掉库名前缀**（`bigtable2.sbtest4` → `sbtest4`）。去前缀是因为业务用默认库时 SQL 里根本没有库名。
2. **最长的字符串字面量**：`'%76058340193%'` → `76058340193`（顺手去掉 `%` 和逗号，避免宽匹配和分隔符冲突）。

例：`select count(*) from bigtable2.sbtest4 where c like '%76058340193%';`
→ 类型 `SELECT`，关键词 `sbtest4,76058340193`。

解析结果只是**预填**，框里可以随便改。上方会实时显示最终要下发的规则：`类型,时长,并发,关键词…`。

## 示例写法

围栏头：`kind=cdb-limit-onclick plugin=cdb-limit-onclick`。围栏体放输入；`tasks` 之类查询结果**不要手写**。

```md
:::pageBlock {kind=cdb-limit-onclick plugin=cdb-limit-onclick}
{
  "instanceId": "cdb-b9gntnn0",
  "region": "ap-beijing",
  "authUser": "tanontang",
  "sql": "select count(*) from bigtable2.sbtest4 where c like '%76058340193%';",
  "sqlType": "SELECT",
  "filterKey": "sbtest4,76058340193",
  "maxConcurrency": "2",
  "duration": "-1"
}
:::
```

可写字段（除密码外都会随文档保存）：

- `instanceId`：实例 ID
- `region`：地域，留空按凭证地域
- `authUser`：数据库账号名（**只存账号名，不存密码**）
- `sql`：目标 SQL，用于「从 SQL 解析」
- `sqlType`：`SELECT` / `UPDATE` / `DELETE` / `INSERT` / `REPLACE`
- `filterKey`：关键词，英文逗号分隔（逗号 = 逻辑与）
- `maxConcurrency`：字符串形式的并发上限（`"0"` = 拒绝所有匹配 SQL）
- `duration`：字符串形式的秒数（`"-1"` = 永不过期）

> **预填不会下发**：块只把配置摆在界面上，必须人在块里点「创建限流」才真正生效。
> 另外块的 `update()` 是**整段覆写**块数据：页面打开期间从外部改围栏，可能被块内存里的旧快照覆盖回去，改完刷新页面再操作。

## 接口

| 路由 | 用途 |
| --- | --- |
| `GET /api/cdb-limit-onclick/status` | 自检：凭证是否存在（SecretId 脱敏） |
| `POST /api/cdb-limit-onclick/list` | `DescribeSqlFilters`（`{instanceId, region?}`） |
| `POST /api/cdb-limit-onclick/create` | `VerifyUserAccount` + `CreateSqlFilter` |
| `POST /api/cdb-limit-onclick/terminate` | `ModifySqlFilters`（`{instanceId, region?, user, password, filterIds}`） |

`create` 入参：`{instanceId, region?, user, password, sqlType, filterKey, maxConcurrency, duration}`，成功后回 `{filterId, rule}`。

## 安全设计

- **CAM 凭证**：优先环境变量 `TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY`，否则读 `.biu/cdb-limit-secret.json`。**只在宿主侧用，不回传浏览器**；自检接口只回脱敏 SecretId。
- **数据库密码**：只用于当次换 `SessionToken`，**不写块数据、不落盘**；token 在宿主内存缓存 4.5 分钟（验证失败即失效重取）。
- **结果不入文档**：块数据只存输入，限流任务列表不写回 markdown，避免把页面文件撑大。

## 注意

- 只覆盖 MySQL / TDSQL-C；实例必须在 DBbrain 托管范围内。
- `ModifySqlFilters` 的 `Status` **只支持 `TERMINATED`**，不是通用状态修改。
- 关键词是子串匹配，**别填 `%`**：`sbtest4` 会命中任何含该表名的语句，`sbtest4,76058340193` 才是「精确到这条字面量」。
- `duration` 用 `-1` 不自动过期，停只能人工终止；不确定就先给 `3600`。
- 块内文字可拖选/复制；块是只读的（非全屏时根节点是 `contenteditable` 只读岛屿，输入框仍可编辑）。
