# Cloud storage foundation

Online MySQL 与 Offline 私有云备份基础设施。

## 安全边界

- 默认 `BIU_STORAGE_BACKEND=sqlite`，普通启动不会连接 MySQL。
- MySQL 仅允许 Online 显式启用。
- migration 还要求 `BIU_MYSQL_RUN_MIGRATIONS=1`。
- 当前运行数据不作为开发写入目标。
- 一致性测试快照位于被 git 忽略的 `.branch-data/mysql-cloud-sync/`。

创建隔离快照：

```bash
BIU_CREATE_BRANCH_SNAPSHOTS=1 npm run mysql:snapshot
```

盘点明确指定的快照：

```bash
npm run mysql:inventory -- .branch-data/mysql-cloud-sync/source-snapshots/online-biu.sqlite
```

检查业务记录能否安全加入 `workspace_id`：

```bash
npm run mysql:audit-tenancy -- \
  .branch-data/mysql-cloud-sync/source-snapshots/online-biu.sqlite
```

生成两份运营库的只读合并计划：

```bash
npm run mysql:plan-ops -- \
  .branch-data/mysql-cloud-sync/source-snapshots/online-ops.sqlite \
  .branch-data/mysql-cloud-sync/source-snapshots/operations-ops.sqlite
```

显式导入开发库（可重复执行）：

```bash
BIU_ONLINE=1 \
BIU_STORAGE_BACKEND=dual \
BIU_MYSQL_URL='mysql://user:password@127.0.0.1:3306' \
BIU_MYSQL_DATABASE=biu_dev \
BIU_OPS_MYSQL_DATABASE=biu_ops_dev \
BIU_MYSQL_IMPORT_OPS=1 \
npm run mysql:import-ops -- \
  .branch-data/mysql-cloud-sync/source-snapshots/online-ops.sqlite \
  .branch-data/mysql-cloud-sync/source-snapshots/operations-ops.sqlite
```

导入 Online 主库与事件库：

```bash
BIU_ONLINE=1 \
BIU_STORAGE_BACKEND=dual \
BIU_MYSQL_URL='mysql://user:password@127.0.0.1:3306' \
BIU_MYSQL_DATABASE=biu_dev \
BIU_OPS_MYSQL_DATABASE=biu_ops_dev \
BIU_MYSQL_OWNERLESS=report \
BIU_MYSQL_IMPORT_MAIN=1 \
npm run mysql:import-main -- \
  .branch-data/mysql-cloud-sync/source-snapshots/online-biu.sqlite \
  .branch-data/mysql-cloud-sync/source-snapshots/online-events.sqlite
```

`BIU_MYSQL_OWNERLESS=report` 只登记缺失 `record_owners` 的历史记录；明确决定不要这些数据时使用 `discard`，它只清理 MySQL 导入结果，源 SQLite 保持不变。

执行开发 MySQL migration：

```bash
BIU_ONLINE=1 \
BIU_STORAGE_BACKEND=dual \
BIU_MYSQL_URL='mysql://user:password@127.0.0.1:3306' \
BIU_MYSQL_DATABASE=biu_dev \
BIU_OPS_MYSQL_DATABASE=biu_ops_dev \
BIU_MYSQL_RUN_MIGRATIONS=1 \
npm run mysql:migrate
```

## 私人云备份闭环

- Online 鉴权接口：`POST/GET /api/private-backups`、`GET/DELETE /api/private-backups/:id`。
- Offline 只有调用 `POST /api/private-backups/publish` 才会上传指定的本机 Workspace；不会后台默认上传。
- 新设备调用 `POST /api/private-backups/:id/restore` 恢复到自己的本机 Workspace。恢复会在写入前检查全部记录 ID，任一冲突都返回 `409` 和冲突清单，不写入任何记录。
- manifest 上限为 10 MiB、20,000 条（记录与附件合计），覆盖结构化 Session、Page、Task、正文及这些记录实际引用的 `.biu/assets`；未引用资产不会上传，重复引用只保存一次。
- 附件以 `/assets` backup item 保存。当前没有对象存储，因此小附件字节内联为 base64，`content_hash` 保存原始字节 SHA-256；后续可将字节迁往对象存储并改用 `object_key`，manifest 语义无需变化。
- 恢复会先验证全部附件 base64、大小、SHA-256、CAS 文件名、稳定名文档 etag，以及记录/附件冲突。任一预检失败时记录和附件均零写入；hash CAS 已存在且内容一致时幂等复用，稳定名文档内容不一致时拒绝覆盖。

## Online 运行模式

- `BIU_STORAGE_BACKEND=sqlite`：旧 SQLite 运行时。
- `BIU_STORAGE_BACKEND=dual`：SQLite 回滚链路 + MySQL 分域切换/影子同步。
- `BIU_STORAGE_BACKEND=mysql`：Online 账号权限、业务数据、Session/Events、元数据和 Operations 直接读写 MySQL。
- Offline 无论共用哪套环境模板都固定使用本机 SQLite。

完整变量示例见 `docs/mysql-config.example.env`。
