# Agent UI Actions 插件覆盖

## 显式语义 Actions

- `websql`：设置 SQL、连接、执行、读取结果。
- `page-html-blocks`：读取/替换 HTML、开始放映；iframe 内部仍通过专用 bridge。
- `page-browser`：导航、刷新、侧栏打开、读取地址状态。
- `page-code-runner`：设置代码、运行、清空/读取输出。
- `api-playground`：设置请求、发送、读取响应、清空历史。
- `page-regression`：执行断言、读取结果。
- `option-matrix`：读取矩阵、批量更新、设置评分。
- `plugin-doctor`：扫描插件、读取报告。
- `page-toc`：读取标题、跳转标题。
- `page-algorithm`：读取/更新题面与代码。
- `dbbrain-limit`：设置实例、查询会话/限流任务、读取状态。Kill、终止、删除继续走页面确认，不向 Agent 暴露直接执行 Action。
- `cdb-slowlog`：设置查询条件、查询、前后翻页、读取当前页、全屏。
- `cdb-processlist`：设置查询条件、查询/续查采样点、缓存分页、读取结果、全屏。
- `cdb-errorlog`：设置查询条件、查询、读取结果、全屏。
- `cdb-logs`（合并上面三个 cdb 日志块）：切换日志类型、查询、前后/首页翻页、续查采样点、读取结果、全屏。
- `arena-rogue`：读取游戏状态、重开、选择武器。

## DOM 自动适配

- `page-video`：原生输入、选择和按钮可 `fill/select/click`；时间轴、轨道编辑和媒体状态需要后续专用 Action。

## 需要专用适配（当前不做通用模拟）

- `page-terminal`：xterm 的输入、buffer、selection 与原生 DOM 不同；应通过终端实例 API 注册 `write/read_buffer/read_selection/resize`。
- `page-excalidraw`：Canvas 场景不能可靠地按 DOM 点击；应通过 Excalidraw API 注册 `get_scene/update_elements/export/reset_view`。

## 历史 JavaScript 源码

`cdb-slowlog`、`cdb-processlist`、`cdb-errorlog` 使用 `.plugin-dev/<id>/web.js` / `host.js` 作为可读沙箱源码。它们此前被通用 `.plugin-dev/**/*.js` 忽略规则误判为编译产物；现在已加入精确例外并接入语义 Actions。

## 约束

- 插件 Action 的实现与按钮复用同一业务函数。
- 不注册任意 JavaScript、CSS selector 或坐标点击。
- password、Secret、API Key 不进入 `ui_inspect` 或 Action 结果。
- `destructive` Action 必须显式确认；复杂危险操作优先保留插件自己的二次确认 UI。
