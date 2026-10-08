# DBbrain 限流 & 会话（dbbrain-limit）

页面里插一个块，直连腾讯云 DBbrain OpenAPI，能做三件事：**看当前活跃会话**、**Kill 会话**、**管理 SQL 限流策略**。无头插件，不占窗口。

对标控制台的「诊断优化 → 实时会话 / SQL 限流」，但把结果摆在文档里、可反复重跑。

## 它解决什么

控制台看会话要来回点、还不好留证；批量场景（比如“把某实例上跑了超过 300 秒的会话都看一眼”）控制台没有过滤入口。这个块把 DBbrain 的过滤维度（User / DB / State / Command / 时长 / SQL 文本）全摆出来，查完可以直接在表格里逐条 Kill。

## 三个能力对应的接口

| 能力 | DBbrain 接口 | 凭证要求 |
| --- | --- | --- |
| 查活跃会话 | `DescribeMySqlProcessList` | 仅 CAM 签名 |
| Kill 会话 | `KillMySqlThreads`（Prepare + Commit） | 仅 CAM 签名 |
| 查限流任务 | `DescribeSqlFilters` | 仅 CAM 签名 |
| 建限流任务 | `CreateSqlFilter` | CAM + `VerifyUserAccount` → `SessionToken` |
| 终止限流 | `ModifySqlFilters`（仅支持 `TERMINATED`） | 同上 |
| 删限流任务 | `DeleteSqlFilters` | 同上 |

域名 `dbbrain.tencentcloudapi.com`，Version `2021-05-27`。

## 怎么用

1. 填**实例 ID**（地域留空会按实例自动解析，走 `DescribeDiagDBInstances`）。
2. **当前会话**页签：可加过滤条件（User / DB / State / Command / 时长≥N秒 / SQL 含），点「查询会话」→ 表格出结果，每行一个 `Kill` 按钮。
3. **SQL 限流**页签：
   - 勾状态（`RUNNING` / `FINISHED` / `TERMINATED`）点「查询任务」；
   - 表格里 `RUNNING` 的可「终止」，任意状态可「删除」；
   - 下方表单新建限流：SQL 类型 + 关键词 + 最大并发 + 时长。
4. **限流写操作前**需要在上方填**数据库账号密码**并点「验证账号」→ 换 `SessionToken`（宿主内存缓存 5 分钟，不落盘）。

## 全屏与文本选择

**全屏**：块右上角「全屏」按钮（或全屏后按 `Esc`）把块铺满整个视口。

实现上用的是 **React Portal 到 `document.body`**，不是就地 `position: fixed`。原因：编辑器给 `.page-block` 加了 `overflow: hidden` + `isolation: isolate`，就地做 fixed 会被裁掉、也压不住其它层的 UI。也不能像 `page-terminal` 那样"搬 DOM 到 body"——本块有大量按钮，搬走会让 React 合成事件委托链断掉，按钮全失效；Portal 仍走 React 树，事件正常。

**文本选择**：块内文字可以用鼠标拖选、双击选词、复制。

这里有个 Chrome 的坑值得记下来：

- 编辑器容器是 `contenteditable`，宿主在块外层标了 `contentEditable={false}`。
- **Chrome 会把 `contenteditable="false"` 的子树当成原子对象**，里面的文字**无法被拖选**（拖拽变成整块选中的对象拖拽）。
- 实测四种改法（同一台机器、同一段文字）：

  | 改法 | 拖选结果 |
  | --- | --- |
  | 原样 | ❌ 0 字符 |
  | 去掉外层 `.page-block` 的 `contenteditable=false` | ❌ 0 字符 |
  | 给块加 `contenteditable=true` | ✅ 10 字符 |
  | 给块加 `contenteditable=plaintext-only` | ✅ 10 字符 |

- 所以块根节点在**非全屏**时会设成可编辑岛屿换取选择权，同时用 `onBeforeInput` / `onDrop` 拦掉一切会改动内容的输入（块是只读的），并配 `caretColor: transparent` 隐掉随之出现的闪烁光标。嵌套的 `input` / `select` 照常可编辑（guard 会放行）。
- 另外，宿主在 `.page-block` 上挂了 `onMouseDown` → `setNodeSelection()`，会把块内任意 mousedown 变成"选中整个节点"。块根节点的 `onMouseDown` 截断冒泡即可解掉这一层劫持（否则即便能选也会被节点选中打断）。
- **全屏时不需要这些**：Portal 已经把块移出编辑器，脱离 `contenteditable` 后原生选择直接可用。

验证方式（headless Chrome + CDP 真实鼠标事件）：

```
① 非全屏 拖选        → 选中 10 字符，块未被整节点选中
② 非全屏 往块里打字  → 内容长度不变，未插入
③ 非全屏 输入框聚焦  → 正常
④ 点全屏            → position:fixed, z-index:2147483646, 1500×1000 = 视口，父节点 BODY
⑤ 全屏 拖选          → 选中 21 字符
⑥ Esc               → 退出全屏，回到 static
```

## 安全设计（重要）

- **CAM 凭证**：优先读环境变量 `TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY`；否则读 `.biu/cdb-limit-secret.json`（建议 `chmod 600`，`.biu/` 已在 `.gitignore` 里）。**凭证只在宿主侧使用，不回传浏览器**，自检接口只回脱敏后的 SecretId。
- **数据库密码**：**不持久化**、不写进块数据、不落盘。只用于当次换 token。
- **结果不入文档**：块数据只存输入（实例 ID / 地域 / 页签 / 账号名），**查询结果不写回 markdown**——避免页面文件被撑大。
- **Kill 的确认**：不做批量一键 Kill。每个操作都弹内联确认条，展示目标会话的 ID / user / db / time / 完整 SQL，确认后才执行。
- **两阶段同请求内连做**：文档明确 Prepare 与 Commit 间隔**不能超过 10 秒**，否则 Commit 空转。所以宿主把两阶段放在**同一次 HTTP 请求内**顺序执行，避免把窗口暴露给前端交互。
- **`MaxConcurrency=0` 的警告**：0 表示限制**所有**匹配的 SQL（全拒），界面会显式提示。

## 示例写法

围栏头：`kind=dbbrain-limit plugin=dbbrain-limit`。围栏体只放输入，`sessions` / `tasks` 等结果**不要手写**。

```md
:::pageBlock {kind=dbbrain-limit plugin=dbbrain-limit}
{
  "instanceId": "cdb-xxxxxxxx",
  "tab": "sessions"
}
:::
```

可写字段：

- `instanceId`：实例 ID
- `region`：地域，留空自动解析
- `tab`：`sessions`（默认）/ `filters`
- `authUser`：数据库账号名（**只存账号名，不存密码**）
- `draft`：**新建限流表单的草稿**，用于预填表单而不下发。键与表单一一对应：

  ```json
  "draft": {
    "sqlType": "SELECT",
    "filterKey": "sbtest4,76058340193",
    "maxConcurrency": "2",
    "duration": "3600"
  }
  ```

  - `sqlType`：`SELECT` / `UPDATE` / `DELETE` / `INSERT` / `REPLACE`
  - `filterKey`：关键词，英文逗号分隔（**逗号 = 逻辑与**）
  - `maxConcurrency`：字符串形式的最大并发（`"0"` = 限制所有匹配的 SQL）
  - `duration`：字符串形式的时长秒数（`"-1"` = 永不过期）

  界面上编辑这四个框会**防抖回写** `draft`；点「创建限流」成功后关键词会被清空（避免误重复创建）。
  **预填草稿不会下发任何规则**——必须人在界面上点「创建限流」才生效。这是给「先把配置摆好、再决定要不要执行」这个用法留的口子。

  > 注意：块的 `update()` 是**整段覆写**块数据。若在页面打开期间从外部改围栏，块可能用自己内存里的旧快照把它覆盖回去；改完围栏建议刷新页面再操作。

## 接口

| 路由 | 用途 |
| --- | --- |
| `GET /api/dbbrain-limit/status` | 自检：凭证是否存在（脱敏）、API 版本、托管实例数 |
| `POST /api/dbbrain-limit/instances` | 实例检索（`{q, force}`），用于 ID → Region 解析 |
| `POST /api/dbbrain-limit/sessions` | `DescribeMySqlProcessList` |
| `POST /api/dbbrain-limit/verify` | `VerifyUserAccount` → SessionToken |
| `POST /api/dbbrain-limit/filters/list` | `DescribeSqlFilters` |
| `POST /api/dbbrain-limit/filters/create` | `CreateSqlFilter` |
| `POST /api/dbbrain-limit/filters/modify` | `ModifySqlFilters`（终止） |
| `POST /api/dbbrain-limit/filters/delete` | `DeleteSqlFilters` |
| `POST /api/dbbrain-limit/kill` | `KillMySqlThreads`（Prepare+Commit 原子执行） |

`kill` 入参：`{instanceId, region?, threads: number[], recordHistory?: boolean}`。
`recordHistory` 默认 `true`（kill 前校验目标会话是否存在，更稳）；设 `false` 可加快速度但跳过校验。

## 注意事项

- **只覆盖 MySQL / TDSQL-C**。MongoDB、Redis 的会话与限流不走这些接口。
- 实例必须**在 DBbrain 托管范围内**，否则返回 `InvalidParameterValue - InstanceId is invalid`。用「凭证 OK」旁边的实例数确认。
- `ModifySqlFilters` 的 `Status` **只支持 `TERMINATED`**，不是通用状态修改。
- 高频限制 20 次/秒，正常交互远低于此。
- 查会话是**单时刻快照**；要看时间窗内的会话历史/趋势，用 `cdb-processlist` 块或 CDB 诊断 MCP。
