# 联网工具访问边界

2026-09-12：本页记录 HTTP 与研究浏览器的基础防护，不是完整公网发布批准，也不替代部署网络的出口防火墙。

## 请求路径

- `read_url`、`web_research`、HTTP 搜索、Discovery、Skill/MCP URL 导入和 HTTP MCP 请求共用 `publicFetch`。
- URL 只允许不含用户名/密码的 HTTP(S)。IP 地址由 `ipaddr.js` 分类，拒绝回环、私有、链路本地、保留、映射/转换地址及内部主机名；域名白名单按边界匹配。
- DNS 校验发生在连接所用的 lookup 回调里。检查全部返回地址，任一非公网地址都会拒绝；连接使用检查后的地址，不再另做一次可能被替换的解析。
- HTTP 重定向逐次检查，最多 5 次；POST 等带业务数据的请求不自动跳转，不允许 HTTPS 降级。跨来源跳转不转发调用者的授权、Cookie 或 API Key；响应 Cookie 通过独立、短生命周期的标准 Cookie 容器按域名处理。
- HTTP 默认读取上限为解压后 5 MiB，普通 URL 导入为 120,000 字节；读取过程中也检查大小，不只依赖 Content-Length。MCP 连接可达性测试只读取响应头并取消正文，不等待无限 SSE 流。这不是 MCP 协议握手/工具清单验收。
- 命中安全拦截的读取不再转到未受保护的浏览器，也不会被导入接口降级成可保存草稿。

## 浏览器与代理

Chromium 的 HTTPS 保持原生 TLS，经过每个 BrowserContext 独立的本机 HTTP CONNECT 代理。代理只监听回环地址，使用随机临时认证；在创建公网连接前应用同样的 URL/DNS 策略。它也检查 Playwright 路由未再次接收到的跳转，不能只检查首次 `goto`。

浏览器保持 Chromium 沙箱，不再传入 `--no-sandbox`。禁用 service worker、下载及任意 WebSocket；研究浏览器不加载图片、音视频和字体。连接有时间和流量限制；HTTPS 隧道限制的是加密流量，不等同于网页解压后内存限制。需要登录、下载或实时推送的高级浏览器任务仍须单独设计权限和验收。

上游出口来源顺序：

1. 运营者配置的 `TAGENT_BROWSER_PROXY_URL`。
2. `HTTPS_PROXY` / `HTTP_PROXY`。
3. Windows 当前运行用户启用的系统 HTTP 代理。
4. 直连。

`TAGENT_BROWSER_PROXY_URL=direct` 可显式禁用继承。仅支持 HTTP(S) 代理，PAC/SOCKS 不在当前实现范围。系统代理读取只执行固定的本机查询，不执行网页、Skill 或模型提供的命令。此配置只影响研究浏览器，模型 Provider/数据库的网络连接独立配置。

上游代理属于运营者信任的基础设施，可位于本机。用户或网页提供的目标不会获得此例外：转交给上游代理的是已经检查过的公网 IP，不能让它再次解析攻击者控制的域名。代理与浏览器上下文一同销毁；研究抓取每次创建新上下文，状态型交互工具按任务执行实例创建独立会话并在结束时清理。不同任务可以并行，同一会话内的浏览器命令按顺序执行，避免同时导航、刷新、输入互相覆盖。

## 交互引用

- 快照只列出当前主文档视口中最多30个控件；滚动后重新采集新区域。它不是完整 DOM，也不声明已覆盖 iframe、Shadow DOM 或所有网页应用。
- `@eN` 绑定本次观察到的具体 DOM 元素，不再重新按 CSS 查询结果的第 N 项点击，也不再给输入框另建一套编号。同名按钮不去重；更新快照时释放旧句柄，编号不重复使用。页面重新导航、元素被替换、名称/角色/链接/表单目标等观察属性改变时，旧引用拒绝执行并要求重新观察。
- 常规自动化通常应使用 Locator；这里为保留“当时观察到的同一元素”身份使用 ElementHandle，并显式校验属性和释放句柄，避免自动找到另一个同名控件。区别见 [Playwright Handles](https://playwright.dev/docs/handles)。实际动作仍使用 Playwright 的原生点击/填充，不调用页面 DOM `.click()`、不使用 `force`；点击先检查可操作性，等待遮罩或动画后再次核对元素，再执行动作。[可操作性检查](https://playwright.dev/docs/actionability)
- 输入操作返回更新后的快照，不直接回显输入文字；快照不读取输入字段的 value，包括密码字段。这只约束快照输出，不表示工具参数、模型上下文和历史 Trace 已实现全链路敏感信息脱敏。
- 操作已执行但获取新快照失败时，会明确区分这两个状态，要求先观察核对，而不是把它统称“失败”并引导重复提交。
- 引用校验不是网页行为授权，也不构成原子事务。网页可以修改事件处理器；末次检查与实际输入之间仍可能变化。登录、表单提交、采购等高风险行为需要独立的工具权限/审批设计，不因元素引用正确而默认获准。

## 实测证据

- `public-network.test.ts`：编码后的 IPv4、IPv6、混合 DNS 地址、重绑定、域名边界、跨域凭据、重定向、实际响应字节、Cookie 隔离及头部探测。
- `browser-network.test.ts`：绕过 Playwright 页面路由直接请求代理仍拒绝私有目标；上游只接收到已验证的公网 IP。
- `verify-public-network.ts`：启动真实 Chromium 和本机 HTTP/WS 监听器。公网页面使用明确 fixture，私有导航、iframe、fetch、跳转和 WebSocket 验收中监听器收到 0 次请求；正常页面及跳转后的 URL 保持可读。
- `verify-browser-interaction.mts`：真实 Chromium、两个任务上下文、隔离 HTML 页面；覆盖同名按钮、DOM 重排、节点替换、等待中改名、混合元素输入、禁用/只读/遮罩、长页滚动、导航后旧引用、密码字段不进入快照。点击产生真实输入事件；通过工具点击私有地址时，本机监听器收到0次请求。所有任务上下文关闭，不调用模型，不证明真实搜索结果质量。
- 追加 `--live`：实际 GitHub、npm HTTPS 返回有效 JSON；Bing 新闻浏览器返回候选。不是假页面通过的替代证明，不调用模型。
- `verify-server-lifecycle.mjs`：危险 URL 在两套 Skill/MCP 导入接口均被拒绝；正常预览继续满足 `requiresConfirmation=true`、`willWrite=false`、`willExecute=false`，注册表内容不变。

```bash
pnpm --filter @tagent/server... build
pnpm exec vitest run
node scripts/verify-server-lifecycle.mjs
pnpm exec tsx scripts/verify-public-network.ts
pnpm exec tsx scripts/verify-browser-interaction.mts
# 手动联网检查，不接入默认离线测试
pnpm exec tsx scripts/verify-public-network.ts --live
pnpm exec tsx scripts/test-search.ts
```

本机兼容性排查确认：原生 Chromium 使用用户系统代理，直接代取 HTML 则被 Bing 重定向到地区首页。最终采用原生 TLS + 校验公网 IP + 继承可信代理，恢复了新闻候选；没有放宽私有地址策略。

## 剩余门槛

- 完整任务的预算、取消、并发与内存上限；进程/操作系统级出口隔离；长期稳定性和多平台验收。
- 任务级浏览器会话与定向引用已通过隔离验收；长时间页面脚本挂起、完整任务取消、全链路敏感信息脱敏、跨 run 大厅状态、iframe/Shadow DOM 及高风险交互审批仍待完成。
- 私有 HTTP MCP 暂不开放；未来需要运营者显式授予指定服务访问权，不能让任意导入 URL 获得内网权限。
- 来源身份、事实支持关系和最终报告质量仍需独立验收。候选搜索成功不代表内容真实、近期或足以交付。

设计依据：[OWASP SSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)、[ipaddr.js](https://github.com/whitequark/ipaddr.js)、[Playwright BrowserContext](https://playwright.dev/docs/api/class-browsercontext)。应用层校验与网络层隔离应共同使用，不能互相替代。
