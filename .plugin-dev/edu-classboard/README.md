# 教育答题与学情（edu-classboard）

页面里插一块，**同一块两个视角**，来回点右上角切换：

- **学生视角**：从真题库里取一道题（优先给你这个班最弱的知识点、且这个学生还没做过的），
  点选项 → 「提交答案」→ **真判分并真写一条作答记录**，返回新的 `attempt_id`，
  下面列出这个学生的作答历史。
- **老师视角**：按知识点算正确率（升序，最弱在最前）、按学生正确率自动分「重讲 / 巩固 / 跳过」三组，
  点「写下备课计划」把前 3 个最弱知识点的分组结论**各写成一行记录**。

**它凭什么不是「又一个看板块」**：核心动作是**写出一条对象**，不是展示一张表。
学生每交一次卷，`edu_demo.t_attempt` 就多一行；老师每次定计划，`edu_demo.t_group_plan` 就多一行。
有 `attempt_id` 才能被统计，有 `student_name` 才能被分组，有历史才能「针对性地讲」。

- 默认库：`127.0.0.1:3306 / root / edu_demo`（15 知识点 / 44 题 / 4851 次历史作答 / 60 名学生）。
- 写操作白名单：**只有 `t_attempt` 和 `t_group_plan` 两张表**，且写的是 INSERT。
  表名是从语句里解析出来按白名单放行的，不是猜危险词；`q_id`、`answer` 这些入参有格式校验，注入探针已被验证拦得住。
- 分组阈值**跟随真实分数区间自动算**（不要写死 60/75 —— 数二A班真实区间是 50–66.3%，写死会导致「所有人都在重讲组」）。
- 数据接口：`GET /api/edu-classboard/classes|roster|next|history|stats|plans`、
  `POST /api/edu-classboard/submit|plan`。无头插件（`headless: true`），没有窗口。

## 示例写法

```md
:::pageBlock {kind=edu-classboard plugin=edu-classboard}
{
  "tab": "student",
  "class_name": "数二A班",
  "student_name": "数二A班01",
  "confirmed_by": "教研组",
  "conn": { "host": "127.0.0.1", "port": 3306, "user": "root", "password": "Abc123456", "database": "edu_demo" }
}
:::
```

可写字段：`tab`（`student` | `teacher`，点标签会自己回写）、`class_name`、`student_name`、
`confirmed_by`（写备课计划时记的确认人）、`conn`。
默认落在**学生视角**，演示时先答题、再切老师视角看数字变。
