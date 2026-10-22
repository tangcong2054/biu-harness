# 应用商店视图

把「插件商店」这张表整页画成软件商店的样子：顶部有标题与搜索框，下面一排分类标签（全部 / 已安装 / 可更新 / 应用窗口 / 无头插件 / 未安装）和一堆标签筛选，主体是自适应网格的应用卡片，点卡片右侧弹出详情抽屉，可以直接安装 / 更新 / 卸载。

## 怎么用

1. 打开「插件商店」（`/plugin-catalog`）。
2. 右上角「查看模式」菜单里选 **商店**。
3. 卡片右上角是状态胶囊：已安装 / 可更新 / 未安装 / 待审核 / ID 冲突；卡片底部是形态徽章、大小和第一个标签。
4. 点卡片 → 右侧抽屉显示完整的简介、版本、审核与检测状态、README 正文，以及「安装 / 更新 / 卸载 / 打开记录」按钮。

无头插件（`manifest.headless = true`），有窗口无关；它只登记一种整页呈现：

```ts
databaseUi.registerView('/plugin-catalog', { id: 'app-store', label: '商店', plugin: 'app-store-view', View })
```

不只换每行，是整页自己画。外层 `data-biu-plugin="app-store-view"` 由宿主打上，选中页面里的元素也能定位到这个插件。

## Agent 可用的 Action（uiActions）

注册的 target：`plugin=app-store-view`、`instanceId=app-store-view`、`kind=app-store`。

| Action | risk | 参数 | 作用 |
| ------ | ---- | ---- | ---- |
| `list_apps` | read | `category?`、`query?`、`limit?` | 列出商店插件（id / 标题 / 作者 / 状态 / 形态 / 大小） |
| `set_search` | write | `query` | 设置搜索词，返回命中的 id |
| `set_category` | write | `category`（all/installed/update/window/headless/fresh） | 切换分类标签 |
| `set_tag` | write | `tag` | 按标签过滤（空串清空） |
| `open_app` | navigate | `id` | 打开右侧详情抽屉，空串关闭 |
| `install_app` | submit | `id`、`action`（install/update/uninstall） | 真调 `/api/db/action` 执行安装/更新/卸载 |

state 暴露当前 `query` / `category` / `tag` / `open` / `total` / `shown` / `shownIds`，可配合 `ui_wait` 验证。

## 数据来源

全部读 `/plugin-catalog` 的列：`title`、`author`、`blurb`、`tags`、`bytes`、`headless`、`hasHost`、`hasWeb`、`installed`、`updateAvailable`、`idConflict`、`remoteCodeVersion`、`localCodeVersion`、`reviewStatus`、`scanStatus`、`registryId`。README 正文走 `GET /api/db/content?path=/plugin-catalog/<id>`。安装动作走 `POST /api/db/action`，成功后广播 `fsdb:change` 让表格刷新。

## 不做什么

- 不改 `packages/`，不改 `cordis.plugins.json`。
- 不写数据库，安装/卸载只是转发到商店记录已有的 action。
- 不缓存 README，不把内容写回记录。
