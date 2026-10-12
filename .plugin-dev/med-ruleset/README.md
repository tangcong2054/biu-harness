# 医疗口径版本（med-ruleset）

页面里插一块。**规则不是对话里的一句话，是有版本、能重跑、能 diff 的对象。**

- ① 入组规则从 `med_demo.t_rule` 里读出来（每版一行，老版本不删）。
- ② 改条件 → 「发布新版本」→ **真 INSERT 一条 `version+1` 的规则**，旧版还在。
- ③ 「按这条规则跑」→ 插件用**受限解析器**把条件文本翻成 SQL **真查患者**，
  给出人数、命中名单、「两版差几人」以及**新增入组 / 不再入组的名单**。
- ④ 「把这次结果落成一条 run」→ 真写 `med_demo.t_rule_run`（人数 + 名单 + 与上一版的 diff + 执行人 + 时间）。
- ⑤ 命中名单里**每个患者编号都能点**，展开他每个 SBP/DBP/LDL 出自哪份病历、哪个文件 —— **这是「能不能过审」的那一步**。

**真实结果**：v1「年龄>=60 AND 收缩压>=140」→ **39 人**（男 22 / 女 17）；
发布 v2「年龄>=65 AND 收缩压>=145」→ **28 人**，diff 出**不再入组 11 人**（P0001、P0010、P0014…）。
溯源实测：P0001 的 SBP 144 出自 `/extract/0001/检验4.pdf`（2026-03-23 检验报告，病历号 MR-2026-检验-0001-4）。
指标提取：SBP / DBP / LDL 各 101 条，覆盖 60 位患者、101 个来源文件、169 份病历。

- 默认库：`127.0.0.1:3306 / root / med_demo`。
- 条件写法：**字段 + 比较符 + 数字**，多条件用 `AND` 连；字段白名单
  `年龄 / 性别 / 收缩压 / 舒张压 / LDL`，值必须是数字。
  **不接受任意 SQL** —— 探针 `年龄>=60; DROP TABLE t_patient` 已被拒绝（提示只支持「字段 比较符 值」）。
- 写操作白名单：**只有 `t_rule` 和 `t_rule_run`**。
- 数据接口：`GET /api/med-ruleset/rules|runs|trace|metrics`、
  `POST /api/med-ruleset/run|publish|save-run`。无头插件，没有窗口。

## 示例写法

```md
:::pageBlock {kind=med-ruleset plugin=med-ruleset}
{
  "rule_id": "1",
  "condition_text": "年龄>=60 AND 收缩压>=140",
  "ran_by": "临床数据组",
  "conn": { "host": "127.0.0.1", "port": 3306, "user": "root", "password": "Abc123456", "database": "med_demo" }
}
:::
```

可写字段：`rule_id`、`condition_text`（演示时可预填一版新口径）、`ran_by`、`conn`。
