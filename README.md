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
7. **设置 AI Gateway**：创建同账户 Gateway，开启认证；充值 Unified Billing，或在 Gateway 配置支持的服务商 BYOK（AI Binding 仅使用 default alias）。在 Gateway 创建名称 `dsh` 的动态路由，选择支持 **OpenAI Chat Completions、SSE 流和工具调用** 的模型。默认配置 `AI_GATEWAY_ID=default`、`AI_MODEL=dynamic/dsh`；若改名，在仓库的 Wrangler vars 中修改后部署。也可将 AI_MODEL 改为模型目录中的精确 `author/model` ID。当前不接受 `@cf/` 原生格式，避免不同响应协议被误当 Chat Completions。模型上下文至少 65536、输出上限至少 8192；调整路由时同步修改容器模型声明，并先保存休眠。
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
- `/data/dsh-home` 放 DSH 配置、会话；`/data/workspace` 放工作文件；`/data/state.json` 记录 Bridge 的最近任务与 Session。
- 浏览器每 5 秒查询状态；当前只展示最近一个任务，不是完整 DSH Web UI，不提供 token 流和审批 UI。需审批动作默认拒绝；用户问题默认取消。
- `/api/tasks` 接受调用者生成的 UUID；DO 先记录请求意图。同一 ID 不会重新执行。网络超时不是回滚，不能直接换 ID 重试。
- DSH 官方 SDK 没有逐 Prompt cancel；关闭页面不会停止任务。不要启动无限任务或无人值守高风险操作。

## 快照、长期备份、升级

每分钟 Lifecycle job 检查状态。任务不忙且距最近一次提交超过 10 分钟，自动：

1. 拒收并发新任务（DO 串行控制操作）。
2. 确认 DSH 空闲并已优雅关闭；SDK 在每次任务结束后关闭 runtime。
3. `DirectoryBackup` 备份整个 `/data` 到 R2，保存返回记录。
4. `snapshotContainer()` 保存可写根文件系统，把快照 ID、备份记录、镜像引用和时间写入 DO。
5. 成功后 `destroy()`，下次任务从快照启动。

手动“保存并休眠”执行同一流程。保存失败保持实例运行并在后台重试；inactivity timeout 是故障兜底，**不保证异常退出前一定保存成功**。

**重要限制：当前不是任务执行中的连续检查点。** 异常退出会丢失最近一次成功保存后的文件与会话变化。长期任务不能依靠本模板自动续跑。DSH `resumeSession()` 修复事件日志并恢复对话，但不恢复进程、Shell、浏览器或外部副作用。

原生快照不保存内存、进程和挂载目录；30 天未恢复会过期，绑定原镜像版本。恢复错误不会静默启动空工作区。容器已停止时可点“从 R2 恢复”，在当前镜像恢复最近 `/data` 备份并创建新快照；下一任务再验证 DSH 会话兼容性。

升级步骤：旧版本先“保存并休眠” -> 部署新镜像 -> 在容器停止状态点“从 R2 恢复” -> 验证会话 -> 再保存。否则旧快照仍是旧版镜像。Worker 部署不会自动替换正在运行的容器。版本迁移并非天然可回滚；升级前另行保留 R2 备份。

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
