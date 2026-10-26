# 抖音多视频顶层评论回复插件 0.2.0

DeepSeek Harness Bundle，配套 `skills/douyin-replies/SKILL.md`。AI 读取多个本人视频的顶层评论，生成回复并调用工具发送。浏览器采用 Playwright 驱动已安装 Chrome / Edge，借鉴 ego-browser 的观察、操作、验证工作流，不依赖或捆绑 ego-browser。

**当前是可安装、可校准的原型。真实抖音页面选择器与真实账号发送尚未验证，不能承诺安装即自动跑完。** 未提供已验证的抖音默认选择器，首次需要已登录页面校准。多视频处理、顶层筛选、发送、核实、持久化恢复已通过本地 Chrome 模拟页面测试。

## 环境与安装

- 已安装且可运行的 Harness，目标源码 API 为 `0.2.1-rc.3`；声明支持 `>=0.2.1-rc.3 <0.3.0`。该范围是本插件的目标兼容范围，不代表所有后续版本均已实测。
- Node `>=24.9.0`，Chrome 或 Edge。使用 `channel: "chromium"` 时需另行安装 Playwright 对应 Chromium；默认使用系统 Chrome，无需下载浏览器。
- 本机需有图形桌面，用于扫码和验证码。未实现云端远程接管面板。

把压缩包解压到固定位置，例如 `D:\Plugins\dsh-douyin-replies`。在 PowerShell 中：

```powershell
cd D:\Plugins\dsh-douyin-replies
# 链接安装使用插件目录自身的 node_modules，先安装其浏览器依赖。
# --legacy-peer-deps 避免 npm 从公共源解析由 DSH 宿主提供的 peer。
npm install --legacy-peer-deps --ignore-scripts

# web 必须是已经能正常启动 Web UI 的 profile；可替换成实际 profile 名。
dsh plugin --profile web add D:\Plugins\dsh-douyin-replies
dsh --profile web --dump-config
dsh --profile web
```

CLI 未放进 PATH 时，用你的 Harness 启动器替换 `dsh`，源码环境可用 `pnpm dsh`。不要为了安装本插件而盲目安装公共 npm 上同名的旧 Harness 包。

如果宿主 pnpm 拒绝解析与当前安装版本对应的 peer，按当前 Harness 的运行时依赖规则提供宿主 peer；本次没有在真实 Harness 安装中验证这一步。源码入口直接为 JavaScript，无需构建、prepare 或安装脚本。

本插件不自动注册为宿主 Skill Provider。安装后 AI 先调用 `douyin_instructions` 即可读取随包操作说明；也可通过宿主支持的方式加载 `skills/douyin-replies/SKILL.md`。

## 首次使用

向 Harness 中的 AI 提供本人主页完整链接、多个视频完整链接与回复规则，例如：

> 使用 douyin_instructions 阅读操作说明。配置我的账号 [本人主页链接] 和这几个视频 [视频完整链接列表]。只处理顶层评论，语气自然简短，跳过广告和已回复的评论。先扫描并给我回复草稿。

1. AI 调用 `douyin_setup` 配置账号和视频。
2. 调用 `douyin_open_browser`，你在独立 Chrome 窗口内扫码登录。不会直接读取日常浏览器的登录目录。
3. AI 用 `douyin_inspect_page` 和截图检查实际页面，调用 `douyin_calibrate` 保存 CSS 选择器。字段完整说明由 `douyin_instructions` 提供；工具支持评论面板展开和“展开回复”按钮的可选选择器。
4. `douyin_scan_comments` 逐个扫描视频。默认只读已加载可见部分；对指定视频传 `scroll: true` 可继续滚动发现评论。
5. AI 先用 `douyin_reply_context` 读取保存的人格和不回复规则，再用 `douyin_draft_reply` 保存草稿并传回当前 `revision`。`ready: false` 不发送；在用户授权的自动回复任务中可设为 `true`。
6. `douyin_send_ready` 逐条发送并核实结果。默认每批最多 10 条、发送尝试间隔至少 15 秒，均可在 setup 中配置。这是操作节奏限制，不是规避平台限制的机制。

**只有目标用户是顶层评论作者时才操作“回复”。** 发出的回复出现在那条评论下面是正常结果；插件不会选择楼中楼的其他用户回复作为目标。

## 回复人格与不回复规则

设置会持久保存到当前账号的 `state.json`，重启后继续使用。当前通过 AI 工具或 JSON 文件配置，没有独立的图形设置页。

可以直接对 Harness 中的 AI 说：

> 把回复人格设为“亲切、自然、有一点幽默的视频作者”，尽量一句话、最多 80 字，不用客服套话。含“互关”“加微信”的留言不回复，广告引流和人身攻击也不回复，回复里不要出现“保证有效”。请调用 douyin_set_reply_preferences 保存。

工具支持按字段更新，数组会整体替换。完整可修改示例见 `examples/reply-preferences.json`。这份示例不会自动生效，需明确保存；在插件未运行时，也可用命令导入：

```powershell
node src/cli.js preferences .\examples\reply-preferences.json
node src/cli.js preferences
```

| 设置字段 | 含义与执行方式 |
| --- | --- |
| persona.name / role | 人格名称与角色身份 |
| persona.tone / language | 语气与语言，作为模型生成要求 |
| persona.instructions / examples | 补充要求、示例回复，供模型参考，不逐字套用 |
| persona.maxLength | 回复长度上限，与任务 maxReplyLength 取较小值，代码检查 |
| filters.keywords | 评论正文包含任一词就跳过，忽略英文大小写 |
| filters.authors | 不回复的用户名或完整主页链接；重名场景建议用主页链接 |
| filters.categories | 广告、人身攻击等语义类别，由 AI 判断并调用跳过工具 |
| filters.forbiddenReplyKeywords | 禁止出现在生成回复中的措辞，代码拒绝保存或发送 |
| filters.skipLinks | 跳过包含 http(s) 或 www 链接的评论 |
| filters.skipEmojiOnly | 可选跳过只有 Unicode 文字表情的评论，不涉及收藏表情包 |

明确的关键词、作者、链接与长度限制由插件执行；人格语气和语义类别依赖调用模型理解，不是额外部署的分类模型，也不承诺完全消除误判。默认不额外屏蔽关键词、作者或类别。

修改人格或规则时，已有 `ready` 回复降为 `draft`，需要按新要求检查或重写。更新后的设置版本通过 `douyin_reply_context` 的 `revision` 返回，保存草稿时必须带回；旧版本不能直接发送。新规则命中的待处理评论立即跳过；移除该过滤规则后，自动过滤的评论恢复 `new`，不会恢复成 `ready`。人工明确跳过、已发送、待核实的记录均不自动重置。

**收藏表情回复按用户要求暂缓，本版本没有图片/GIF 导入、收藏表情选择或媒体发送功能。** 普通 Unicode 字符仍可随文字回复，收藏表情需以后在真实抖音页面上单独适配。

## 能力与工具

| 工具 | 功能 |
| --- | --- |
| douyin_instructions | 读取配套 Skill |
| douyin_setup | 本人账号、多视频列表、浏览器和批次参数 |
| douyin_set_reply_preferences | 保存/局部更新回复人格与不回复规则 |
| douyin_reply_context | 读取人格、过滤规则、示例、当前设置版本和可选评论上下文 |
| douyin_open_browser | 打开独立浏览器 / 切换目标视频 |
| douyin_inspect_page / douyin_screenshot | 只读检查页面与截图 |
| douyin_calibrate | 校准页面 CSS 适配器 |
| douyin_scan_comments | 逐视频收集可见顶层评论，支持滚动 |
| douyin_draft_reply | 保存回复内容及 ready 状态 |
| douyin_send_ready | 串行发送选定或全部 ready 回复 |
| douyin_reconcile_reply | 核实待确认的发送结果，不重发 |
| douyin_skip_comment | 跳过尚未发送的评论 |
| douyin_reply_status | 查看各视频任务进度 |

模型负责生成内容，插件没有自己的模型 API Key、回复模板引擎或定时轮询。无需重复接入模型。此次交付不包含持续后台监控、服务端抖音 API 或反验证码能力。

## 状态与去重

默认状态目录为 `~/.dsh/douyin-replies`。启动 Harness 前可指定：

```powershell
$env:DSH_DOUYIN_HOME = 'D:\DouyinAssistant\my-account'
dsh --profile web
```

目录包含 `state.json`、独立 `browser-profile/`、进程锁和最近截图。同一目录限一个插件进程和一个账号；不同账号使用不同目录。

- `new → draft / ready → sending → sent / uncertain`。
- `sending` 在点击发送前先写入磁盘。崩溃后恢复为 `uncertain`，不自动重发。
- `sent` 需要页面存在本人主页链接与回复文本的匹配证据，不把点击当成功。
- `uncertain` 只允许继续核实；未看到不等于未发送。必要时在网页展开对应楼中楼，再运行 `douyin_reconcile_reply`。
- 有评论 ID 时以“视频 + ID”去重；无 ID 时按“视频 + 作者 + 原文”保守去重。相同内容的歧义评论跳过；宁可漏掉，也不任意选中其中一条。
- 可见的本人评论及已经包含本人回复的留言会跳过。折叠、未加载或未显示的历史回复无法仅凭 DOM 断言不存在。
- 扫描某个视频失败会继续其他视频。发送发生身份不匹配、页面变化或不确定结果时停止本批，保留其余队列供处理后继续。
- 同一任务中每个视频复用独立标签，保留已展开的评论和滚动位置，操作仍串行。视频较多时会占用更多浏览器内存；浏览器回收或页面重载后需重新加载目标评论。

正常卸载会关闭浏览器并释放锁。若系统强杀留下锁，启动时会检查进程是否还存在；无法识别的锁需确认没有运行实例后手动处理。浏览器会自行管理登录有效期；保留目录不保证登录永不过期。

## 测试与独立诊断

源码包附带 `test/`，安装依赖后：

```powershell
npm run check
npm test
node src/cli.js setup .\my-config.json
node src/cli.js browser
node src/cli.js status
```

浏览器测试在临时独立 Chrome 目录内拦截全部页面请求，使用本地模拟评论区，不连接抖音，也不发送真实评论。26 项测试覆盖多视频、楼中楼排除、页面级回复框、账号/作者校验、重复留言歧义、发送不确定、断电恢复、人格保存、过滤规则与草稿版本校验等。

**验证边界：** 本地真实 Chrome + Playwright 浏览器测试已执行；真实 Harness 宿主装配和真实抖音登录/页面/发送未执行。交付测试报告记录具体结果。不要把模拟页面测试通过解释为抖音线上操作已经验证。

## 卸载

```powershell
dsh plugin --profile web remove dsh-douyin-replies
```

卸载不会主动删除状态或登录目录。若不再使用，可在所有相关进程关闭后自行删除该账号的状态目录。

MIT。操作思路参考 ego-browser；未复制其运行时代码。
