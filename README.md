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
- 浏览器每 5 秒查询状态；当前只展示最近一个任务，不是完整 DSH Web UI，不提供 token 流和审批 UI。需审批动作默认拒绝；用户问题默认取消。
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

Worker 通过 `ctx.access` 确认平台已验证请求，再读取邮箱身份；不相信请求自行提供的邮箱头。所有页面和 API 均需 Access；POST 还必须来自同源。当前无 Static Assets 或 Service Binding 中转；如未来增加，注意官方文档中 `ctx.access` 不传播的限制，不能直接沿用此判断。HTTP Bridge 无公开预览端口。页面使用 textContent，不渲染模型 HTML。

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
