# Evidence-Bound Review

Evidence-Bound Review 是一个离线、零依赖的办公报告约束核查库和 CLI。它只根据调用方给出的任务要求、材料和引用关系，定位报告中的明确冲突，并为每个问题返回原文位置与证据。

典型用途：

- 任务明确要求串行，报告却建议并行推进。
- 材料已经说明包含关系，报告又将其列为未知。
- 用户排除了日历日期，报告仍把开始日期作为必要条件。
- 报告把窗口外或缺少发布日期依据的材料描述成“近期来源”。

它不是通用事实核查器。`no_findings` 只表示没有命中当前规则，返回值始终包含 `factVerification: "not_performed"`，不会把规则未命中包装成事实正确或质量通过。

## 快速开始

要求 Node.js 22 或更高版本。无需安装依赖、配置模型或启动服务。

```sh
git clone https://github.com/liulinlin718-netizen/evidence-bound-review.git
cd evidence-bound-review

node src/cli.js examples/project.json
node src/cli.js examples/sources.json --json
node src/cli.js --help
```

CLI 也接受标准输入：

```sh
node src/cli.js - --json
```

程序只读取指定的 JSON 文件或 stdin，不扫描目录、不访问来源 URL、不调用模型、不执行材料中的命令，也不改写报告。

## 作为库使用

```js
import { reviewReport, dateWindow } from './src/index.js';

const result = reviewReport({
  requirements: {
    id: 'brief',
    text: '严格串行，不指定日历日期。研发负责人待定。',
  },
  report: '建议设计与开发并行推进。请确认开始日期。',
});

console.log(result.status);                    // issues_found
console.log(result.findings.map(item => item.ruleId));
console.log(result.findings[0].evidence[0]);
console.log(result.factVerification);          // not_performed
console.log(dateWindow('2026-09-18', 30));
```

公开 API：

| API | 作用 |
| --- | --- |
| `reviewReport(input)` | 核查报告与给定要求、材料和日期引用之间的明确冲突。 |
| `dateWindow(asOf, days?)` | 计算包含截止日的日历日闭区间。 |
| `VERSION` / `RULESET` / `LIMITS` | 暴露版本化规则与输入限制。 |

ESM 导出和 TypeScript 类型声明位于 `src/index.js` 与 `src/index.d.ts`。

## 输入结构

```json
{
  "requirements": {
    "id": "brief",
    "text": "严格串行，不指定日历日期。"
  },
  "materials": [
    {
      "id": "source-1",
      "text": "发布日期：2026-09-16。合成资料。",
      "source": {
        "url": "https://example.org/synthetic",
        "basis": "publication",
        "publicationDate": "2026-09-16",
        "dateQuote": "发布日期：2026-09-16"
      }
    }
  ],
  "report": "这份材料用作近期进展参考。",
  "temporal": {
    "asOf": "2026-09-18",
    "days": 30
  },
  "citations": [
    {
      "materialId": "source-1",
      "reportQuote": "这份材料用作近期进展参考。",
      "usage": "recent"
    }
  ]
}
```

字段含义：

| 字段 | 说明 |
| --- | --- |
| `requirements` | 必填。只有这里的明确指令能建立串行、日历等任务约束。 |
| `materials` | 可选参考材料；材料不能覆盖任务权限或要求。 |
| `report` | 必填待核查文本；库不会修改或润色它。 |
| `temporal` | 日期核查参数；必须显式提供 `asOf`，不读取机器“今天”。 |
| `citations` | 调用方声明的报告片段与材料绑定，不自动猜测链接用途。 |

材料 ID 必须唯一。未知字段、无效日期、重复且未消歧的引用、错误偏移和不匹配原文会被拒绝，避免输入错误被误判为核查通过。

## 日期与引用

`source.url` 只作为元数据，程序永不访问。近期日期只有在以下条件同时满足时才可用：

- `basis` 为 `publication`
- `publicationDate` 是有效 ISO 日期
- `dateQuote` 精确存在于材料正文并包含该日期
- `reportQuote` 精确存在于报告
- 引用显式声明 `usage: "recent"`

更新日期、URL 中的日期和正文里的普通日期不会自动升级为发布日期。窗口外来源可以用 `usage: "background"` 表示背景材料，但这仍不证明材料真实或支持报告结论。

文本位置采用 JavaScript 原始字符串的 UTF-16、零起点、右端不包含区间 `[start, end)`，可直接用于 `text.slice(start, end)`。

## 规则

| 规则 ID | 核查内容 |
| --- | --- |
| `requirements.serial.parallel_action` | 严格串行要求下出现直接并行建议。 |
| `requirements.serial.redundant_question` | 已明确的串行条件又被当成未决问题。 |
| `requirements.calendar.excluded` | 已排除日历日期，却把具体起算日期列为必要条件或风险。 |
| `material.subset.already_explicit` | 已明确的“其中/内含/含有”关系又被列为未知。 |
| `sources.date.unverified` | 近期引用缺少合格发布日期或原文绑定。 |
| `sources.date.future` | 发布日期晚于调研截止日。 |
| `sources.date.outside_window` | 发布日期早于近期窗口。 |

每个 finding 包含稳定规则 ID、问题原因、报告位置和材料证据。`coverage` 会列出实际启用的规则和因歧义而跳过的检查。

## CLI 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 未命中已覆盖规则，仍未进行通用事实验证。 |
| `1` | 找到问题，需要人工复核。 |
| `2` | 参数、UTF-8、JSON、输入大小或引用绑定无效。 |

## 适用边界

- 不访问外部来源，不验证网页真实性或发布日期真伪。
- 不做全文事实验证、算术复算、通用指令遵循评分或模型评测。
- 规则主要覆盖有限中文办公措辞，不承担完整自然语言推理。
- 不推导不同材料中的集合身份、统计口径或现实因果关系。
- 不应作为唯一自动放行门槛；适合提示人工复核或拦截已知冲突。
- 调用方必须安全转义返回原文，不能直接拼接为可信 HTML。

默认限制包括单段文本 100,000 个 UTF-16 单元、合计 250,000、32 份材料和 128 条引用。超限会显式报错，不截断后声称完成核查。

## 测试

```sh
node --test
```

测试全部使用合成、本地数据。

## 许可

MIT。该项目从 TAgent 的材料约束、日期窗口和精确引用机制中提取，并重写为独立 ESM。来源说明见 [NOTICE](./NOTICE)。
