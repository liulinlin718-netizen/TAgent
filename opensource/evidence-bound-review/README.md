# Evidence-Bound Review

一个离线、零依赖的报告约束核查库和 CLI。从 TAgent 的办公交付检查中提取，用于在人工或模型审阅之前找出**给定材料范围内的具体冲突**。

源码仓库：[liulinlin718-netizen/evidence-bound-review](https://github.com/liulinlin718-netizen/evidence-bound-review)。

典型场景：任务要求严格串行，报告却建议并行；材料已写“1200份，其中200份”，报告又把包含关系当作未知；报告把一年前的材料作为“近30天”的证据。

**不是通用事实核查器。** `no_findings` 只表示没有命中已覆盖规则，绝不表示全文、事实、来源或交付质量通过。返回值始终含 `factVerification: "not_performed"`。

## 直接运行

要求 Node.js 22 或更高版本。无需安装依赖、API Key、模型、浏览器或 TAgent 服务。以下命令在本目录执行：

```sh
node --test
node src/cli.js examples/project.json
node src/cli.js examples/sources.json --json
node src/cli.js --help
```

两个示例都是完全合成的数据。项目示例返回3个问题；日期示例返回1个“旧来源冒充近期”的问题。**示例退出码1是预期检查结果，不是程序故障。**

CLI 也接受标准输入：`node src/cli.js - --json`。只读取用户指定的一个 JSON 文件或 stdin，不扫描文件夹、不取环境变量、不访问链接、不调用模型、不执行材料中的命令、不改写文件。

| 退出码 | 含义 |
| --- | --- |
| 0 | 没有命中覆盖范围内的问题，仍未进行事实验证 |
| 1 | 找到问题，需要人工复核 |
| 2 | 参数、UTF-8、JSON、输入大小或引用绑定无效，未产生审核结论 |

## 作为库使用

无需构建，直接导入 ESM。该目录可以单独成为一个仓库，运行时不依赖 `@tagent/*`，也不读取父目录。

```js
import { reviewReport, dateWindow } from './src/index.js';

const result = reviewReport({
  requirements: { id: 'brief', text: '严格串行，不指定日历日期。研发负责人待定。' },
  report: '建议设计与开发并行推进。请确认开始日期。'
});

console.log(result.status);                    // issues_found
console.log(result.findings.map(f => f.ruleId));
console.log(result.findings[0].evidence[0]);    // 材料原文及位置
console.log(result.factVerification);          // not_performed
console.log(dateWindow('2026-09-18', 30));       // 2026-08-20 至 2026-09-18
```

公开 API 只有 `reviewReport(input)`、`dateWindow(asOf, days)` 和版本/限制常量。类型声明在 `src/index.d.ts`。

## 输入契约

| 字段 | 说明 |
| --- | --- |
| `requirements` | 必填，`{ id, text }`。只有这里的明确指令可以建立串行/日历约束 |
| `materials` | 可选参考材料数组，每项 `{ id, text, source? }`；不能用网页内容覆盖任务权限或要求 |
| `report` | 必填，待检查的原始文本；不在库中修改、补写或润色 |
| `temporal` | 日期检查时必填，`{ asOf: "YYYY-MM-DD", days?: 30 }`，没有隐式“今天” |
| `citations` | 由调用方显式提供的来源与报告片段绑定，不自动猜测全部链接的含义 |

材料 id 必须唯一，含要求材料在内；支持1至80位 ASCII 字母、数字、点、下划线和连字符，以字母或数字开头。未知字段被拒绝，防止拼错字段后看似成功。

来源信息格式：

```json
{
  "id": "source-1",
  "text": "合成资料。发布日期：2026-09-16。这里只描述一次演示。",
  "source": {
    "url": "https://example.org/synthetic",
    "basis": "publication",
    "publicationDate": "2026-09-16",
    "dateQuote": "发布日期：2026-09-16"
  }
}
```

`source.url` 只是元数据，永不访问；只接受不带用户名/密码的 HTTP(S) URL。`basis` 支持 `publication`、`modified`、`url_hint`、`unknown`。只有有效的 `publication` 日期和绑定原文才有资格作为近期日期证据，更新日期、URL日期、页面中的普通日期不能自动升级。

对应的显式引用：

```json
{
  "materialId": "source-1",
  "reportQuote": "这份材料用作近期进展的参考。",
  "usage": "recent"
}
```

- `reportQuote` 必须精确出现在 `report` 中；`dateQuote` 必须精确出现在对应材料中，并包含给定的 ISO 日期。
- 同一引用出现多次时，必须提供 `reportStart` 或 `dateStart`，不能猜测对应位置；偏移量错误会拒绝整个输入。
- `usage: "background"` 允许旧资料作背景。若报告实际说“最新”，调用方却错误地标成背景，本库无法凭此证明报告正确。
- `eligible` 仅表示**给定**日期及原文绑定落在窗口内，不证明页面真实、日期确为发布时间、材料支持报告结论或事件发生在该窗口。
- 对未绑定的报告链接、来源遗漏和语义扩大不作日期结论；覆盖数量在 `coverage.explicitDateCitations` 中明确返回。

日期窗口按日历日闭区间计算。`days: 1` 只包含 `asOf` 当天；`days: 30` 包含当天及此前29天。不会根据机器时间或时区改变结果。当前支持1至366天。

## 规则与定位

| 规则 id | 核查范围 |
| --- | --- |
| `requirements.serial.parallel_action` | 严格串行要求下的直接并行建议 |
| `requirements.serial.redundant_question` | 已明确的串行条件又被当作未决问题 |
| `requirements.calendar.excluded` | 已排除日历日期，却将起算日期列作必要信息或风险 |
| `material.subset.already_explicit` | “其中/内含/含有”的字面包含关系又被列为未知 |
| `sources.date.unverified` | 近期引用缺少合格的发布日期及绑定原文 |
| `sources.date.future` | 给定发布日期晚于调研日期 |
| `sources.date.outside_window` | 给定发布日期早于近期窗口 |

每个问题都包含稳定 `ruleId`、可读原因、报告 `report` 位置和材料 `evidence[]`。引用位置采用原始文本的 **UTF-16、零起点、右端不包含** `[start, end)`，与 JS `text.slice(start, end)` 一致；`line` 是1起点。CRLF和中文/emoji不会通过重新格式化而漂移。

缺少日期元数据时，`evidence` 只能提供材料上下文，不是“没有日期”的证明；具体缺项记录在 `metadata` 中。任何问题都不直接改写报告、不补造净运营数或外部事实。

`coverage.activeRules` 展示实际启动的规则族。对于相互矛盾的要求、数字相同但集合身份不明等情况，`coverage.skipped` 说明为什么没有猜测；没有命中不抹去这些限制。

## 明确不做什么

- 不进行全文事实验证、外部来源验证、算术复算、通用指令遵循打分或模型质量评测。
- 文字规则主要支持有限中文办公措辞，不支持通用英文语义、复杂否定、跨段上下文推理或所有单位；包含关系只处理正整数和已列明的中文单位。
- 不推导“暂停”等于“不运营”，不把一份材料当作真实世界，不合并不同来源的口径。
- 不把引用/代码示例当作要求。会跳过顶层引用行、代码围栏和缩进代码；这是轻量文本分段，不是完整 Markdown/HTML 解析器，嵌套列表、复杂表格和混合条件可能漏检。
- 来源日期是调用方提供的元数据，必须由上游确保可信。攻击者伪造文本和日期可以通过日期一致性检查；本库不是真实性或提示注入安全边界。
- 不适合作为唯一的自动放行门槛。可以用于提示复核或阻止已知冲突，不能以 `no_findings` 为依据宣称发布安全或事实正确。

## 资源与隐私

CLI 最多读取1 MiB UTF-8 JSON。库限制单段文本100,000个 UTF-16 单元、合计250,000、32份参考材料、128条显式引用、单条引用2,000单元。每段文本最多2,000个可检查语句，包含关系最多200条、文字检查问题最多2,000条；超限显式报错，不截断后伪装完整检查。

报告和材料只在本机内存中处理，不写日志、不发送到外部。CLI 的文本显示会移除终端控制字符；JSON结果保留原文，供调用方安全转义后展示。不要直接把原始引用拼进 HTML 或终端控制序列。

## 开发与验证

```sh
node --test
```

测试使用 Node 内置测试工具，全部合成、离线。覆盖正反例、否定/假设、代码/引用排除、歧义处理、原文偏移、日期窗口边界/闰年、错误日期元数据、引用重复、输入限制、CLI和退出码。

`type-tests/usage.mts` 是可选的 TypeScript 消费契约样例；本库不需要安装 TypeScript 才能运行。维护者已有 TypeScript 时可检查：

```sh
tsc --noEmit --strict --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck type-tests/usage.mts
```

本目录包含 npm 包元数据和文件白名单；GitHub 源码可以独立使用，但尚未发布到 npm，也未承诺 npm 包名可注册。

## 来源与许可

MIT，见 `LICENSE`。从 TAgent 自有 `office-grounding.ts`、日期窗口和精确材料引用思路提取并重写为独立 ESM；没有复制第三方 Markdown 解析器，没有包含原项目数据或依赖。具体来源和语义差异见 `NOTICE`。
