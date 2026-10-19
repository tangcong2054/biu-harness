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
