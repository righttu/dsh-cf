# DSH on Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/righttu/dsh-cf)

**实验性、单所有者 DSH 部署模板，不是模型聊天壳。** 容器内运行官方 DeepSeek Harness `0.2.2-rc.1` 的 SDK Profile；Cloudflare 控制层使用 Agents Lifecycle、新 Container API、原生快照和 R2 目录备份。DSH 的模型适配器通过 Worker 的 `AI` Binding 调用 AI Gateway；不要求填写直连 DeepSeek API Key。默认使用待你配置的 `dynamic/dsh` 路由，不预设某个收费模型。

> 尚未完成 Cloudflare 实际部署及推理验收。为避免当前 GitHub 授权缺少 workflow 写权限，本仓库不创建 GitHub Actions 工作流；打包与镜像构建需由 Workers Builds 执行，不能据此声称真实推理与云端快照已验证。DSH 是未经安全审计的 developer preview；Container 快照与 durable_object 调度仍为 beta。不要放生产凭据或重要数据。

## 不用本地命令行的部署

1. 准备启用了 Workers Paid / Containers、R2 的 Cloudflare 账户（会产生费用）。
2. 点击上面的按钮，登录并授权 GitHub 与 Cloudflare，选择目标账户和新仓库名。按钮会复制公开模板；若要直接使用此仓库持续开发，在 Workers & Pages 导入这个 GitHub 仓库并启用 Workers Builds 也可以。
3. 确认 Deploy command 是 `npm run deploy`（完整 `wrangler deploy`），不要用 `wrangler versions upload`。无需 ADMIN_TOKEN / DEEPSEEK_API_KEY。
4. 确认 `BACKUPS` R2 桶已自动创建绑定；若创建失败，在控制台创建 `dsh-cf-backups` 桶后重试。
5. 等待 Workers Builds 完成镜像构建和 Container provisioning。Worker URL 可访问不代表容器就绪。尚未设置 Access 时，应用会返回 403，不能提交任务。
6. **设置邮箱验证码登录**：Worker → Access → Protect this Worker behind Access → **All traffic**（不要只保护 Previews）。然后在 Zero Trust → Access → Applications 编辑对应应用，Allow 策略只 Include 你自己的完整邮箱地址，不要 Everyone，也不要不必要地放行整个邮箱域。Zero Trust → Settings → Authentication 添加/启用 **One-time PIN**，应用仅选择该登录方式。不要添加 Bypass / Service Auth 策略。本应用是单所有者共享工作区，不是多租户。
7. **设置 AI Gateway**：创建同账户 Gateway，开启认证；充值 Unified Billing，或在 Gateway 配置支持的服务商 BYOK（AI Binding 仅使用 default alias）。在 Gateway 创建名称 `dsh` 的动态路由，选择支持 **OpenAI Chat Completions、SSE 流和工具调用** 的模型。本仓库当前配置 `AI_GATEWAY_ID=dsh-cf`、`AI_MODEL=dynamic/dsh`；若改名，在仓库的 Wrangler vars 中修改后部署。也可将 AI_MODEL 改为模型目录中的精确 `author/model` ID。当前不接受 `@cf/` 原生格式，避免不同响应协议被误当 Chat Completions。模型上下文至少 65536、输出上限至少 8192；调整路由时同步修改容器模型声明，并先保存休眠。
8. 打开 Worker URL，输入允许的邮箱并使用收到的一次性验证码登录。提交“创建 hello.txt 并读回”。无需模型 API key 或管理员口令。
9. 点击“保存并休眠”，确认 `running=false` 且出现检查点时间。再提交“读回 hello.txt，并回顾上一条任务”，验证文件与会话恢复。

账户授权、Access 策略、AI Gateway 计费与最终部署确认必须由账户所有者在 Cloudflare 完成。本仓库不含 Cloudflare API token。只点击部署按钮不会自动创建邮箱策略或为模型充值。

## 架构

```
网页 → Cloudflare Access 邮箱 One-time PIN
  -> Worker（ctx.access 平台验证身份、固定 owner 路由）
  -> DshAgent DO + Agents Lifecycle + SQLite jobs
  -> ctx.container / standard-1 / durable_object scheduling
  -> Node HTTP Bridge -> 官方 TypeScript SDK -> dsh sdk（stdio JSON-RPC）
```

- SDK `0.33.0`；Sandbox helpers / shim `1.0.3`；DSH runtime/client `0.2.2-rc.1`。根依赖与容器依赖分离，npm 最新 dist-tag 可能落后于 DSH release，因此不使用 `@latest`。
- 镜像由 Workers Builds 从 Dockerfile 构建。运行时用 `ctx.container.images.dsh` 的 digest 引用。
- 一个所有者、一个容器、固定 root Session `primary`、一次一个任务。容器是安全边界；Linux UID 不是此调度策略下的强隔离。
- `/data/dsh-home` 放 DSH 配置、会话；`/data/workspace` 放工作文件；`/data/state.json` 原子保存 Bridge 的任务原文、最终回复、状态、历史列表与 Session ID；DSH 内部上下文仍由官方 Harness 管理。
- 浏览器查询状态并显示当前任务、历史和可见回复流。新版 Bridge 提供单次权限审批 UI；用户问题仍默认取消。旧快照中的 Bridge 不会因 Worker 发布自动升级。
- `/api/tasks` 接受调用者生成的 UUID；DO 先记录请求意图。同一 ID 不会重新执行。网络超时不是回滚，不能直接换 ID 重试。
- DSH 官方 SDK 没有逐 Prompt cancel；关闭页面不会停止任务。不要启动无限任务或无人值守高风险操作。

## 快照、长期备份、升级

每分钟 Lifecycle job 检查状态。任务不忙且距最近任务结束超过 10 分钟，自动：

1. 拒收并发新任务（DO 串行控制操作）。
2. 确认 DSH 空闲并已优雅关闭；SDK 在任务之间复用 runtime；保存前通过 quiesce 优雅关闭并排空持久化。
3. `DirectoryBackup` 备份整个 `/data` 到 R2，保存返回记录。
4. `snapshotContainer()` 保存可写根文件系统，把快照 ID、备份记录、镜像引用和时间写入 DO。
5. 成功后 `destroy()`，下次任务从快照启动。

手动“保存并休眠”执行同一流程。保存失败保持实例运行并在后台重试；inactivity timeout 是故障兜底，**不保证异常退出前一定保存成功**。

**重要限制：当前不是任务执行中的连续检查点。** 异常退出会丢失最近一次成功保存后的文件与会话变化。长期任务不能依靠本模板自动续跑。DSH `resumeSession()` 修复事件日志并恢复对话，但不恢复进程、Shell、浏览器或外部副作用。

原生快照不保存内存、进程和挂载目录；30 天未恢复会过期，绑定原镜像版本。恢复错误不会静默启动空工作区。没有任务执行时可点“恢复备份”，在当前镜像恢复最近 `/data` 备份并创建新快照；下一任务再验证 DSH 会话兼容性。

升级步骤：旧版本先“保存并休眠” -> 部署新镜像 -> 点“恢复备份” -> 验证会话 -> 再保存。否则旧快照仍是旧版镜像。Worker 部署不会自动替换正在运行的容器。版本迁移并非天然可回滚；升级前另行保留 R2 备份。

R2 数据在主动删除前保留并计费；原生快照按平台 TTL 过期。请求去重记录目前不自动清理。未来应加保留策略、费用配额、任务历史和更强的恢复状态机。

## 网络和模型调用

`enableInternet:false`，所有 HTTP/HTTPS 走 Worker outbound handler。只接受虚拟地址 `https://api.openai.com/v1/chat/completions` 的 POST，请求**不会实际发送给这个域名**。handler 丢弃客户端模型名与认证信息，使用服务端配置调用 `env.AI.run(AI_MODEL, input, {gateway:{id,skipCache:true}})`。Gateway 的 Chat Completions JSON / SSE 原样返回给 DSH pi-ai 模型适配器；真正运行任务的仍然是 DSH，不是 PiHarness。

不允许 GitHub、npm 或通用公网访问；网页搜索工具已禁用。工具链在镜像构建时安装。Node 通过 Container 运行时 CA 信任 HTTPS 拦截。容器只有不含密钥的 SDK 占位字符串；不接触 Cloudflare token 或供应商 key。凭据不暴露不等于无费用风险，必须在 Gateway 设置预算与限流。

Worker 通过 `ctx.access` 确认平台已验证请求，再读取邮箱身份；不相信请求自行提供的邮箱头。所有页面和 API 均需 Access；POST 还必须来自同源。当前无 Static Assets 或 Service Binding 中转；如未来增加，注意官方文档中 `ctx.access` 不传播的限制，不能直接沿用此判断。HTTP Bridge 不对外开放。静态网页由独立的受控预览服务提供（见下文），模型回复仍用 textContent，不渲染进管理界面。

## 构建与验收

不创建 GitHub Actions 工作流（当前仓库授权不支持 workflow 写入）。可由 Workers Builds 执行 `npm run check` 做语法检查及 Wrangler dry-run；Dockerfile 也检查 Bridge 语法。**本次编辑环境没有执行 npm、Docker、真实推理或云端恢复，不能宣称测试通过。** 无密钥打包不覆盖 DSH initialize / resume / 工具权限。

真实部署后必须验证：邮箱验证码、未登录/伪造头请求被拒、Gateway SSE 与工具调用、创建文件、保存停止、同 Session 恢复、R2 灾备、Worker redeploy、重复请求不重放、禁止其他外联。配置或构建失败时先看 Workers Builds / Container / Gateway 日志，不要提供 Secrets。

## 官方参考

- https://developers.cloudflare.com/agents/runtime/lifecycle/
- https://developers.cloudflare.com/agents/runtime/lifecycle/job-queue/
- https://developers.cloudflare.com/containers/api/durable-object-container/
- https://developers.cloudflare.com/containers/configuration/scheduling-policy/
- https://developers.cloudflare.com/sandbox/files/save-a-sandbox-automatically/
- https://developers.cloudflare.com/sandbox/files/back-up-a-directory-to-r2/
- https://developers.cloudflare.com/containers/guides/deploy/
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/persistence.md

- https://developers.cloudflare.com/workers/configuration/cloudflare-access/
- https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/

## 部署表单字段

`AI_GATEWAY_ID` 与 `AI_MODEL` 都是普通变量，不是 Secret。仅填写可见文本的变量输入框：前者是已创建网关的 ID，后者是模型目录 ID 或已配置的 `dynamic/dsh` 路由。模板不应再生成同名的密码框。若仍看到重复字段，请在本次修复写入 GitHub 后退出旧部署向导，从模板重新发起部署；无需删除已经创建的 AI Gateway。

### 为什么之前出现两组字段

Deploy to Cloudflare 会把 `.dev.vars.example` / `.env.example` 中的赋值作为 Secret 表单字段，而 Wrangler `vars` 生成普通变量字段。此前同名值同时出现在两处，造成重复。仅删除 package.json 的描述元数据不会消除 Secret。本模板现删除了无必要的 `.dev.vars.example`，两项值只在 Wrangler vars 中声明；不需要供应商密钥或管理员口令。此规则见上面的 Deploy to Cloudflare 官方文档。旧向导或已复制的模板不会自动同步上游修复；应在确认修复已写入源仓库后重新从源模板开始。

## 界面与状态显示

工作台采用响应式布局，任务区、最近执行结果、运行环境和快照/R2 恢复面板分开呈现。任务示例只填入输入框，不自动执行；支持 Ctrl/Cmd+Enter 提交。R2 恢复有内联二次确认。原始状态与任务标识收在诊断区。控制层连通、容器运行、任务成功是不同状态，不互相等同；界面不模拟 token 流或假进度。当前依然只保留最近一次任务，不是历史列表或文件浏览器。此次仅调整界面，不是底层任务失败的修复。

## 备份通道与旧实例修复

备份使用 DirectoryBackupGateway 与 Worker 的 BACKUPS R2 绑定，不是容器挂载。专用 `backups.sandbox.internal` HTTP 拦截必须先于通用出站拦截注册，参见 https://developers.cloudflare.com/sandbox/reference/directory-backups/#intercept 。旧实例已注册的通用规则无法原地移除；首次保存时会在 DSH 空闲并关闭后创建安全快照、记录 routingRecovery、从该快照重启并按正确顺序注册通道，然后执行正常 R2 备份和正式快照。失败时保留安全快照记录，不自动重放任务，不以备份失败为由直接销毁工作区。

正常启动用原生快照，不从 R2 下载；快照失效时当前版本需用户明确点击 R2 恢复，不会自动降级。恢复流程启动当前镜像，下载并验证 R2 归档，恢复 /data 后建立新快照并停止恢复容器，下一任务再启动 DSH。DO 保存快照句柄与 R2 备份记录；R2 数据独立于容器。若快照和 R2 备份都没有可用副本，无法恢复。性能改善是复用 DSH，尚未做真实延迟测量；界面仍为五秒轮询且无实时输出。

## 闲置休眠与一键恢复

任务之间复用 DSH；任务执行中不按闲置规则停止。idle 时间从最近任务完成算起，页面轮询不会重置；Lifecycle 约每分钟检查一次，空闲 10 分钟后尝试保存 R2 + Snapshot 并关闭。保存失败会告警并重试，不为硬性准点停止而销毁未保存文件，因此不是绝对的费用上限。

恢复按钮只要求没有任务执行且有成功 R2 备份，不再要求用户手动停止容器。若环境运行中，确认后先 quiesce DSH 并留安全快照，再由系统停止环境、启动当前镜像恢复 /data 并建立新快照；不会用当前内容覆盖此次选中的 R2 备份。恢复失败保留安全快照供后续启动使用。R2 是保存时的备份，不是实时挂载或每次写入同步。

## 控制逻辑测试

`npm test` 使用 Node 内置测试器加载实际 Worker 控制代码，替换 Cloudflare 接口为内存模拟，覆盖：备份拦截注册顺序、旧容器安全迁移、忙碌时拒绝保存/恢复、完成后十分钟计时与轮询不续期、一键恢复不覆盖选中备份、恢复失败保留安全快照。`npm run deploy` 在 Wrangler 部署前自动运行测试，失败则不继续部署。模拟测试不证明真实 Cloudflare 快照或 R2 上传可用；真实集成、DSH 热复用及模型延迟仍需部署后验收。

## 紧凑历史与文案

页面提供可折叠任务历史列表，只显示最近最多 50 条、总计约 88 KB 的预览，长文本显示节选；完整任务记录不裁剪，保存在 `/data/state.json`，随 `/data` 一起备份。该用户可见记录从本版本开始；旧版本没有保存任务原文，不能补造，也不把内部 DSH 工具日志冒充聊天原文。

运行时历史直接从容器读取；停止时展示最近保存时的副本并标注来源，不会为查看历史启动容器。R2 恢复后会启动轻量 Bridge（不调用模型），从已恢复文件重新读历史、更新最近结果，再创建快照并停止；不会用恢复前的 DO 缓存证明恢复成功。文件可读不等于 DSH `resumeSession` 一定兼容。

Worker 更新不等于旧容器镜像更新。旧容器提供不了历史接口时会明确提示；先保存，再恢复 R2 备份可切换至当前镜像。这个操作保留已有 `/data`，但不会补齐旧版未记录的任务原文。网页登录由 Access 管理，不属于 DSH 会话备份。

## Snapshot 启动演示与实时回复

右侧“启动与响应实测”分别显示最近启动来源与启动至服务就绪耗时，以及当前任务首次模型调用前、首次公开回复文字的耗时。启动计时从 Worker 调用 `container.start` 前开始，到容器内 Bridge `/status` 首次成功响应为止，包括容器启动、外联策略注册、Bridge 启动和就绪检查；不是纯底层 VM 启动耗时，也不包括随后惰性初始化的 DSH、会话恢复或模型生成。热运行不生成虚假的新启动数据。日志可搜 `DSH_BOOT_TIMING` 与 `DSH_RESPONSE_TIMING`，仅包含 ID、时间和耗时，不含提示词、回复或凭据。

演示步骤：任务结束后点击“保存并休眠”，待停止后点击“从快照唤醒并测速”。按钮仅从已保存 Snapshot 启动，不创建聊天任务、不调用模型，也不在缺失快照时用镜像启动冒充。随后发送简短任务，观察聊天首字等待；该服务端计时从 Bridge 接收任务起算，与启动耗时分开。页面还在本次首个文本事件到达时显示浏览器观察到的等待时间；断线或重连可能影响它，不能等同纯模型首 token 时间。

公开回复通过模型网关 SSE 的 `choices[].delta.content` 实时观察，并通过经过同一 Access 认证的 `/api/events` 推送到页面；原始 SSE 字节不变，DSH 仍掌握完整工具与任务循环。不会发送内部推理或工具参数。中间输出不等同最终回复；最终内容仍由 DSH 完成结果覆盖。模型调用不提供 SSE 时不能伪造逐字流；依旧显示最终结果。流式视图是临时内存缓存，最终聊天记录仍保存在容器；页面断线不取消、不重放任务。忙碌时每秒查询状态作为断线兜底，闲置时每五秒查询，均不更新逻辑闲置计时。

本次流式观察在 Worker 层实现，无需为了它删除文件或强制升级旧快照里的 DSH。不调整模型路由、推理强度，也不承诺消除尚未分解测量的 DSH 前置准备耗时。

## DSH 前置延迟分段诊断

Bridge `timing-v1` 为每个任务报告是否复用已初始化运行时、运行时 ID、启动/握手耗时、恢复会话耗时、准备总耗时、写任务状态耗时和进入 SDK `run()` 的时间。Worker 在首次模型外联时读取当前 Bridge 状态，记录 `DSH_PREMODEL_BREAKDOWN`，将首次外联前的总等待拆出“进入 Agent 后到模型调用”的区间。该区间仍包含 Agent 准备、内部操作与网络调度，不将它冒称纯模型时间。查看页面右侧新增指标或 Worker 日志即可区分冷初始化和热任务开销。

Bridge 的准备日志 `DSH_PREPARE_TIMING` 写入容器 `/data/bridge.log`；Worker 的 `DSH_PREMODEL_BREAKDOWN` 可在 Workers Observability 中读取。仅记录 ID、阶段和时间，不记录提示词/回答。新版 Worker 接旧快照时缺失分段数据会明确标记，不把未知数据当零。需要启用容器内分段计时时：先成功保存当前文件，再从 R2 恢复以使用新镜像；这不是重新创建空环境。

自动闲置休眠由容器外 `DshAgent` 的 Agents Lifecycle 持久任务 `inspect` 实现，约每分钟以 Durable Object Alarm 唤醒控制层检查。没有任务执行且距离最后一个任务结束超过 10 分钟时，关闭并刷新 DSH、备份 `/data` 到 R2、创建 Snapshot、保存记录，再 `container.destroy()`。任务持续执行不按闲置规则停止，页面轮询不更新 lastActivity。检查周期意味着约 10–11 分钟，而非精确到秒。`setInactivityTimeout(5 分钟)` 是平台在 Durable Object 不再活跃时的容器存活兜底；正常 inspect 每分钟保持控制层活跃，它不是用户闲置 10 分钟计时器。故障、平台停止或进程异常仍可能导致最后一次成功保存后的变化丢失，不承诺绝对不丢失。

## 响应计时口径修正（timing-v2）

旧统计混用了容器 task.startedAt 与 Durable Object 的时钟，跨环境时钟偏移会产生约几十毫秒负值。新任务从控制层提交任务时持久化同一控制层时钟的起点，到首次模型调用/首次公开文本都在同一控制层计时。它不包括之前的 Snapshot 启动；包含任务提交与状态写入开销。旧任务缺少起点时返回 null，不将负值截成零伪造数据。页面不展示负耗时。进入 SDK run 到模型调用前的区间由 Bridge 的单调时钟在状态查询时计算，不再做跨时钟相减；没有新版 Bridge 则该项未知。


## 隔离的静态网页预览

工作台的“网页预览”接受 /data/workspace 内的相对目录，要求 index.html。输入 coffee-site（根目录用 .），点击打开 / 刷新预览。示例任务按钮可让 DSH 创建无外部依赖的测试网页，绝不在部署时自动执行任务或覆盖用户文件。

Worker 经 Access 验证后，以受控 exec 启动 Node 静态服务（8090）并设置随机能力头；不会公开 8080 DSH Bridge，也不会开放任意端口、互联网、部署 Token 或 Docker。脚本包含在 Worker 中，因此旧镜像/旧快照也可启动预览，不需以升级为由覆盖工作区或进行 R2 恢复。配置/能力头持久保存在 DO 中；服务进程不随快照恢复。仅显式打开时启动服务，旧链接不自动唤醒；每次打开产生新 ID，关闭后旧链接失效。

预览路由仅支持 GET，文件限制在选定目录，realpath 检查阻止符号链接逃逸，隐藏文件和非白名单类型不提供，单文件最多 5 MiB。不转发 Cookie/Access/Authorization 等浏览器请求头给容器。读取成功更新空闲时间；保存/休眠仍会停止预览，需显式重新打开。

安全隔离：iframe sandbox 只允许 scripts，不允许 same-origin/forms/popups/top-navigation；预览响应自身也有 CSP sandbox（新窗口同样生效）、connect-src none、frame-src none、form-action none、无缓存、nosniff。Origin:null 仅允许预览只读路由，管理 API 继续要求同源。不能把 allow-same-origin 加回去；需要完整模块/HMR/API 支持时，应先提供独立预览域名和独立认证策略。

本版本仅预览 HTML/CSS/普通 JS 和本地图片字体，使用相对资源路径；不安装依赖、不构建、不代理后端 API、不支持外部 CDN、ES 模块开发服务器或 Vite HMR，也不等于正式网站发布。浏览器实际显示/Access 子资源加载仍需真实登录验收。

## 网站、自检截图与单次权限审批
保留原始版式和可见的快照/R2 面板；减少重复说明。咖啡馆示例要求 Agent 在完成网站后主动调用 /app/site-check.mjs，通过 Cloudflare Browser Run 使用真实托管 Chrome 检查、修复重测、保存报告和桌面/手机截图。提示词不再列出 CDN 等负面限制，实际 egress 和浏览器 CSP 仍然执行；没有放开互联网。
截图及报告在当前 Agent 回复正文下自动呈现，不需要额外点自检。截图只证明捕获到的页面；实际断言结果、页面/资源错误与失败项单独显示。读取报告时拒绝早于本次任务的结果。静态链接仍要求 Access 登录，最长 1 小时，关闭不删除文件。
权限：SDK approval/request 原样展示工具、会话、调用标识和原因，用户选择 allowed-once 或 rejected。SDK 不提供完整工具参数，原因并非可信完整命令；不确定时拒绝。申请 5 分钟过期取消，重启未完成审批取消，不自动恢复授权或重放任务，完成任务清理待决审批；记录保存在 /data/state.json。审批只允许工具这次操作，不改变容器 Outbound 策略；真实网络结果由工具报告，界面不模拟 403。用户批准的工具操作可能删除/修改文件，审批不是路径级安全隔离。
浏览器已切换为 Browser Run 的 BROWSER binding + 官方 CDP 接口；容器不再安装 Chromium/playwright-core。Agent 仍主动执行 /app/site-check.mjs，它只向受控虚拟地址 dsh-selfcheck.internal POST 网站子目录；Worker 用一次性受限 BrowserSite Fetcher 读取当前静态预览。Browser Run guardrails 只允许 dsh-site.test，HTTP 虚拟域名不走公网 DNS；浏览器不能访问控制台、任意 URL 或公共互联网。原有容器模型外联策略未放宽，不能用浏览器绕过它。BrowserSite 无公开路由，props 限定预览 ID 和 120 秒时限；浏览器关闭后不保留 Live View URL 或会话令牌。SDK 依赖为原生 BROWSER binding，无额外浏览器 npm 包。并发检查被 DO lease 拒绝，不自动重试检查；真实错误和截图经 helper 写入网站目录，报告照常显示在聊天回复下。CDP 检查包含真实 DOM 筛选、加入、重置、资源错误以及桌面/移动尺寸截图；不是全站完整验收。检查约定的 data-testid 见 /app/site-check.mjs。
重要：Worker 发布不替换旧快照镜像。审批 Bridge 与新自检客户端需要当前新版镜像：必须先成功保存所需数据，再显式从 R2 恢复来切换；不自动销毁旧环境、不假装旧快照已有这些功能。

## 自定义域名
主入口配置为 https://dsh.righttu.uk（Wrangler routes custom_domain）。保留 workers_dev:true 作为迁移期间备用入口。部署需要 righttu.uk 是同账户的有效 Cloudflare zone，且构建部署凭据具备创建 Custom Domain 所需权限；已有冲突 CNAME 不会在代码中擅自删除。域名记录和证书由 Custom Domains 管理，不需要手工把 CNAME 指向 workers.dev。
继续使用 Worker 级 Access / All traffic 时，新 Custom Domain 也受同一策略保护；如果现有应用只按旧 hostname 保护，账户所有者需在 Access 为新域名配置相同的邮箱允许策略。应用仍强制检查 ctx.access，未认证请求拒绝，不添加 Bypass。域名实际解析、证书和登录需部署后验证。

本次只迁移自检浏览器，不实现自动镜像升级，不修改 saveAndStop/recover/boot 的升级与数据选择语义。BROWSER binding 的实际可用性、私有 outboundByHost 路由及 CDP 流程需 Cloudflare 真实运行验收；单元测试不证明这些线上链路已通过。

## 无最终回复与结束原因
completed 不是仅看 SDK 是否抛异常：max-tokens/length 或没有最终公开回复都显示失败，不自动重试，不清空 DSH 会话或改动文件。Worker 对旧 Bridge 的状态和历史也执行该展示修正，因此不用为了获得新诊断而重建容器。新增 DSH_MODEL_REQUEST_META / DSH_MODEL_RESPONSE_META / DSH_MODEL_RESULT_META，仅记录预算字段、HTTP 状态、返回结构、finish_reason、公开回复字符数量、是否含推理/工具调用以及数字 token 用量；不记录对话、推理正文、工具参数或凭据。原始模型流仍逐字节透传，未调整模型、token 上限、路由或 reasoning 设置。max-tokens 是 DSH 报告的结束原因，并不单独证明真实预算耗尽；需对照上游 finish_reason/usage 和返回结构继续定位。

## 独立 DSH 会话
控制台新增“新建会话”和会话选择器，保持原有侧栏、预览、聊天证据、快照与 R2 布局。新会话使用随机 UUID，独立 DSH 模型上下文，但共享 /data/workspace 文件；不会删除旧对话或文件，不自动压缩或重放任务。旧 state.json 自动登记原会话，原有未标记的任务归入原会话；完整历史仍保存在同一 state.json，当前历史视图只展示所选会话。注册表与所有 DSH 会话目录随 /data 一起备份/恢复。
创建/切换只在空闲时允许，通过同一 DO 排队和 Bridge busy 锁协调；提交携带预期 sessionId，跨页面切换后过期提交拒绝。切换关闭并刷盘旧 Harness，再选新上下文；已有会话必须 resumeSession，失败不另建替代。全新上下文用官方 getWorkingDirectory 物化并保存后才标为可恢复，尚不调用模型。首次任务作为会话标题；不支持删除会话。仅查看状态/历史不唤醒容器，显式创建/切换会唤醒。
Bridge 标识 sessions-browser-run-v1。旧容器没有 /sessions 时，Worker 不假装新建成功；需先成功保存，再显式从 R2 恢复新版镜像。没有实现自动升级或销毁旧环境。新会话不继承旧聊天，但仍有 DSH 系统提示和工具定义，不能承诺空白会话只有用户输入的 token。

## Browser Run 失败定位
浏览器先 acquire/launch 获取页面 targets，再 connectSession(sessionId,{targetId}) 显式连接 page target，必要时 devtools.newTarget。CDP 错误包含命令名称，报告记录 failedStage/failureKind。入口未加载时不继续跑 DOM 测试或拍空白截图。启动/连接/协议失败返回 retryable:false 与停止本轮自检的建议；新的网站提示词要求平台失败时不要通过 Bash 提权反复重试。此规则不是自动批准、取消或禁用工具权限；用户仍决定审批。DO lastBrowserCheck 和 Worker DSH_BROWSER_CHECK 保存精简失败诊断，不保存图片、Live View URL 或会话令牌。HTTP 200 仅指报告成功送达，不代表检查通过；passed 才是检查结果。未修改容器 egress 或 Browser Run allowlist。显式页面连接是兼容性修正，不能在真实 Browser Run 截图验收前宣称线上问题已解决。

## 双版本演示（需本次构建部署成功）

同一次部署提供两个命名镜像：dsh（V1）、v2（V2），用构建参数写入 /app/runtime-version.json。V2 唯一功能差异是 /status 返回实际 process.version。版本文件不在 /data 内，R2 恢复不会覆盖它。保留已有镜像依赖版本和数据格式；不是任意版本降级兼容机制。

运行环境卡提供升级入口和版本选择；V1 提示 V2 可用，切回 V1 后可重复升级。旧运行容器不被部署强制替换，无法确认的旧版本显示未标记。首次演示可手动选择 V1 建立起点。停止状态展示的是已保存版本，不冒充运行中版本。

切换时拒绝活跃任务、待审批和 Browser Run 检查；成功 quiesce、R2 备份、安全快照后才停止旧容器，固定此次备份并恢复到目标镜像；核验版本、V2 功能和会话目录后提交新版快照。保护的是 /data 内成功落盘的数据，不保存内存、进程或其他目录。额外后台作业尚无通用追踪，确认框明确要求用户先处理。

持久化 versionOperation 阻止中断后继续工作或自动重试，失败后只能由用户明确点击恢复切换前环境；这使用保存时的安全快照，不是自动回滚。新检查点与清除操作标记、恢复优先级使用同一 storage.put 提交。正常 R2 恢复使用已选择的运行版本；历史任务不重放。

本轮未改实例规格，仍是 standard-1；未实现自动升级或任意历史版本管理。单元测试不等于真实云端切换验收。

## 显式快照与重启演示

新增创建快照按钮：刷盘、备份 /data 到 R2、创建快照，但不停止环境。重启按钮要求确认快照时间，从这一已保存快照重启，不新建 R2 备份、不走 R2 恢复。快照之后的修改不在恢复环境中；停止前另存安全快照，并保留 lastRestartSafety 引用。失败持久化操作标记，阻止自动重试，手动恢复可使用操作前安全快照。

正式顺序：先做版本切换与资源变更，再创建文件 A；创建快照（同时备份 R2）；重启，读取 A；新建文件 B；不再保存或升级，直接确认恢复原 R2 备份；只读核验 A 存在、B 不在此备份中。自动空闲保存约 10 分钟会更新最新备份，彩排时应核对备份时间，避免更新后再恢复。R2 恢复可能使 B 不再出现在工作目录，是明确的备份回退，不是文件自动丢失。

更新入口文案改为发现新版本，升级；具体目标版本在说明及确认处显示。快照不参与隐藏更新提示的判断，创建 V1 快照后仍应提示 V2 可用。身份验证、独立会话不作为演示项，但功能与安全控制未移除。定时任务移出本次主线。

## 实例规格与分析演示稿

新增实例规格选择：运行时支持 lite、standard-1 至 standard-4（不接受 basic）。自定义配置支持整数 1–4 vCPU、每 vCPU 至少 3072 MiB，总内存最多 12288 MiB、磁盘最多 20000 MB。允许升降规格；继续通过 R2 迁移 /data，不用快照直接执行规格切换。目标磁盘需容纳镜像、恢复数据和恢复过程的额外空间，ENOSPC 等失败会保留原安全快照供显式恢复。规格展示来自实际 start 参数记录，不冒充操作系统用量实测。

规格修改复用版本迁移保护流程：拒绝活跃任务、审批与浏览器检查，成功备份并创建安全快照后启动相同 V1/V2 镜像，以固定本次 R2 备份恢复 /data；成功后提交 selectedInstance、activeInstance、带规格的检查点。失败保留原快照，用户显式恢复。版本切换、快照唤醒/重启、R2 恢复均沿用所选规格。旧无版本标识环境必须先切到 V1 或 V2。新部署不强制更换已运行镜像；切换至另一版本可加载新版工具。

任务示例改为 review-deck 五页 HTML 季度分析演示稿，不是 PPTX 或永久部署。Agent 从现有 CSV 接续或创建明确标注的合成数据，通过 Node 实际计算 report-data.json 与页面。私有 Browser Run 校验五页结构、翻页/页码、CSV总额与JSON/页面一致、截图和视口溢出。数据由受限 Fetcher 读取，不放开页面 CSP connect-src。预览新增只读 CSV MIME 支持；旧咖啡馆文件不会被删除或改名。

控制台 CPU、内存、硬盘分别展示当前启动配置（停止时为已保存配置）。版本可用性由控制层的已部署命名镜像和保存版本记录比较，不要求容器运行；不是容器内的在线更新检测。停机时可以确认版本升级，流程先唤醒原快照、备份最新 /data，再启动目标镜像并从 R2 恢复，完成后保持运行。这不是纯离线设置下次启动镜像。规格切换仍需先显式唤醒。升级按钮始终可见：可用时橙色，不可用时灰色。快照缩盘实验入口和独立容器配置已移除；历史结果见 experiments/snapshot-resize.md。

## 实验 DO 退役声明

SnapshotLab 曾经部署并创建了持久 DO namespace。移除实验代码、容器与 binding 后，必须在 exports 长期保留 `"SnapshotLab": { "type": "durable-object", "state": "deleted" }` 退役标记，否则平台以 orphaned_provisioned_namespace 拒绝部署。不要把此标记误删，也不要恢复实验类。仅退役实验 namespace；DshAgent 继续保持 sqlite live export，正式工作区与 BACKUPS bucket 不在删除范围。此声明不等于删除 R2 对象或平台快照。

## 环境切换进度与租户边界

版本/规格操作使用独立持久 environmentProgress 记录真实阶段（包括升级前唤醒、quiesce、R2 备份、安全快照、停止、目标启动、R2 恢复、核验、新快照），versions/progress 不进入操作队列，可在备份等长操作中轮询。进度框显示阶段与失败信息，不伪造字节百分比；刷新读取的是最后报告，不会自动重试操作。

当前不是多租户：Access 校验 email，但所有请求仍定位 DSH.getByName('owner')。所有获准用户共享同一 DO、容器、SQLite-backed storage 和 /data。BACKUPS binding 指向同一个 R2 bucket，DirectoryBackup 使用 dsh/ + 随机备份 ID，记录由 DO 持久存储选择，不能由请求参数随意指定记录。UUID 和 prefix 不是授权边界。多租户实现必须先验证身份、服务端映射租户 DO、为每个租户保持独立 checkpoint/backup 引用，并实施租户级授权；不能仅放开 Access 多个邮箱。Agent 容器不持有 R2 凭据或 DO SQLite 文件，目录传输通过受限 DirectoryBackupGateway，由 Worker/DO 的 R2 binding 访问 bucket。

## 模型预算修正（2026-11-09）

Workers 模型结构日志观察到两次 length 截断：prompt/completion 分别为 12525/8192、26939/8192，请求 max_completion_tokens=8192；不是这两次输入超过 64K。另有旧长上下文调用 64563/1，需区分输出预算耗尽和上下文挤压。日志只存结构、计数，不存推理原文。DeepSeek Flash 官方当前列出 1M context、384K max output（https://api-docs.deepseek.com/quick_start/pricing/）；应用先保守声明 contextWindow=131072、maxTokens=32768。未改 dynamic/dsh 路由、未关闭 thinking、未自动重试。动态路由换模型时必须重新核对预算；这只是本应用声明，不代表已经验证 Gateway 或适配器支持任意上限。更大预算可能增加费用和耗时。

配置在镜像 /app/gateway.cordis.yml；Worker 部署不会替换旧运行容器或旧快照，必须显式切换至当前构建的新镜像才加载新预算。不要只恢复旧快照并认为预算已更新。32K 仍可能耗尽，不保证任务必成功。

进度框面向用户使用启动实例、备份数据、生成快照、重启实例、恢复数据、检查运行状态、保存启动状态。重启合并了底层停止/启动两阶段。检查由 DshAgent 控制代码发起，桥接服务提供版本/状态/会话；DirectoryBackup 和平台 API 分别执行数据传输、容器生命周期和快照操作。

## 会话删除与上下文诊断

新增删除当前会话及应用任务历史，忙碌时拒绝；删除前关闭 SDK、取消待处理审批。删除最后一个会话会生成新 UUID 的空上下文。持久删除标记阻止以同一 ID 重建/选择；相关 request 缓存清理。共享工作区文件不删除。此操作不是安全擦除：SDK 原始持久文件和旧快照/R2 备份保留，恢复旧备份可能带回记录。当前 SDK 高层 API 没有明确的删除会话方法，因此不猜测其目录路径做 rm。

SDK handle.id 和运行结果 sessionId 必须等于所选会话；不一致时失败，不自动切换。新增 DSH_SESSION_CONTEXT 记录 UUID 与 new/resume；DSH_MODEL_REQUEST_META 关联 task/session/callIndex，记录消息角色数量、各类字符数、工具定义数量/长度及输出上限，不记录任何内容；字符数不是 Token 数。用于验证新会话首轮和工具循环的上下文构成，不能把总 usage 直接解释为旧聊天混入。共用工作区允许 Agent 按任务读取已有文件，不等于自动拼接全部旧聊天。

## 演示界面信息层级

顶部仅保留实例启动至服务就绪、最近任务聊天首字两项实测，口径不同，不相加：前者不含 Agent 初始化或模型生成，后者为任务开始至首个可见回复（可能是中间输出）。原始初始化、恢复、模型调用前耗时与时间说明保留在右侧默认折叠的“查看耗时明细”，不更改测量逻辑。右侧按运行环境、快照与休眠、从备份恢复、手动唤醒测速、耗时明细排列；不删除恢复覆盖风险、/data 迁移范围等确认说明。只改 UI 不会更新运行中的镜像或 Token 预算。

## 桌面演示与授权可见性

演示任务改为 1280×720 桌面宽屏、编辑式暖白/深绿/陶土橙设计方向，提示 Agent 使用已有 Node 和本地资源，不安装额外绘图或浏览器依赖。相关本地步骤尽量以少数可审阅脚本完成，但 SDK 每次所需权限仍只允许一次，不能自动批准或复用。权限请求不等于工具缺失；现有日志不包含申请原因，不能从审批 API 次数判定具体原因。审批卡片与允许按钮突出为橙色，右下角待授权入口可定位。

内嵌预览固定桌面视口并按容器等比缩放，外部“大屏演示”打开原页面；Browser Run 逐页检查桌面布局、翻页和数据，仅生成桌面截图，不再要求手机截图，旧手机截图不在控制台展示。界面和检查逻辑部署后生效；已有演示稿文件不会自动改写，需要再次明确提交修改任务；旧手机截图文件不删除，但 UI 不展示它。艺术质量由实际成果与真实截图验收，提示词和单元测试不构成视觉验收。

## V1/V2 共用完整演示能力

两张新镜像使用同一 Dockerfile 和相同资源、SDK、模型路由、60 秒初始化配置、浏览器检查客户端和示例数据；配置显式传入 DSH_APP_VERSION=v1/v2，仅以 runtime-version.json 中版本值和控制台徽标区分：V1 青蓝，V2 墨绿。Node 诊断两个版本都提供，不再以功能缺失做差异。构建对两版共用的 /app 资源做存在性断言。

资源在 /app，R2 恢复只针对 /data。版本切换不删除用户 CSV、HTML 或会话；新镜像标签通过 R2 迁移最新 /data，并非回退到旧版本的历史数据。源环境具备新版演示能力时，目标必须同样具备，否则切换失败并保留安全恢复，不能将“版本号正确但工具丢失”当成功。旧快照/镜像不被原地修改；部署后先显式“更新运行镜像”，再切换版本才是新的 V1/V2。首次准备可放入缺失示例，已有 CSV 始终复用。

新增容器模块后，动态 data: URL 测试模拟必须把相对模块导入转换为绝对 URL；本轮同时修正 demo-environment.mjs 的测试加载，避免测试因找不到相对模块而失败。完整测试和双镜像构建均以 CI 为准，不等于云端任务/截图已验收。

## 网页生成 → 浏览器检查的演示闭环

任务目标是 DSH Agent 生成三页中文经营网页并主动执行 site-check.mjs，真实 Browser Run 检查翻页、数据、桌面布局、截图，必要时修复并复查。提示采用正向短任务，直接给出文件位置和 data-testid 约定；不再强制 build-review-deck.mjs，不把演示改成固定程序直接出成品。旧模板与生成器只保留兼容，不是本示例的必要执行路径；原单元测试仍验证它们。

演示前步骤：部署成功后点击“更新运行镜像…”，确认通过现有备份/R2迁移/新镜像/验证流程刷新运行环境。支持相同 V1/V2 标签显式刷新；普通同版本切换仍不重启。保留规格和 /data，其他目录不迁移，预览和进程中断，不重放任务；失败保留原安全恢复。仅刷新页面或从旧快照重启不更新镜像。

然后可新建会话（旧对话、文件保留），点击“准备演示环境”。该操作不会调用模型：验证检查客户端、复用 review-deck/sales.csv，只在数据缺失时从镜像自带的合成示例 CSV 复制一次，绝不覆盖已有 CSV；计算 report-data.json，按实际月份报告区间，最多 6 个月、5 区域。拒绝目录/数据/产物符号链接，只写该演示目录，不修改 index.html、咖啡网站或无关文件。准备就绪仅证明本地客户端和数据就位，不代表 Browser Run 已执行或健康检查通过。

点击原样的演示示例并提交时，通过显式 demo 标记再次在进入 SDK 模型循环前确认准备状态。旧镜像直接报告更新要求，不创建任务受理意图、不调用模型找脚本；修改提示或自定义任务不强制套用该模式，可先手动准备。自动准备不新建/切换会话、不加载模板、不生成网页、不自动重试任务；权限仍单次批准。Browser Run 仍真实逐页验证 3/5 页；不修改检查绕过失败，不假造截图。演示速度、模型轮数和艺术质量需要真实任务验收，不能保证一次调用或两分钟。镜像、Worker 发布和运行中环境是三个不同状态。

## 顶部实测与环境管理顺序

取消两个指标卡片，将实例启动和聊天首字直接放入 Workspace 顶栏，以橙/绿数字强调；测量口径仍保留在悬停说明，启动方式和时间在折叠明细中。任务标题条、结果证据、右侧环境底板、快照和恢复采用不同层次与有限色彩区分；侧栏和双列结构不变。右侧先版本更新，再实例管理。

SDK 0.2.2-rc.1 的 initializeTimeoutMs 官方默认 10000ms。桥接明确设为 60000ms，仅延长 profile sdk 初始化握手，不改模型预算、不自动重试或重放。initialize timed out 表示初始化未在期限内完成，不能据此断定 CPU、内存或插件是根因；增加窗口仅缓解慢启动，挂起/配置错误需另查。此设置在容器镜像内，Worker 发布后必须显式迁移到新镜像才生效，旧快照仍可能保留 10 秒设置。API 参考：https://unpkg.com/@deepseek-ai/dsh-sdk-client@0.2.2-rc.1/lib/types/types.d.ts 。


## Agent 实时等待阶段与费用口径

在任务标题下显示阶段、简短说明和本阶段已用秒数，复用现有状态刷新，不新增轮询或保活定时器。优先级：当前任务未过期的待授权 → 当前浏览器检查租约 → 未结束模型调用（首个流式事件前等待响应，之后正在接收模型流）→ Agent 初始化/恢复 → 通用执行。无事件证据时不推断具体本地工具，不显示虚假的 CPU 使用率、零费用或“容器完全空等”。断线显示状态不可用；结束隐藏阶段。

DO KV 保存当前任务最多 32 个未结束模型调用的 ID/时间，兼容并行调用和 DO 重建；开始、首次公开文本、结束时写入，普通文本分片不重复写阶段。旧任务记录忽略，15 分钟未结束的模型记录保守失效；浏览器以 180 秒租约绑定 taskId，释放或过期后不再宣称等待浏览器。错误/非流式模型返回清理等待；流中断若结束事件丢失，依赖任务终态或记录失效，不冒充 CPU 监测。现有实时正文与模型轮数统计口径不改变。

费用参考 https://developers.cloudflare.com/containers/platform/pricing/ ：CPU 按 active usage（实际 vCPU 时间），内存/磁盘按 provisioned resources 和容器运行时长。等待外部模型/浏览器/授权可能减少 CPU 消耗，但不代表 CPU 为零、整个容器免费或 DO 已休眠；Worker/DO、模型、Browser Run 等另计。页面提示只解释阶段，不计算账单。


## 当前任务等待占比（采样估算）

模型阶段按是否收到有效流式事件区分等待/接收，不使用含糊的“正在接收模型响应”；删除模型阶段说明段落。其他已证实的浏览器/授权阶段仍显示。

只为新增提交初始化 taskWaitMetrics；现有状态接口约每秒按互斥阶段（授权优先于浏览器，再模型）累计时间，模型含整个请求和流式返回，重叠不重复计数。总用时从控制层任务受理开始，不含此前容器启动和环境准备；结束时间用容器 finishedAt 并约束在最近采样与控制层当前时间之间，结束后冻结。累计指标存在 DO KV，DO 重建不归零；并非完整跨备份历史统计。

不是事件级完整追踪，也不是 CPU 空闲率。大于 3 秒的采样缺口、初次采样前时段归为未观测，不伪装等待/执行；观测覆盖不到 90% 时不显示占比，只显示已有时间、覆盖率及观测不足。短于刷新周期的阶段可能漏采。关闭页面/网络中断后不靠客户端时钟猜补；旧任务没有本统计则不追溯捏造。结束后保留当前任务汇总，新任务替换；细分时间为按优先级互斥归类，不是每个模型调用的独立耗时之和。没有新增刷新定时器或模型调用。


## 模型流开始与正文首字分开

状态在发起请求后为“等待模型响应”，收到第一条可解析的 SSE JSON 事件后为“正在接收模型流”，包含角色、推理、工具调用等协议事件，不依赖公开正文出现。只传 responseStarted 布尔标志，不传推理或工具参数。首次公开正文仍绕过 120ms 节流，防止首事件通知占用发送窗口导致首字延迟；原始流字节不改变，首字计时仍只看公开文本。并行调用任一尚未结束流已开始即可显示接收，最后一个请求结束后退出模型阶段。该更名不改变 model 类别，因此等待占比仍包含整个模型请求期间和流式接收。

占比任务结束后冻结，当前任务汇总保存在 DO KV，刷新仍可显示；新任务替换当前汇总，不逐条附加到历史列表。只有观测覆盖足够才显示比例，观测不足仍如实标识；这不改变先前已发布的统计口径。
