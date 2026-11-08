# 1.0.2 方案审阅证据

> 归档日期：2026-11-08。对应代码基线：`866d76e75b083810aeb32fe370487113083f98ef`。

本目录配合 [修改意见](../../1.0.2优化方案-修改意见.md) 使用。保存审阅时的方案、已有实测摘要和本次对话中的离线诊断，避免源方案后续修改或 `.validation` 被清理后丢失依据。

## 文件与来源

| 文件 | 来源与用途 |
|---|---|
| [迭代方案-审阅时快照.txt](迭代方案-审阅时快照.txt) | `docs/迭代-1.0.2.md` 的逐字副本。纯文本保存，内部相对链接按原文件目录解析 |
| [搜索语义实测-记录摘录.md](搜索语义实测-记录摘录.md) | `docs/验证记录.md` 第 120 行起的原文摘录；是先前真实接口验证的记录，不是本次重新测得的数据 |
| [关键词实测-第二轮结果.json](关键词实测-第二轮结果.json) | `.validation/probes/search-keywords-2-result.json` 的逐字副本；15 次关键词搜索，`inventory_checks=[]`，没有第二轮完整库存核验 |
| [离线诊断-首次结果.json](离线诊断-首次结果.json) | 本次对话上一轮执行的 `.validation/search-analysis/results.json`；三个诊断通过时的输出 |
| [scan-analysis.test.ts](scan-analysis.test.ts) | 原 `.validation/search-analysis/scan-analysis.test.ts` 的归档可执行副本；仅调整导入相对路径及结果输出路径，增加输出目录创建 |
| [vitest.config.mts](vitest.config.mts) | 仅运行上述三项离线诊断的配置，不修改项目默认测试集合 |

原始只读探测脚本仍可在工作区 `.validation/probes/search_semantics.py`、`.validation/probes/search_keywords_2.py` 查看。本次没有执行它们。首轮脚本会写出的 `search-semantics-result.json` 在此次文件枚举中未发现，因此不声称已复核首轮原始完整响应；首轮数据依据验证记录与脚本检查方式。

## 离线复现

在项目根目录运行，使用项目已安装依赖：

```powershell
node node_modules/vitest/vitest.mjs run --config docs/审阅证据/1.0.2/vitest.config.mts
```

输出写入 `.validation/search-review-replay.json`，不会覆盖归档的首次结果。测试使用虚拟平台、内存数据库与虚拟身份，不连接真实平台。

测试确认的是旧实现的行为：

1. 400 个高度重叠的账号，冷启动 20 次搜索、400 次库存、400 次详情；立即重搜仍有 20 次搜索，库存和详情均为 0。
2. 注入“格洛克”返回零的契约差异，实际有 1 个匹配账号，却返回 0 且 `incomplete=false`。
3. 候选阶段停止后继续，从“蝴蝶刀，第 1 页”重新开始。

测试夹具会提高请求额度以缩短运行时间，墙钟耗时不能用于推断真实平台速度。首次非空事件中的具体条数受定时合并影响，11 不是固定批量大小。业务修复后，第 2、3 项旧行为断言应失败；需把对应场景改为新行为的正式回归测试，不能为了保持这份诊断通过而保留缺陷。

## SHA-256

| 文件 | SHA-256 |
|---|---|
| 迭代方案-审阅时快照.txt | `8041e4670b3387b14412e00a0f716e40a1256a0b616e08bd2758fce064ab0b7a` |
| 离线诊断-首次结果.json | `8aa729b209d96171d1ecc8b1a7e8f601b5e1242a79bcf0ec425273068b53e976` |
| 关键词实测-第二轮结果.json | `5bf1b70e15cde277a9911d9e53d0f26203917ec633148d388339d16d6718cbc5` |

当前源码的函数及行号引用见修改意见末尾。代码升级后可用 `git show 866d76e75b083810aeb32fe370487113083f98ef:src/main/services/scan-service.ts` 等命令读取审阅基线。
