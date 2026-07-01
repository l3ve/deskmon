# Project Rules

## General
- 使用中文和用户沟通。
- 修改代码前，先说明计划。
- 只改和当前任务相关的文件。
- 对于一些不确定性较大的任务，可先读一下 `.ai/keypoint.md`

## Logging

每次执行任务结束前，必须在日志里写清楚：

- 目标
- 完成情况
- 修改的文件

### Rules

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


### Log Format

``` md
# Log for hh:mm:ss
### Goal
### Completed
### Modified Files
---
```


## Key Point with Files

当任务满足以下任意条件时，必须启用文件规划流程：

- 涉及多个文件修改
- 需要重构
- 需要排查复杂 bug
- 需要技术调研
- 预计超过 3 步

规划文件统一放在：

- `.ai/keypoint.md`

### Workflow

开始复杂任务前：

1. 先读取 `.ai/keypoint.md`

任务结束前：

1. 长期有用的事实、决策、坑点，写入 `.ai/keypoint.md`
2. 经常出现的问题以及解决方案，写入 `.ai/keypoint.md`
3. 不要重复在 `.ai/keypoint.md` 里记录类似的内容
4. 不要把本轮是否运行测试、是否启动界面、是否人工复看这类一次性状态写入 `.ai/keypoint.md`。

### File Format

`.ai/keypoint.md` 使用这个格式：

``` md
# Key Point

## Key Files

## Important Decisions

## Known Issues

## Things To Avoid
```