# 运行时自检卡片 (plugin-selftest)

最小可用的「测试插件」：一个有窗口的 Web 插件，用来验证 sandbox → pack → 窗口渲染 这条链路是否正常。

## 怎么用

1. 到「插件」表找到 plugin-selftest，点 `start` 打开窗口（420x340，可缩放）。
2. 点卡片里的 **跑一遍**，会在当前窗口内逐条执行 10 项运行时检查：

| 检查 | 说明 |
| --- | --- |
| React 运行时 | 宿主 globalThis.React / useState 是否注入 |
| JSX 编译 | JSX 产物是否是可渲染的 React element |
| 基础运算 | 1 + 1 === 2 |
| JSON 往返 | 含中文的 JSON stringify / parse |
| crypto.randomUUID | 安全随机数可用 |
| Promise / async-await | 异步链路正常 |
| location.origin | 页面 origin 可读 |
| localStorage | 读 / 写 / 删回环 |
| fetch | 存在即可，不发实际请求 |
| 窗口尺寸 / DPR | innerWidth x innerHeight @DPR |

每条显示 通过 / 失败、返回详情和耗时；右上角汇总 `通过数/总数`。**清空** 可重置。

## 说明

- 不请求宿主服务、不写任何数据，纯浏览器侧检查，可以放心反复跑。
- 没有 host 入口，也不需要无头模式；所有逻辑在 `web/index.tsx`。
- 新增检查只需往 `CASES` 数组里加一条 `{ id, label, run }`，run 里 throw 即视为失败。

## 给 Agent 的语义 Action

本插件注册了 `uiActions`（plugin=plugin-selftest，kind=selftest），可以用 `ui_inspect plugin=plugin-selftest` 找到 ref 后调用：

| Action | 风险 | 作用 |
| --- | --- | --- |
| `run` | submit | 在当前窗口跑一遍全部检查，返回 `{status, passed, total, failed[], cases[]}` |
| `read_result` | read | 读取上次结果；没跑过返回 `{ran:false}` |
| `clear` | write | 清空卡片里的结果 |

卡片右上角有 `data-selftest-summary` 汇总文本，可用 UI 文本校验断言 `10/10 通过`。
