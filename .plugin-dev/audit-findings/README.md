# 审计发现底稿（audit-findings）

页面里插一块。**规则不是写在提示词里，是表里的一行**（`audit_demo.t_audit_rule`，有 `rule_id` / `risk` / `version` / `owner`）。

- 左侧勾选要跑的规则 → 「跑选中的规则」→ **真执行那条 SQL**。
- 每条命中都能「展开」，看到**规则原文 + 命中条件 + 证据**（几张票、票号、哪个部门、多少钱）。
- 写一句结论 → 「确认并落底稿」→ **真写一行 `audit_demo.t_audit_finding`**
（带 `rule_version` + `fingerprint` + `confirmed_by` + `created_at`）。
- 再跑一次 → 自动和上一次 **diff**（新增待复核 / 上次有本次没有 / 已落底稿几条）。

**为什么这条 SQL 能被审计，一次对话不能**：底稿里有规则版本、有指纹、有确认人、有时间。
半年后有人问「这条结论当初是谁、依据哪一版规则定的」，表里查得到。

- 默认库：`127.0.0.1:3306 / root / audit_demo`（160 张发票 / 15 家供应商 / 10 名员工）。
- 4 条规则真跑结果：**12 条命中，合计 1,515,559.06 元**
（拆分报销 4 条 / 重复发票号 1 条 / 关注级供应商 3 条 / 周末开票 4 条）。
- 底部「单张都能查，合起来查不出来」是**同一时刻真跑的两组数**：
按单张看全部合规，按「同供应商 + 同一天」分组立刻现形（宏远建筑 3 张 146,200）。
- 写操作白名单：**只有 `t_audit_finding`**；规则 SQL 执行时仍按 `SELECT` + 单条语句校验。
- 数据接口：`GET /api/audit-findings/rules|rule-sql|findings|contrast`、
`POST /api/audit-findings/run|confirm`。无头插件，没有窗口。

## 示例写法

```md
:::pageBlock {kind=audit-findings plugin=audit-findings id=cb3cfe89}
{
  "confirmed_by": "审计一组（李）",
  "conn": {
    "host": "127.0.0.1",
    "port": 3306,
    "user": "root",
    "password": "Abc123456",
    "database": "audit_demo"
  }
}
:::
```

可写字段：`confirmed_by`（落底稿时记的确认人）、`conn`。