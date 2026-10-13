# WebSQL Gateway

独立于 Biu 插件生命周期的 MySQL 只读网关。Page 插件和其他 Web 插件通过 HTTP API 调用它，服务负责连接本地或远程 MySQL。

## API

- `GET /v1/health`：服务健康状态，不需要 Token。
- `POST /v1/connect`：验证连接、只读授权并返回数据库列表。
- `POST /v1/schema`：返回数据库的数据表或指定表的字段。
- `POST /v1/query`：执行单条只读 SQL。

除健康检查外，请求需要：

```http
Authorization: Bearer <WEBSQL_GATEWAY_TOKEN>
Content-Type: application/json
```

连接参数：

```json
{
  "conn": {
    "host": "10.0.0.8",
    "port": 3306,
    "user": "reader",
    "password": "数据库密码"
  }
}
```

连接参数固定只有四个：`host`（IP）、`port`、`user`、`password`。数据库在连接成功后选择，不属于连接参数。

查询示例：

```json
{
  "conn": {
    "host": "10.0.0.8",
    "port": 3306,
    "user": "reader",
    "password": "..."
  },
  "database": "app",
  "sql": "SELECT * FROM users LIMIT 100",
  "timeoutMs": 15000,
  "page": 1,
  "pageSize": 100
}
```

`pageSize` 默认 100，最大 500。Gateway 流式读取结果，只保留当前页以及一条用于判断 `hasMore` 的记录；达到当前页上限后会关闭数据库连接并回滚只读事务。

## SQL 只读策略

Gateway 不限制账号权限，root 或读写账号均可连接。

每条用户 SQL 在调用 MySQL 前都会经过只读解析，只放行单条 `SELECT`、`SHOW`、`DESCRIBE` 和只针对查询的 `EXPLAIN`。DML、DDL、多语句、锁、文件操作、MySQL 客户端命令和可执行注释会被拒绝。放行的查询还会在 `START TRANSACTION READ ONLY` 中执行，最后统一 `ROLLBACK`。

这符合“账号不限制、SQL 限制写入”的使用方式，但安全边界由 SQL 解析器承担；若面对不可信公网用户，数据库只读账号仍是更强的纵深保护。

## 配置

默认读取 `~/.config/biu-websql-gateway/env`：

```sh
WEBSQL_GATEWAY_HOST=127.0.0.1
WEBSQL_GATEWAY_PORT=43120
WEBSQL_GATEWAY_TOKEN=替换为随机长字符串
WEBSQL_GATEWAY_CONCURRENCY=4
WEBSQL_GATEWAY_ORIGINS=http://127.0.0.1:3141,http://localhost:3141,http://127.0.0.1:5173,http://localhost:5173
WEBSQL_MYSQL_BIN=/opt/homebrew/opt/mysql@8.0/bin/mysql
```

默认只监听本机。若需要其他设备的插件页访问：

1. 将服务放在 HTTPS 反向代理之后；
2. 保持 Bearer Token；
3. 在 `WEBSQL_GATEWAY_ORIGINS` 中精确添加调用方 Origin；
4. 不要直接把无 TLS 的 43120 端口暴露到公网。

## 本地测试

```sh
node --test services/websql-gateway/policy.node.mjs
curl http://127.0.0.1:43120/v1/health
```
