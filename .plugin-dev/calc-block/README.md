# 计算器块（calc-block）

在页面文档里插入一个**真能用的计算器**：点数字键或用键盘直接敲算式，结果实时预览，按 `Enter`/`=` 落进历史。三种外观随时切换，还能一键**悬浮**成可拖动的桌面小窗，边写文档边算。

## 三种外观（头部「基础 / 科学 / 换算」）

| 外观 | 内容 |
|---|---|
| `basic` 基础 | 4×5 数字键盘 + `%`、`±`、`⌫`、`AC`、`MC/MR/M+/M−` |
| `scientific` 科学 | 左列 `sin/cos/tan/ln/log`，右下 14 个函数键：`π`、`e`、`x²`、`xʸ`、`√`、`ˣ√y`、`n!`、`1/x`、`|x|`、`round`、`ans`、`m` |
| `convert` 换算 | 9 类单位（长度/重量/温度/面积/体积/速度/时间/数据/角度），一屏列出「同值换算成其它所有单位」 |

## 表达式能写什么

- 四则 `+ - - * /`、乘方 `^`、阶乘 `!`、括号，`×÷−` 会自动当 `* / -` 处理。
- 常量 `pi` / `π` / `e` / `tau`；变量 `ans`（上次结果）、`m`（内存值）。
- 函数：`sin cos tan asin acos atan sinh cosh tanh ln log log2 log10 exp sqrt cbrt abs sign floor ceil round min max mod pow hypot gcd fact avg sum`。
- 括号没写全会自动补齐：`sin(45` 直接算。
- `%`：后缀百分比，`200*15%` = 30；`100+10%` 按「加它自己的 10%」= 110（和手机计算器一致）。
- 角度单位：头部 `DEG / RAD` 按钮决定三角函数按度还是弧度算。

## 悬浮小窗

头部点「悬浮」，同一个计算器会以**可拖动的固定小窗**叠在页面上（拖动标题栏移动，位置写回块数据 `floatPos`，刷新后还在）。小窗和文档里的主体共用表达式、历史与内存，关掉小窗不影响块本身。

## 示例写法

```md
:::pageBlock {kind=calc plugin=calc-block id=c31a90ef}
{
  "title": "云盘容量与月成本",
  "mode": "scientific",
  "angle": "deg",
  "expr": "128*0.23",
  "showHistory": true,
  "showBases": false,
  "group": true,
  "convert": { "category": "data", "from": "TB", "to": "GB", "amount": "1.5" }
}
:::
```

可写字段：

- `title` 标题 · `mode`（`basic` / `scientific` / `convert`）· `angle`（`deg` / `rad`）
- `expr` 当前表达式 · `ans` 上次结果 · `memory` 内存值 · `history` 最近 30 条 `{expr, value}`
- `floating` 是否显示悬浮小窗 · `floatPos` `{x, y}` 小窗位置
- `showHistory` 右侧历史栏 · `showBases` 结果下方 HEX/BIN · `group` 千分位
- `convert` `{category, from, to, amount}`（换算外观的当前选择）

> `history` / `ans` / `expr` 由块自己写回，agent 一般只读；预填 `title`、`mode`、`convert` 就够了。
## 键盘与鼠标

- 鼠标点块里任意位置后，直接敲 `0-9 . + - * / ^ % ( ) !`、字母函数都能进输入框；`Enter`/`=` 计算，`Backspace` 退格，`Esc`/`Delete` 清空。
- 也可以在输入框里整段粘贴算式（`12*(3+4)/sqrt(2)` 这种），边打边看结果预览——预览用灰色的中间值，只有按 `=` 才写进历史。



- 新增**换算外观**：9 大类单位，输入一个值就把「换成其它所有单位」一次列全（温度按公式、数据按 1024 进制）。
- 新增**悬浮小窗**：拖动标题栏移动，位置存进 `floatPos`，刷新/切页都还在；小窗与文档内主体共享表达式、历史与内存。
- 科学外观补齐 `π`、`e`、`x²`、`xʸ`、`ˣ√y`、`n!`、`1/x`、`|x|`、`round`、`ans`、`m`；支持 `√9`、`∛27`、`sin30` 这类不带括号的写法。
- `%` 按手机计算器口径：`200*15%` = 30、`100+10%` = 110、`100-10%` = 90。
- 新增 `MinimizedView`：块被宿主收起时显示「表达式 · 模式 · M 值」紧凑摘要。

## Agent 动作（uiActions）

块注册了 `kind=calc` 的实例动作，可直接驱动这个计算器，不必点按钮：

| 动作 | 说明 |
|---|---|
| `read_state` | 读表达式、结果预览、错误、模式、内存与历史 |
| `press_key` | 按一个键（`0-9 . + - * / ^ % ( ) !`、`=`、`AC`、`BACK`、`NEG`、`MC/MR/M+/M-`） |
| `evaluate` | 求值并写入历史；可带 `angle` 临时指定 `deg/rad` |
| `clear` / `clear_history` | 清空输入 / 清空历史 |
| `convert` | 单位换算，返回 `{value, text, from, to}` 并写回块数据 |

`convert` 支持模糊单位名（`TB`、`ft` 都认），所以可以直接问「500 GB 换成 TB」这类问题而不用管下拉框。

## 自测（可选）

`verify.mjs` 不依赖浏览器，直接跑求值器、格式化与换算表的 42 项断言（全部通过才退出 0）：

```sh
node verify.mjs
```
