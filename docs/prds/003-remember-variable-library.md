# PRD：Deskmon 记忆力变量库

状态：已实现
目标 triage 标签：ready-for-agent
创建日期：2026-07-06
最后更新：2026-07-24
发布状态：已发布到 GitHub issue #3：https://github.com/l3ve/deskmon/issues/3
当前关系：变量隐私、搜索和剪贴板自动清理规则继续有效；可见宠物时的结果反馈由 PRD 011 统一。

## 问题陈述

用户已经可以通过“记忆力”找回剪贴板历史，也可以把复制过的文本主动保存到“笔记本”。但有一类常用内容并不是从剪贴板自然产生的：密码、token、环境变量、邮箱、地址、命令参数、账号标识等。用户经常需要重复输入这些内容，希望能提前手动保存，并在需要时从 Deskmon 里快速取出。

现有流程要求用户先复制一段文本，再点击“记住它”保存。这对手动维护常用变量不自然，也不适合密码这类敏感内容。用户希望用 key/value 的方式保存变量：平时只看到 key，需要粘贴时点击 key，把 value 写入剪贴板；value 默认不直接展示，避免隐私内容暴露在列表或菜单里。

这个能力仍然应该保持 Deskmon 的轻量边界：它是“记忆力”的一个取用分组，不是完整密码管理器，不做自动填充、浏览器集成、云同步或强安全承诺。

## 解决方案

在“记忆力”中新增一个独立的“变量”分组。变量由用户在“记忆力”窗口里手动创建和维护，每条变量包含唯一 key、私密 value 和可选 note。变量库和“笔记本”分开建模，但共用现有的本地加密基础设施，确保 key/value/note 不以明文落盘。

取出入口保持统一。用户不需要先判断内容来自剪贴板、笔记本还是手动变量；在宠物小菜单“回忆”和“记忆力”窗口中，都按分组展示“记忆中”“笔记本”“变量”。变量条目只显示 key，点击变量后只把 value 写入系统剪贴板，不自动粘贴到当前应用。

所有变量默认按私密值处理。列表、菜单和详情默认都不显示 value；详情区可以临时点击“显示”核对 value，但切换条目、关闭窗口或状态刷新后应重新隐藏。

新增一个全局开关“复制变量后自动清理剪贴板”。开关关闭时，复制变量 value 后不做额外处理。开关开启时，复制变量 value 后启动 30 秒清理窗口：如果期间检测到系统剪贴板已经变成其他内容，就取消本次清理；如果 30 秒后剪贴板仍然等于刚复制的 value，则清空剪贴板。该方案复用剪贴板内容追踪，不监听 Cmd+V，不注册全局快捷键，不要求额外键盘监听权限。

“记忆力”窗口新增搜索能力。搜索覆盖“记忆中”“笔记本”“变量”，但变量只搜索 key 和 note，不搜索 value。搜索结果仍按来源分组展示，不混成一条平铺列表。宠物小菜单保持轻量，V1 不做搜索。

## 用户故事

1. As a macOS user, I want to manually save common variables, so that I do not need to copy them first before Deskmon can remember them.
2. As a macOS user, I want variables to use key/value pairs, so that I can identify a private value without exposing it.
3. As a macOS user, I want variable value to stay hidden by default, so that passwords and tokens are not visible in the UI.
4. As a macOS user, I want the variable list to show key only, so that I can safely open the “记忆力” window around other people.
5. As a macOS user, I want the pet menu to show variable key only, so that private values do not appear in the menu.
6. As a macOS user, I want clicking a variable to copy its value to the clipboard, so that I can paste it myself where needed.
7. As a macOS user, I do not want Deskmon to auto-paste variable values, so that private values are not inserted into the wrong app.
8. As a macOS user, I want variables to appear under the same “回忆” entry as other remembered content, so that I have one place to retrieve remembered things.
9. As a macOS user, I want “记忆中”“笔记本”“变量” to remain separate groups, so that I can understand where each remembered item came from.
10. As a macOS user, I want to add variables inside the “记忆力” window, so that I have enough space to type key/value/note.
11. As a macOS user, I want to edit an existing variable, so that I can rotate a password or token without deleting and recreating the key.
12. As a macOS user, I want to delete an existing variable, so that obsolete secrets are removed from Deskmon.
13. As a macOS user, I want deleting a variable to require confirmation, so that I do not accidentally remove an important value.
14. As a macOS user, I want the delete confirmation to show only the key, so that the value is not exposed in the system dialog.
15. As a macOS user, I want the “记忆力” window to regain focus after variable deletion confirmation, so that I can continue managing variables.
16. As a macOS user, I want each variable key to be unique, so that I always know which value I am copying.
17. As a macOS user, I want duplicate key creation to fail clearly, so that I do not accidentally shadow an existing variable.
18. As a macOS user, I want key whitespace to be trimmed, so that accidental leading or trailing spaces do not create confusing names.
19. As a macOS user, I want keys to support Chinese, English, numbers, spaces, underscores, and hyphens, so that I can name variables naturally.
20. As a macOS user, I want long keys to truncate visually but remain readable in detail, so that the list stays compact.
21. As a macOS user, I want variable value to be required, so that empty variables do not clutter the library.
22. As a macOS user, I want an optional note field, so that I can describe what a variable is for.
23. As a macOS user, I want notes to be visible in the detail area, so that I can distinguish similar variables.
24. As a macOS user, I want notes to be encrypted at rest with the variable, so that contextual private hints are not stored as plain text.
25. As a macOS user, I want notes to be omitted from the pet menu, so that the quick menu stays compact.
26. As a macOS user, I want to temporarily reveal a value in the detail area, so that I can verify what I saved.
27. As a macOS user, I want revealed values to hide again after switching selection, so that they do not linger on screen.
28. As a macOS user, I want revealed values to hide again after closing the window, so that reopening starts from a safe state.
29. As a macOS user, I want copying a variable to show a lightweight success message using the key, so that I know which value was copied without exposing it.
30. As a macOS user, I want copied variable values to optionally clear from the clipboard, so that private values do not stay there forever.
31. As a macOS user, I want automatic clipboard cleanup to be controlled by a global switch, so that I can choose my preferred safety behavior once.
32. As a macOS user, I want automatic cleanup to wait 30 seconds, so that I have enough time to paste across apps.
33. As a macOS user, I want cleanup to avoid touching the clipboard after I copy something else, so that Deskmon does not erase my new clipboard content.
34. As a macOS user, I want cleanup to clear only when the clipboard still equals the copied variable value, so that the behavior is predictable.
35. As a macOS user, I do not want Deskmon to listen for Cmd+V, so that there are no global shortcut conflicts or extra keyboard permissions.
36. As a macOS user, I want search in the “记忆力” window, so that I can quickly find remembered content as lists grow.
37. As a macOS user, I want search to cover recent memory, notebook, and variables, so that one search box can find all remembered things.
38. As a macOS user, I want variable search to match key and note, so that I can find variables by name or description.
39. As a macOS user, I do not want search to match variable value, so that private values are not exposed through search behavior.
40. As a macOS user, I want search terms to stay local and not be recorded, so that searching private labels remains private.
41. As a macOS user, I want search results to stay grouped by source, so that I understand whether a result is temporary, saved text, or a variable.
42. As a macOS user, I want the pet menu to remain lightweight, so that quick recall does not turn into a management interface.
43. As a macOS user, I want variable creation and editing to stay out of the pet menu, so that form-heavy work happens in the window.
44. As a macOS user, I want variables to have a 50 item limit, so that Deskmon remains a small helper rather than a large secret database.
45. As a macOS user, I want adding the 51st variable to fail clearly, so that Deskmon does not silently delete older values.
46. As a macOS user, I want editing existing variables to work even at the 50 item limit, so that I can maintain what I already saved.
47. As a macOS user, I want variables to persist across app restarts, so that common values are available whenever Deskmon runs.
48. As a macOS user, I want variables to be encrypted on disk, so that local files do not contain raw passwords or tokens.
49. As a macOS user, I want old notebook data to keep working after the feature ships, so that adding variables does not erase my saved notes.
50. As a developer, I want variables to be modeled separately from notebook entries, so that different rules do not leak into each other.
51. As a developer, I want encrypted storage to support both notebook and variables, so that persistence remains centralized and testable.
52. As a developer, I want clipboard cleanup to be a small isolated module, so that timing and comparison rules can be tested without UI.
53. As a developer, I want snapshots to hide variable value by default, so that front-end rendering cannot accidentally expose private values in lists.
54. As a developer, I want explicit commands for create/edit/delete/copy variable, so that permissions and validation stay clear.
55. As a developer, I want smoke tests for the window and menu behavior, so that private values are not accidentally shown during future UI changes.

## 实现决策

- 变量库是“记忆力”的第三个分组，和“记忆中”“笔记本”并列展示。
- 变量库和笔记本分开建模；变量不是一种特殊笔记本条目。
- 变量字段为 key、value、note。
- key 必填、trim 后不能为空、全局唯一。
- key 支持中文、英文、数字、空格、下划线和短横线；V1 不做更复杂的命名规范。
- value 必填、trim 后不能为空。
- note 可选，允许为空。
- 变量最多保存 50 条。
- 达到 50 条后新增变量失败并提示用户先删除不需要的变量；编辑已有变量不受上限影响。
- V1 不做变量置顶。
- V1 变量全部默认按私密值处理，不区分普通变量和私密变量。
- 变量列表、宠物小菜单、系统确认文案、复制成功反馈都只显示 key，不显示 value。
- 变量详情区默认显示隐藏态 value。
- 用户可以在详情区临时显示 value。
- 切换变量、关闭窗口或收到新快照导致重绘时，已显示的 value 应重新隐藏。
- 复制变量时只把 value 写入系统剪贴板，不自动粘贴到当前应用。
- 复制变量后，反馈文案只包含 key。
- 自动清理剪贴板是全局开关，不做单条变量开关。
- 自动清理开关关闭时，复制变量 value 后不做任何清理动作。
- 自动清理开关开启时，复制变量 value 后启动 30 秒清理窗口。
- 清理窗口内不监听 Cmd+V，不注册全局快捷键，不引入键盘监听权限。
- 清理窗口内只追踪剪贴板内容是否仍为本次复制的 value。
- 如果 30 秒内剪贴板变为其他内容，本次清理任务立刻取消，后续不再动剪贴板。
- 如果 30 秒后剪贴板仍等于本次复制的 value，则清空剪贴板。
- 清理比较所需的 value 或指纹只保存在内存中的短期任务状态，不落盘。
- 搜索入口放在“记忆力”窗口中，V1 不放进宠物小菜单。
- 搜索覆盖“记忆中”“笔记本”“变量”。
- 搜索结果仍按分组展示。
- 变量搜索只匹配 key 和 note，不匹配 value。
- 搜索词不落盘，不写日志，不记录历史。
- 新增、编辑、删除变量只在“记忆力”窗口完成。
- 宠物小菜单“回忆”只负责取出内容，不提供新增、编辑、删除、搜索或设置。
- 宠物小菜单“回忆”下展示“记忆中”“笔记本”“变量”三个子分组。
- 变量子分组的菜单条目只显示 key。
- 删除变量前使用系统原生确认。
- 删除确认文案只显示 key。
- 变量删除确认关闭后，无论确认或取消，都要把焦点恢复到“记忆力”窗口。
- 全局自动清理开关作为普通偏好持久化；它本身不是敏感数据，不要求加密存储。
- 持久化存储继续使用本地随机 key 文件和加密数据文件。
- 加密数据文件升级为可同时保存笔记本和变量库。
- key、value、note 都必须位于加密数据中，不能明文落盘。
- 存储升级需要兼容旧的只含笔记本的数据；读取旧数据后保留笔记本并初始化空变量库。
- 如果 key 文件或加密数据损坏，变量库和笔记本一样进入不可恢复错误状态，并提示用户重置“记忆力”。
- 重置“记忆力”会清空笔记本和变量库；V1 不做只重置变量库。
- 现有“记住刚想到的”继续只保存当前剪贴板到笔记本，不新增变量。
- 现有“记忆中”仍然只来自剪贴板自动捕获，不因新增变量而改变。
- 从变量取出 value 不主动加入“记忆中”，避免私密 value 出现在临时历史列表里。
- 剪贴板 worker 可以识别“刚由变量复制出去的 value”，避免把它作为普通剪贴板捕获加入“记忆中”。
- 如果用户复制变量 value 后又复制其他文本，其他文本仍按现有规则进入“记忆中”。
- 记忆力窗口需要在标题摘要中体现变量数量，但不要展示任何 value。

建议拆分的深模块：

- 记忆力状态模块：负责“记忆中”“笔记本”“变量”的数据规则、上限、去重、key 唯一、搜索过滤和快照生成。
- 加密记忆存储模块：负责本地随机 key、加密数据版本、旧数据兼容、笔记本和变量库的统一读写。
- 变量库命令模块：负责新增、编辑、删除、复制变量 value、校验输入和返回更新后的快照。
- 剪贴板安全清理模块：负责全局开关、30 秒清理任务、剪贴板变化取消和匹配后清空。
- 回忆菜单模块：负责宠物小菜单“回忆”的三分组结构、变量 key 展示和事件映射。
- 记忆力窗口模块：负责搜索、变量分组、变量表单、value 临时显隐、删除确认后的交互状态。

## 测试决策

- 测试应验证外部行为和模块契约，不测试私有实现细节。
- 记忆力状态测试应覆盖变量 key trim、必填、唯一性、允许字符、重复 key 失败。
- 记忆力状态测试应覆盖变量最多 50 条、达到上限后新增失败、编辑已有变量不受上限影响。
- 记忆力状态测试应覆盖变量快照默认不包含 value 明文，列表和菜单 payload 只包含 key、note 可见信息和必要 id。
- 记忆力状态测试应覆盖变量搜索只匹配 key 和 note，不匹配 value。
- 记忆力状态测试应覆盖搜索结果仍按“记忆中”“笔记本”“变量”分组。
- 加密存储测试应覆盖 key、value、note 不明文落盘。
- 加密存储测试应覆盖笔记本和变量库能一起加密保存并重新读取。
- 加密存储测试应覆盖旧的只含笔记本数据可以读取，读取后变量库为空。
- 加密存储测试应覆盖错误 key 或损坏数据会进入不可恢复错误状态。
- 剪贴板安全清理测试应覆盖开关关闭时复制变量不创建清理任务。
- 剪贴板安全清理测试应覆盖开关开启时 30 秒后剪贴板仍匹配才清空。
- 剪贴板安全清理测试应覆盖清理窗口内剪贴板变成其他内容后取消任务。
- 剪贴板安全清理测试应覆盖取消任务后到期不会清空用户新复制的内容。
- 剪贴板安全清理测试应覆盖复制变量 value 不进入“记忆中”。
- 命令测试应覆盖新增变量、编辑变量、删除变量、复制变量 value 的成功和失败路径。
- 删除确认测试应覆盖取消确认不会删除变量，确认后才删除变量。
- 菜单测试应覆盖“回忆”包含“记忆中”“笔记本”“变量”三个分组。
- 菜单测试应覆盖变量菜单项只显示 key，不显示 value 或 note。
- 菜单测试应覆盖点击变量只写回剪贴板，不自动粘贴。
- 窗口 smoke test 应覆盖新增变量、编辑变量、删除变量、搜索变量、临时显示 value、切换条目后隐藏 value。
- 窗口 smoke test 应覆盖搜索变量时 value 不参与匹配。
- 窗口 smoke test 应覆盖复制变量后的反馈只显示 key。
- 窗口 smoke test 应覆盖全局自动清理开关开启和关闭的基本行为。
- 当前前端没有专用测试框架时，前端交互先写入 QA checklist；实现中优先保证 Rust 状态、存储和清理逻辑测试。

## 不在范围内

- 自动粘贴到当前应用。
- 监听 Cmd+V。
- 注册全局快捷键。
- 右键菜单粘贴检测。
- 浏览器表单自动填充。
- 密码管理器级别的安全模型。
- 用户主密码。
- macOS Keychain 集成。
- 云同步。
- 导入、导出或备份。
- 变量分类、标签或文件夹。
- 变量置顶。
- 每个变量单独设置自动清理。
- 变量 value 参与搜索。
- 宠物小菜单内新增、编辑、删除变量。
- 宠物小菜单内搜索。
- 变量生成器、密码生成器或 token 轮换。
- 审计日志、查看记录或复制记录。
- 强安全承诺或抵抗攻击者同时获取 key 文件和加密数据文件的场景。

## 进一步说明

- 这个 PRD 是 002“记忆力剪贴板历史”的后续增强，不改变 001 桌宠 V1 的边界。
- “回忆”是统一取出口；“记忆中”“笔记本”“变量”是来源和管理方式的分组。
- 变量库解决的是“手动写入并安全取出常用私密值”，不是扩大成完整密码管理器。
- 自动清理选择 30 秒后内容匹配清理，是为了避开 Cmd+V 监听、额外权限和快捷键冲突。
- 变量 value 不进入“记忆中”是重要隐私边界，避免私密值被复制后又以普通临时历史形式展示。
- 配套主状态设计图保存在 `docs/designs/remember-variable-library.svg` 和 `docs/designs/remember-variable-library.png`。
- 完整 UI 流程图保存在 `docs/designs/remember-variable-library-ui-flow.svg` 和 `docs/designs/remember-variable-library-ui-flow.png`。
- UI 设计说明保存在 `docs/designs/remember-variable-library-ui.md`。
