# WebSQL 页面块

在 Page 中嵌入 Adminer 风格的 MySQL 浏览器。插件本身只有 Web UI，不包含后端服务；它调用独立运行的 **WebSQL Gateway**：

- Gateway URL 默认 `http://127.0.0.1:43120`；
- 可以连接本机或远程 MySQL；
- 浏览数据库、数据表和字段；
- 执行 `SELECT`、`SHOW`、`DESCRIBE` 和只针对查询的 `EXPLAIN`；
- 查询结果由 Gateway 服务端分页，页面默认每页 100 行，只保留和渲染当前页；
- Gateway Token 和数据库密码只保存在当前页面运行内存，不写入 Page 内容。

## 示例写法

```md
:::pageBlock {kind=websql plugin=websql id=websql-demo}
{
  "host": "127.0.0.1",
  "port": 3306,
  "user": "root",
  "database": "",
  "sql": "SELECT VERSION() AS version, NOW() AS now_time"
}
:::
```

连接表单固定只有 `IP + Port + User + Password` 四项。`database` 是连接成功后的数据库选择状态，不属于连接参数。不要把 `password` 写进 Page JSON。

## 独立后端

服务代码和 API 文档位于：

```text
services/websql-gateway/
```

它独立于插件生命周期运行，其他插件页也可以调用相同的 `/v1/connect`、`/v1/schema` 和 `/v1/query` API。

Gateway 对每个数据库请求执行三层只读保护：

1. 只接受单条只读 SQL；
2. 解析 SQL 关键字和结构，拒绝 DML、DDL、多语句、锁、文件操作、客户端命令和 MySQL 可执行注释；
3. 放行的查询在只读事务中执行并统一回滚。

账号权限不作为登录限制，root 和业务读写账号也能连接；写语句会在调用 MySQL 前被 Gateway 拒绝。
