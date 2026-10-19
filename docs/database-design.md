# Biu MySQL 迁移与 Offline 云备份方案

> 更新基线：`tencent-biu` `e091e1b2`，SQLite schema v41，events schema v1。  
> 本文只描述目标架构和迁移步骤；不会在普通启动、切换分支或合并代码时自动迁移、上传或改写现有本地数据。

## 1. 最新代码变化带来的结论

`aad5fcac` 之后的提交没有修改 SQLite schema，但显著改变了列表与授权读取方式：

1. `AuthorizationService.preloadCollection()` 会按 Workspace + Collection 一次读入 `resource_policies`、`record_owners`、`record_grants`、用户分组和成员角色。
2. `DatabaseService` 会共享并缓存“可见记录 + 排序 + personal/workspace/shared 分区”结果；授权变化通过进程内 `onInvalidate()` 清缓存。
3. 列表默认每页从 50 降为 20、最大 200，但当前后端仍可能先扫描、授权、排序整张 Collection，最后才 `slice(offset, offset + limit)`。
4. Task 列表新增轻量投影，只取列表字段；完整 trigger/report/正文按需读取。
5. Web 端窗口化、延迟渲染和未登录停止轮询降低了前端与空闲请求负载，但不会自动解决后端全表扫描。

因此，MySQL 迁移不能只是把 SQLite SQL 换成 MySQL 方言。必须同时把列表查询改成“数据库分页 + 数据库授权裁剪 + 轻量投影”，否则数据量增加后会把整表拉进 Node 内存。

---

## 2. 目标存储结构

同一个云 MySQL 实例中使用两个逻辑 Database：

```text
MySQL 实例
├── biu       产品权威数据
└── biu_ops   运营投影、治理和审计
```

其他数据：

| 存储 | 内容 |
|------|------|
| MySQL `biu` | 云端账号、设备、Workspace、成员、权限、云端 Page/Task/正文、视图、分享、Session 元数据、同步日志、插件/MCP 元数据 |
| MySQL `biu_ops` | 运营投影、账号治理、设备/同步健康、长期审计 |
| 对象存储 | 附件 CAS、Artifacts、插件包、Offline 私有备份中的大对象、冷 Session events |
| Offline SQLite | 本地账号、本地私有 Page/Task/正文、云端缓存、上传下载队列、冲突与水位 |
| 本机文件系统 | 本机项目文件、未上传附件与产物 |
| Redis | presence、edit locks、execution leases、跨实例缓存版本与短 TTL 状态 |
| Keychain | 云端 token、设备密钥；不明文放 SQLite |

### 不按来源拆云端业务库

Offline 上传和 Online 创建的数据都进入 `biu`，通过作用域区分：

```text
scope = private_backup | workspace
source = offline | online
```

不要建立 `biu_offline` / `biu_online` 两套业务 Database。同一记录可能经历“本地创建 → 私人备份 → 发布 Workspace → Online 编辑 → 新设备下载”，按来源分库会导致跨库权限、搜索和迁移。

---

## 3. 账号与本地数据边界

### 云端

- `accounts` 是云端正式身份权威。
- `account_devices` 记录设备、公钥/撤销状态、版本和最后在线时间。
- `offline_profiles` 只接收运营需要的非敏感摘要，例如本地记录数量、客户端版本和最后活跃时间。
- 不上传本地密码；云端 token 存 Keychain。

### Offline

- 本地账号继续存在本机 SQLite，保证完全离线使用。
- `cloud_connections` 保存 `local_account_id → cloud_account_id` 关联。
- 本地 Page、正文和文件默认不上云。
- 用户选择“上传到私人云备份”或“发布到 Workspace”后，才上传对应内容。

运营端能够识别账号、设备和活跃情况，但默认看不到本地 Page 标题、正文、路径和附件。

---

## 4. 最新列表/授权架构的 MySQL 改造

### 4.1 不直接照搬整 Collection 预加载

当前 SQLite 优化把 N+1 查询变成一次整 Collection 授权扫描，适合本机小库；在大型 MySQL Workspace 上不能无限沿用。

MySQL 列表查询应一次完成：

```text
Workspace 限定
→ 业务过滤
→ 权限 EXISTS / JOIN
→ 排序
→ keyset 分页
→ 只返回当前页轻量投影
→ 当前页再补 Facet/人物/分享装饰
```

短期兼容阶段可以保留 `preloadCollection()`，但必须设置记录数阈值；超过阈值走 MySQL 原生授权查询，禁止把整张 Collection 拉入内存。

### 4.2 缓存失效必须跨实例

目前 `onInvalidate()`、`visibleGen`、`visibleCache` 都是进程内状态。Online 扩为多个实例后，一个实例修改 grant，其他实例不会自动失效。

目标方案：

```text
authz_revisions
- workspace_id
- collection
- revision
- updated_at
```

- grant、policy、membership、group 变化时事务内递增 revision。
- 本地缓存 key 必须包含 revision。
- Redis Pub/Sub 负责快速通知；MySQL revision 是最终正确性来源。
- 不能只依赖 Redis 通知，因为消息可能丢失。

### 4.3 分页规则

当前 API 使用 `offset/limit`，默认 20、最大 200。迁移期保持兼容，但 MySQL 主路径应新增 cursor：

```text
updated_at < :cursorUpdatedAt
OR (updated_at = :cursorUpdatedAt AND id < :cursorId)
ORDER BY updated_at DESC, id DESC
LIMIT 21
```

- 前 20 条返回，额外 1 条判断 `hasMore`。
- 深分页禁止继续使用大 OFFSET。
- 分组视图每组独立 cursor，不共享全表 OFFSET。

### 4.4 轻量投影

Task 最新实现的 `listProjected()` 是 MySQL 迁移模板：

- 列表不取正文、trigger、report 详情和大型 JSON。
- `editor_content` 仅详情页或搜索时读取。
- Page、Session、Plugin、Skill 列表也应分别定义 projection DTO。
- 搜索正文时使用 FULLTEXT 或专用搜索服务，不用长期保留 `%LIKE%`。

### 4.5 Overlay / Facet

`emoji`、`tags`、facet、createdBy、updatedBy、shareScope 等 overlay 字段会迫使当前实现回到内存装饰和排序。

MySQL 第一版建议：

- 高频字段直接进入结构化列或列表投影表。
- Facet 值使用可索引关系表，不在列表阶段解析整段 JSON。
- 分享范围可以维护 `record_visibility_projection`，由权限事务同步更新。
- 低频自定义字段允许当前页二次查询，但不能整表 hydrate。

---

## 5. MySQL 关键索引（修订）

| 表 | 建议主键/索引 | 用途 |
|----|---------------|------|
| `workspace_members` | PK(`workspace_id`,`account_id`), IDX(`account_id`,`workspace_id`) | 鉴权与空间列表 |
| `workspace_group_members` | PK(`group_id`,`account_id`), IDX(`account_id`,`group_id`) | 最新授权预加载和 SQL EXISTS |
| `workspace_groups` | PK(`id`), IDX(`workspace_id`,`id`) | 按空间加载用户组 |
| `record_owners` | PK(`workspace_id`,`collection`,`record_id`), IDX(`workspace_id`,`collection`,`owner_id`,`record_id`) | 列表归属和 personal 分区 |
| `resource_policies` | PK(`workspace_id`,`collection`,`record_id`), IDX(`workspace_id`,`parent_collection`,`parent_record_id`) | 当前列表授权与继承 |
| `record_grants` | PK 含 subject, IDX(`workspace_id`,`subject_type`,`subject_id`,`collection`,`record_id`) | 按当前用户/角色/组反查可见记录 |
| `view_grants` | PK 含 subject, IDX(`workspace_id`,`subject_type`,`subject_id`,`collection`,`view_id`) | 共享视图 |
| `authz_revisions` | PK(`workspace_id`,`collection`) | 多实例缓存正确性 |
| `pages` | PK(`workspace_id`,`id`), IDX(`workspace_id`,`parent_id`), IDX(`workspace_id`,`updated_at`,`id`) | 树和 keyset |
| `tasks` | PK(`workspace_id`,`id`), IDX(`workspace_id`,`status`,`sort`,`updated_at`,`id`) | 看板轻量投影 |
| `editor_content` | PK(`workspace_id`,`collection`,`record_id`) | 正文点读和版本冲突 |
| `saved_views` | PK(`workspace_id`,`collection`,`view_id`) | 已有租户列，不建重复前缀索引 |
| `sessions` | PK(`workspace_id`,`id`), IDX(`workspace_id`,`updated_at`,`id`) | Session cursor |
| `sync_ops` | PK(`id`), IDX(`workspace_id`,`id`), IDX(`workspace_id`,`collection`,`record_id`,`field`,`id`) | Offline 增量同步 |

核心业务表仍建议显式加入 `workspace_id`；保留 `record_owners` 作为授权、共享和迁移兼容映射。

---

## 6. Offline 上传与新设备下载

当前已有：

- `cloud_connections`
- `workspace_place`
- `record_place`
- `/api/replica/snapshot`
- `takeSnapshot()` / `applySnapshot(cache|adopt)`
- 桌面端在 Cloud Workspace 中按 Workspace 转发 create/update/delete/content/share
- 本地 Workspace 与 Cloud Workspace 已成为互斥的数据边界

仍缺：

1. 用户把本地 Workspace 发布为 Cloud Workspace 的显式入口。
2. 新设备恢复向导。
3. 附件 CAS manifest 与二进制传输。
4. 持久化 snapshot watermark（当前为进程内 Map）。
5. 上传任务、重试、冲突和进度状态。

### 上传

```text
本地只读导出
→ 生成 manifest
→ 在云端创建目标 Workspace
→ 保持记录 ID，按 Workspace 导入
→ 缺失附件按 hash 上传对象存储
→ 写入 private_backup 或正式 Cloud Workspace
→ 成功后把新 Workspace 标记为 cloud
```

本地原 Workspace 不自动删除或原地变云端。上传成功后可以保留一个本地副本，避免失败或冲突造成数据丢失；不再恢复已删除的逐记录 `publishToCloud()` 复制语义。

### 下载

```text
登录云端账号
→ 获取可恢复清单
→ 用户选择
→ 下载结构化数据
→ applySnapshot(mode = cache)
→ 附件按需下载
```

Cloud Workspace 以云端为权威并按原 ID 缓存；本地 Workspace 与 Cloud Workspace 物理分区，不能把同 ID 本地记录静默覆盖。

### 本地同步状态

建议使用独立 sidecar：

```text
.biu/cloud-sync.sqlite
```

只保存：

- 上传/下载 job
- manifest 与水位
- local workspace / cloud workspace 映射
- 重试和冲突状态

老 `biu.sqlite` 继续服务本地业务，减少新旧分支互相影响。

---

## 7. 修订后的迁移顺序

### 阶段 0：查询契约先行

- 为 Page/Task/Session 定义列表 projection。
- 给列表 API 增加 cursor，同时保留 offset 兼容。
- 把授权判断抽象为 `AuthorizationRepository`。
- 增加 `authz_revisions` 语义和缓存测试。

不完成本阶段，不切 MySQL 主读路径。

### 阶段 1：`biu_ops`

- 迁移 7 张现有 ops 表。
- 把 `account_governance` 从投影中分离。
- `ops_audit_logs` 保持 append-only。
- `syncOperationsFromPlatform` 改为可配置数据源，不再硬编码 `.cloud-data/.local-data`。

### 阶段 2：账号、Workspace 与权限

- 迁 `accounts`、sessions、Workspace、成员、组、invites。
- 迁 `record_owners`、policies、grants、views grants。
- 实现 MySQL 授权 JOIN、revision 和多实例缓存失效。
- 运营 suspend 必须进入产品鉴权路径。

### 阶段 3：业务结构与正文

- Page/Task/Facet/View/Share/Session 元数据进入 MySQL。
- `editor_content` 第一版可用 MySQL LONGTEXT。
- 列表先走 projection + cursor；详情再查正文。
- SQLite 和 MySQL 短期双写，读取仍由 Feature Flag 控制。

### 阶段 4：Offline 私有云备份

- 账号/设备摘要后台上报。
- 用户选择上传，不全量自动上传本地内容。
- 补资产 manifest、对象存储、持久化水位、新设备恢复和冲突 UI。

### 阶段 5：事件与大对象

- 附件、Artifacts、插件包转对象存储。
- 活跃 Session events 保留热存储，结束 Session 整体归档。
- Offline 只缓存近期/打开过的事件，避免继续完整复制 200MB+ 事件库。

---

## 8. 灰度与数据安全

默认：

```text
BIU_STORAGE_BACKEND=sqlite
```

切换顺序：

```text
SQLite 权威
→ MySQL dry-run / 校验
→ 双写，SQLite 读
→ MySQL 影子读比对
→ 小流量 MySQL 读
→ 全量 MySQL 读
→ 停止 Online SQLite 写
```

要求：

- 迁移工具只接受显式 SQLite 路径，源库只读。
- 不从 `BIU_HOME` 猜源库。
- 不修改源库 `user_version`，不混拷 WAL/SHM。
- MySQL migration 必须版本化、幂等、带 checksum 和锁。
- 新分支使用独立数据目录、独立 MySQL Database、独立对象存储前缀。
- 合并代码不会自动上传 Offline 内容。
- 回滚只切 Feature Flag，不依赖回滚 Git 提交。

---

## 9. 最新代码对方案的影响汇总

| 最新变化 | 是否改 schema | 对迁移方案的影响 |
|----------|---------------|------------------|
| 授权 Collection 预加载 | 否 | MySQL 不能无限整表预加载；需 SQL 授权裁剪 |
| 可见列表缓存 + grant 失效 | 否 | 多实例必须增加 revision/Redis 失效 |
| 默认 20 条、分组分页 | 否 | 必须把分页下推数据库；UI 分页不等于 DB 分页 |
| Task 轻量 projection | 否 | 应推广到 Page/Session 等列表 |
| 表格/聊天窗口化 | 否 | 降低渲染成本，不减少当前后端全表扫描 |
| 未登录停止 snapshot/approvals 轮询 | 否 | 降低空闲流量；保持服务端鉴权即可 |
| Chat anchor/cancelled UI 修复 | 否 | 不影响 MySQL 设计 |

当前 `LATEST_BIU_SCHEMA` 仍为 41，因此本次是**迁移方案修订**，不是 SQLite schema 迁移。

---

## 10. 2026-10-19 最新数据盘点与迁移源规则

本次以 SQLite read-only 模式盘点，没有执行 migration、checkpoint 或写入。

### 当前规模

| 数据源 | 主业务摘要 | Events |
|--------|------------|--------|
| Online `.cloud-data` | accounts 4、workspaces 4、pages 82、tasks 25、editor_content 158、sessions 91 | 373,756 |
| Offline `.local-data` | accounts 2、workspaces 4、pages 81、tasks 29、editor_content 160、sessions 90 | 380,390 |
| Operations `.operations-data` | 独立产品壳数据很少；`ops.sqlite` 见下 | 1 |

两个主库仍是 schema v41，events 仍是 v1；没有发现需要新增 MySQL 表域的 schema 升级。

### Online 与 Offline 不能合并搬表

ID 对比：

| 表 | Online | Offline | 重合 | 仅 Online | 仅 Offline |
|----|--------|---------|------|------------|------------|
| accounts | 4 | 2 | 0 | 4 | 2 |
| workspaces | 4 | 4 | 2 | 2 | 2 |
| pages | 82 | 81 | 81 | 1 | 0 |
| tasks | 25 | 29 | 25 | 0 | 4 |
| sessions | 91 | 90 | 87 | 4 | 3 |

结论：

- `.cloud-data` 是 Online → MySQL 的产品迁移源。
- `.local-data` 不是第二个需要 union 的服务端数据库。
- Offline 独有的 4 个 Task、3 个 Session 等仍是本地私有数据，只有用户选择上传时才进入 `private_backup` 或 Workspace。
- 重合 Page/Task/Session 也不能按“更新时间大者”直接覆盖；必须沿用 local/cloud 映射、版本与冲突规则。
- Offline 的 `record_place`、`replica_*`、`cloud_connections` 属于设备侧状态，不进入产品 MySQL 权威表；旧 `record_cloud_copy` 只作兼容清理，不进入新同步协议。

### 两份 `ops.sqlite` 需要合并去重

`.cloud-data/.biu/ops.sqlite` 与 `.operations-data/.biu/ops.sqlite` 不是完整包含关系：

| 表 | Cloud | Operations | 重合 | Cloud 独有 | Operations 独有 |
|----|-------|------------|------|------------|-----------------|
| ops_accounts | 4 | 3 | 3 | 1 | 0 |
| ops_workspaces | 5 | 4 | 4 | 1 | 0 |
| ops_usage_daily | 19 | 15 | 15 | 4 | 0 |
| ops_devices | 6 | 4 | 4 | 2 | 0 |
| ops_sync_health | 3 | 3 | 3 | 0 | 0 |
| ops_security_events | 16 | 9 | 9 | 7 | 0 |
| ops_audit_logs | 9 | 13 | 8 | 1 | 5 |

因此 `biu_ops` 首次迁移不能只选一份源库：

- 投影表按 `id` union，冲突时选择 `updated_at` / `last_seen_at` / `last_sync_at` 更新的一行。
- `ops_security_events`、`ops_audit_logs` 按 `id` 去重后 append-only union，不因另一份库缺失而删除。
- 迁移报告必须输出每表 source count、shared、inserted、updated、conflicted、rejected。
- 完成首次合并后只保留一个配置化的运营同步入口，停止两个位置各自继续生成 `ops.sqlite`。

隔离快照上的实际 dry-run 结果：

- `ops_accounts` 4 条唯一记录，2 个同 ID 内容冲突。
- `ops_workspaces` 5 条唯一记录，4 个冲突。
- `ops_devices` 6 条唯一记录，4 个冲突，其中 1 条应取 Operations 较新版本。
- `ops_sync_health` 3 条唯一记录，3 个冲突。
- `ops_usage_daily` 19 条、`ops_security_events` 16 条，重复 ID 内容一致。
- `ops_audit_logs` union 后为 14 条，包含 Operations 独有的 5 条，不能只迁 Online 那份。

### 是否需要把最新数据复制到功能分支

需要的是**一致性测试快照**，不是移动现有运行数据：

```text
.cloud-data/.biu/*.sqlite       ─┐
.local-data/.biu/*.sqlite        ├─ SQLite backup API ─→ .branch-data/mysql-cloud-sync/source-snapshots/
.operations-data/.biu/ops.sqlite ┘
```

- 源库只读，目标目录独立且被 git 忽略。
- 使用 SQLite backup API 获取一致快照，不直接混拷 DB/WAL/SHM。
- MySQL dry-run 和导入测试只读取这些快照。
- 当前分支/老版本继续使用原 `.cloud-data`、`.local-data`、`.operations-data`。

### 当前开发验证状态

- 本机 MySQL 8.0.42 已创建隔离 Database：`biu_dev`、`biu_ops_dev`。
- migration 由 `schema_migrations` + checksum + `GET_LOCK` 管理。
- 两份运营快照已按上述规则导入 `biu_ops_dev`。
- 导入结果：accounts 4、workspaces 5、usage 19、devices 6、sync health 3、security events 16、audit logs 14。
- 重复执行导入后行数不变，已验证幂等。
- Online 产品快照已完整导入并审计；按产品决定，缺失 Workspace 归属的历史业务记录不再使用，只从 MySQL 导入结果剔除，源 SQLite 保持不变。
- 清理后的 `biu_dev`：pages 6、tasks 0、editor_content 38、sessions 11、events 49,254；其余有明确租户或全局语义的持久化表保留。
- `cloud_connections`、`workspace_place`、`record_place`、`replica_*` 等设备状态，以及 locks/presence/leases/GC 候选未导入。
- Online 的账号/Workspace/权限、Page/Task/正文、Session/Events、Facet/View/Share/Record Meta/PageBlock、插件元数据和 Operations 已接入异步 MySQL Repository；`BIU_STORAGE_BACKEND=mysql` 可作为主读写路径。
- 租户审计发现的 204 条历史记录（pages 78、tasks 25、sessions 82、facets 7、skills 12）已在 `migration_tenancy_exceptions` 标记为 `discarded`。
- MySQL-only 已在隔离 `BIU_HOME` 启动验证：账号登录、Workspace 鉴权、Page 列表、Session 列表以及 Page 正文创建/删除均成功；测试 Host 已关闭。
- Offline 永远继续使用 SQLite；`dual` 用于回滚期影子同步，`mysql` 用于 Online 主读写。
