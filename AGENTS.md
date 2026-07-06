# Project Rules

## General

- 使用中文和用户沟通。
- 只改和当前任务直接相关的文件。
- 对不确定性较大的任务，先读取 `.ai/keypoint.md`。

## Before Editing

- 修改代码前，必须先说明计划，并等待用户明确回复后再改代码。
- 说明计划不等于获得授权；只有用户回复“可以”“开始”“确认”“按这个做”等明确许可后，才能修改代码。
- 可以在未获许可前执行只读操作，例如 `rg`、`cat`、`sed`、`git diff`、`git status`、读取 PRD/日志/keypoint。
- 如果用户明确要求“直接改”“现在实现”“不用问”，本轮可以按该授权执行，但仍需先用一两句话说明将改哪些文件和为什么。
- 如果实现过程中发现范围明显扩大，或需要新增/删除多个关键文件，必须停下来重新说明计划并等待确认。


## Build, Install, And App Launch

- 每次执行完打包任务之后，都要安装或者覆盖应用。
- 打包安装流程：
  1. 如果当前应用打开着，先关闭应用。
  2. 安装或者覆盖应用。
  3. 打开应用。
- 如果只是 `npm run build`、`cargo check`、`cargo test` 等验证命令，不属于打包安装任务。


## Logging

- 每次执行任务结束前，必须在日志里写清楚：
  - 目标
  - 完成情况
  - 修改的文件
- 规则
  1. 日志文件放在：`.ai/logs/YYYY-MM-DD.md`
  2. 下面指定的文件夹内的所有文件和指定的文件不需要被观察，不记录在 Modified Files 里
     - `.ai/keypoint.md`
     - `.ai/logs/`
  3. Completed 的内容要按照如下规则
     - 高度总结，突出重点
     - 不要重复描述过程，除非这个过程本身就是重点
     - 总条数不能超过 10 条
     - 每条内容不能超过 100 字
  4. 每次写入内容，都写到最下面
  5. 如果没有文件修改，Modified Files 可以不输出
  6. 如果是讨论性质的对话，不用做任何记录和文件写入

- 日志格式
  ```md
  # Log for hh:mm:ss
  ### Goal
  ### Completed
  ### Modified Files
  ---
  ```

## Key Point With Files

- 当任务满足以下任意条件时，必须启用文件规划流程
  - 涉及多个文件修改
  - 需要重构
  - 需要排查复杂 bug
  - 需要技术调研
  - 预计超过 3 步
- 规划文件统一放在 `.ai/keypoint.md`
- 工作流
  1. 开始复杂任务前
     1. 先读取 `.ai/keypoint.md`
  2. 任务结束前
     1. 长期有用的事实、决策、坑点，写入 `.ai/keypoint.md`
     2. 经常出现的问题以及解决方案，写入 `.ai/keypoint.md`
     3. 不要重复在 `.ai/keypoint.md` 里记录类似的内容
     4. 不要把本轮是否运行测试、是否启动界面、是否人工复看这类一次性状态写入 `.ai/keypoint.md`
     5. 不要把讨论的内容写入 `.ai/keypoint.md`，除非是明确提及或者重复明确出现
- `.ai/keypoint.md` 使用这个格式：
  ```md
  # Key Point

  ## Key Files

  ## Important Decisions

  ## Known Issues

  ## Things To Avoid
  ```