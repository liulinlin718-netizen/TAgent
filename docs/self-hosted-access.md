# 单实例访问保护与本地验收

本页说明已经实现的访问边界，不代表完整上线验收通过。适用范围是一个可信拥有者管理的自托管实例，不提供独立用户、角色、租户隔离或共享权限。所有持有访问码的人均有实例管理权限。

## 本机开发

后端默认监听 `127.0.0.1:3001`，未设置访问码时本机可直接使用。允许的浏览器来源默认是 `http://localhost:3000` 与 `http://127.0.0.1:3000`，其他来源即使知道端口也不能通过浏览器跨站调用接口。CLI 请求仍可直接使用 JSON 请求。

修改前端开发端口时，必须在后端 `TAGENT_WEB_ORIGINS` 中列出该完整来源。不要用 `*`，不要把第三方站点加入列表。Host 校验和 Origin 校验不是访问码的替代品；不得将无认证的本机开发模式通过代理暴露到公网。

## 配置访问码

部署配置示例（真实访问码必须独立生成，不提交到版本库）：

```dotenv
NODE_ENV=production
TAGENT_HOST=127.0.0.1
PORT=3001
TAGENT_ACCESS_TOKEN=<independent-random-secret-at-least-32-characters>
TAGENT_PUBLIC_ORIGIN=https://office.example.com
TAGENT_WEB_ORIGINS=https://office.example.com
```

可在部署机器用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` 生成随机访问码。不要复用 DeepSeek、Anthropic 或其他模型密钥。

生产模式、非 loopback 监听或非本机前端来源要求同时设置访问码和 HTTPS 公共来源；缺少配置时启动失败。公共来源必须是完整 origin，不含路径、查询参数、尾斜杠或凭据。

启动后，用户在登录页输入访问码。登录状态使用随机、不透明的 HttpOnly Cookie；不写入 localStorage/sessionStorage，不通过 URL 传递。生产 Cookie 使用 `Secure`、`SameSite=Strict`、`__Host-` 前缀和根路径。会话最长 8 小时，退出使旧 Cookie 失效，服务重启会使全部登录失效。更换访问码后重启服务，原有工作区数据不会因此删除。

登录尝试每实例滚动60秒最多10次，包含格式错误请求，在读取正文前限制。不信任 `X-Forwarded-For`、`Forwarded`、Cookie 或查询参数划分新额度。所有 API 请求体仍限制为2 MiB。

## 请求与连接限制

2026-09-14：按单实例拥有者划分固定数量的独立通道，不保存调用者提供的IP/Token作为限流索引。每个通道统计实际前60秒已接收请求；被拒绝请求不延长恢复时间，时钟回退不补发额度。

| 通道 | 默认每60秒 | 说明 |
| --- | --- | --- |
| 登录 | 10 | 独立于已登录操作 |
| 公开状态和未授权请求 | 120 | 不消耗已授权API额度 |
| 一般读取 | 600 | 工作区、历史、管理列表等 |
| 一般写入 | 120 | 创建/修改/删除与未知写路由 |
| 联网或模型任务入口 | 30 | 任务、搜索/导入、连接测试、AI草稿、实跑评测、Fork提交；Discovery健康探测也计入 |
| 停止/审批/退出/结果补保存 | 120 | 独立额度，仍须原有鉴权、归属和审批检查 |
| WebSocket握手 | 30 | 另有16个活跃连接上限 |

HTTP超限返回429、中文原因、`Retry-After`和`retryAfterSeconds`，不自动重试；任务同时返回`accepted=false`，不进入处理器、写消息或调用模型。大上传在连接关闭时可能中断，不能保证恶意客户端一定读到提示。CORS预检仍由原中间件处理，不计入业务额度。

搜索或历史刷屏不会占用停止/审批通道。已开始SSE的事件不逐条扣额度，也不会因后续请求限流而终止；原任务超时、取消、并发限制保留。新对话准备失败时还未调用模型，页面保留草稿并提示核对会话列表；响应丢失不能据此断言空会话是否创建。草稿仍只保留在当前页面，不保证刷新后恢复。

部署者可设置 `TAGENT_API_READ_PER_MINUTE=600`、`TAGENT_API_WRITE_PER_MINUTE=120`、`TAGENT_API_EXTERNAL_PER_MINUTE=30`。仅接受1至10000整数，0或非法值使启动失败，不静默关闭保护。普通用户无需配置；提高限额不会提高工具权限、任务并发或模型预算。

WebSocket原生接收器限制16 KiB完整消息，分片合并后同样受限，只接受文本控制消息。每连接每分钟120条、所有连接合计600条，非法JSON也计数；超限关闭，不批准消息中的操作。重连仍受握手额度约束，重复`join`清理旧订阅和空池。连接数限制返回429，消息频率用关闭码1008、二进制1003、超大消息1009；当前升级适配器不传递完整HTTP错误正文/Retry-After，不能依赖握手错误中的详细JSON。

以上是进程内保护：重启后额度重置，多实例不共享计数；不是分布式锁、完整费用硬上限、并发上传总内存或公网DDoS防护。反向代理连接限制、TLS、目标环境压力与安全验收仍需完成，不据此宣称公开部署已经安全。

## 同源 HTTPS 部署

生产前端默认请求同源 `/api/`。构建时不要将 `NEXT_PUBLIC_API_URL` 指向开发机的 localhost；必要时指定同站点的 HTTPS API 地址。推荐由反向代理统一提供前端、API 与 WebSocket。TLS 证书、域名与公网端到端部署仍需在目标环境验收。

```nginx
server {
    listen 443 ssl;
    server_name office.example.com;
    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_buffering off;
        proxy_read_timeout 600s;
    }
    location /ws {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 600s;
    }
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
    }
}
```

保持前后端原始端口仅监听本机/私有网络，不直接向公网发布 3000/3001。生产前端启动示例：`pnpm --filter @tagent/web exec next start --hostname 127.0.0.1 --port 3000`。后端入口为 `node packages/tagent-server/dist/index.js`，构建与数据库配置见 README。

## 接口与安全范围

- `GET /api/auth/session`：只返回是否需要登录、当前是否已登录。
- `POST /api/auth/login`：接收 JSON `token`，验证成功后设置 Cookie，不返回访问码。
- `POST /api/auth/logout`：撤销当前会话。
- 未登录时 `/api/health` 仅返回服务存活及受保护状态，不暴露模型/存储配置。
- 其余 API（包括模型运行、Benchmark、配置保存、导出、审批）与 WebSocket 握手必须通过授权。
- 浏览器写请求通过明确 Origin 和预检保护；客户端统一附带 `X-Tagent-Request: 1`。API 客户端也可用 `Authorization: Bearer <instance-access-code>`，但不要写在 URL 或持久化到前端存储。
- WebSocket 在消息处理/广播前重新检查登录状态；退出或过期后的旧连接不再接收新数据或批准操作。

授权在 HTTP 请求进入时检查；长任务取消、SSE断连收尾与审批超时已有单实例隔离证据，详见 [验收清单](./release-readiness.md)，不是全部异常组合验收。HTTP/浏览器 DNS 与重定向防护见 [联网工具边界](./public-network-boundary.md)。完整敏感信息脱敏、多用户权限、跨实例并发/费用限制及 OS 出口隔离仍未完成。不要把此页作为公开上线批准。

## 可重复验收

### 本机生产 HTTPS 验收（2026-09-15）

`node scripts/verify-https-deployment.mjs --openssl <本机已有的OpenSSL绝对路径>` 使用真实生产前后端、一次性自签证书和本机测试代理，验证 Secure/HttpOnly/Strict/__Host- Cookie、Host/Origin、WSS握手/退出撤销、SSE唯一终态及历史回查。证书不装入系统信任库：普通客户端必须拒绝，测试客户端仅信任该证书。脚本不下载OpenSSL、不自动安装证书，结束后清理自己的临时数据与进程。运行前需完成下方构建。

追加 `--serve` 可进行浏览器验收，输出专用URL、访问码、证书路径、停止URL和Playwright配置。浏览器用 `--browser=chrome --config=<输出的配置路径>` 复用已安装Chrome；配置仅针对该一次性证书的SPKI，不全局忽略证书错误。手动登录后运行 `scripts/verify-https-deployment-browser.js`。已检查1440/390/320布局、三栏不遮挡、中文/emoji历史、管理页跳转和退出后401。无页面异常或外部页面请求；Next预加载CSS有未使用警告，未判为功能失败。脚本内代理不是生产反向代理实现，也不能替代真实域名、证书签发、Nginx配置或目标主机验收。

同时修复生产HTML仍预连接 `http://localhost:3001`，以及 `TAGENT_ENV_FILE=''` 仍回退读取默认`.env`的问题。现在该变量未设置时读取默认文件，非空时读取指定文件，显式空值时完全禁用文件加载；不会改写`.env`。HTTPS脚本还显式清空模型密钥，并在提交任务前断言模型未配置。

费用更正：修复隔离前的3次SSE超时检查误加载了默认模型配置，可能产生真实请求，未收到用量回执，不能声称费用为0。这些进程已经退出且未重试真实调用；是否计费须以供应商记录为准。修复后通过的HTTPS和浏览器验收均确认模型未配置，模型调用为0。

```bash
pnpm --filter @tagent/server... build
pnpm --filter @tagent/web build
node scripts/verify-access-control.mjs
node scripts/verify-server-lifecycle.mjs
node scripts/verify-request-limits.mjs
```

`verify-access-control.mjs` 启动实际临时后端，禁用模型密钥，验证 HTTP 与真实 WebSocket 的授权/来源/退出撤销。数据位于独立临时目录，结束后删除，不操作用户工作区。

请求保护新增39项后端与2项前端草稿回归。`verify-request-limits.mjs` 用独立真实后端和降低的测试额度，验证限流前零任务写入、独立通道、伪造请求头/路径不补额度，以及真实WebSocket握手、16连接、消息频率、完整/分片超限和二进制拒绝；模型/外网调用为0，已加入 `pnpm check`。原生命周期/模型异常压力脚本显式使用100次外部入口额度，以继续覆盖数十个错误场景，不拿429代替原断言。

浏览器配合 `--serve`、独立API重定向和 `verify-request-limits-browser.js`，验证新旧会话草稿保留、无假回复、无自动重试，前后持久工作区一致；1440/390/320及暗色截图检查通过。控制台400/404/429来自预设输入，没有页面异常或用户API请求。完整门槛为88文件1146项回归、25项脚本自检、四包类型/lint与生产构建，不代表真实办公质量或公网部署验收。

追加 `--ui` 会同时启动生产前端与仅监听本机的测试代理，打印临时 URL 和专用测试访问码；输入 `stop` 关闭测试实例。该测试访问码只用于此隔离进程，严禁复制为部署访问码。

本轮浏览器已验证错误码提示、登录、刷新、四个管理页面、HttpOnly 不暴露给页面脚本、退出后 401、对话 SSE 的缺 Key 收尾、凭据丢失后回登录；登录页在 1280×720 与 390×844 截图检查无溢出。该浏览器流程没有验证真实模型或公网 TLS。

实现依据：[Hono Cookie helper](https://hono.dev/docs/helpers/cookie)、[CORS middleware](https://hono.dev/docs/middleware/builtin/cors) 与 [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)。认证边界由后端执行，前端登录页仅提供交互。

分层请求保护参考 [OWASP DoS防护](https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html) 中尽早进行低成本验证和保留降级能力的原则，不是对本实现的安全认证。
