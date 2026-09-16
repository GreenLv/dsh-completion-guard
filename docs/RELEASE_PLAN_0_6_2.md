# 0.6.2 发版计划 / Release plan

更新：2026-09-16。目标包：`dsh-completion-guard@0.6.2`；拟用标签：`v0.6.2`。开发基线：`d11009d8f755ecee7d288cff18250c7b372cfd2a`。候选尚未提交或冻结；上述基线不是发布提交。

This plan advances the reviewed implementation toward release. The candidate is uncommitted and no release artifact has been frozen. The development baseline above is not the release commit.

## 当前证据 / Current evidence

- D062-01–03 的已报告代码缺陷已修复，checkpoint 来源与冲突字段经真实工具入口验证。D062-04 有界函数级对照已补齐，详见 [跨端结果合同](CROSS_END_RESULT_CONTRACT.md)。
- 2026-09-16 Codex/macOS、Node 25.1.0、Python 3.12.2：完整 Vitest 为 70 文件通过、1092 项通过、1 项跳过。单独运行 `host-target-preflight` 为 46 项通过。DSH 先前报告的 8 项失败在该环境未复现；这不证明其原因，也不代替 Node 22/24 或 Windows 验证。
- The reported implementation defects are repaired. The full local Vitest run passed in the environment above. The earlier eight DSH failures were not reproduced here; their cause remains unconfirmed. D062-04 now has bounded lifecycle recordings; native acceptance remains separate.

## 顺序与出口 / Sequence and exit criteria

| 阶段 / Stage | 执行与验收 / Required result | 当前状态 / Status |
| --- | --- | --- |
| 1. 跨端补证 / Cross-end evidence | 同一混合结果分别进入 DSH 与 Codex 完整验证路径；隔离合成会话通过 Codex 自有入口建立可验证账本，覆盖 stop、纠正、pending、wait 与用户可见纠正。不得读取用户真实任务账本或伪造通过。 / Exercise equivalent mixed results and valid isolated-ledger lifecycle cases on both products. | 有界函数级对照通过 / Bounded function-level comparison passed |
| 2. 文档及源码冻结 / Source freeze | 冻结版本、双语文档、包清单、manifest、dist；执行完整本地矩阵、两模式录制检查、文档审计与带文档哈希的 reader review。以确切 Git 提交作为候选身份。 / Freeze all shipped bytes and bind passing checks and reader review to the candidate. | 准备中 / Preparing |
| 3. 候选 CI / Candidate CI | 提交并推送最终候选，确认同一提交的 Ubuntu/macOS/Windows × Node 22/24 六通道与 static 合同全部通过。 / Verify all six portability lanes and static contracts on the exact candidate. | 未执行 / Not run |
| 4. 单一制品 / One artifact | 使用 CI static 阶段已有的 canonical pack 与托管制品，回读 tgz、SHA256SUMS.txt、release-artifact.json、嵌入 gitHead、文件清单。若不采用 CI 制品，另明确指定唯一冻结来源，不能混用或在主机重打包。 / Select and verify one canonical artifact set; never repack per host. | 未冻结 / Not frozen |
| 5. 原生验收 / Native acceptance | 同一 tgz 的 Windows/macOS 安装、严格二次 no-op、包字节对齐、host-lock 回读、Web/Headless 生命周期、cleanup；另完成开发计划 T06 的 Windows 真实句柄部分删除和 macOS 原生结果检查。 / Run exact-artifact host acceptance and the additional T06 scenarios. | 未执行 / Not run |
| 6. 发布前核对 / Publication readiness | 汇总 candidate-closure、reader review、CI、原生 annex、制品身份、双语 release notes、精确标题及发布动作；检查标签与 npm 版本空缺，完成认证预检。 / Validate readiness and the exact public action list. | 未就绪 / Not ready |
| 7. 发布与回读 / Publish and read back | 仅发布已验收 tgz；验证注释标签目标、npm gitHead/integrity/下载字节、GitHub Release 目标与资产。 / Publish the accepted bytes and independently verify every public identity. | 未发布 / Not published |

阶段 1 已由隔离合成账本补齐，不涉及用户私态。剩余原生门槛不能由此替代。

Stage 1 is covered by disposable synthetic-ledger probes. This does not replace the remaining native gates.

## 原生交接 / Native handoff

跨主机执行者使用仓库已有 `scripts/native_acceptance.py`，先对拟运行命令加 `--preflight`。输出与 transfer receipt 使用仓库外不同的未占用路径。只有通过 CI 的确切候选与冻结制品才能进入正式原生验收；预检不证明宿主已加载该制品。

Use the repository native entrypoint with `--preflight` before execution. Store annexes and transfer receipts at distinct unused paths outside the checkout. Preflight is not evidence that the host loaded the artifact.

T06 仅使用执行者新建的隔离目录和自有句柄进程。分别记录 metadata/content/directory 与 dependency status；未知依赖不得进入删除集合。Windows 失败后先只读核对，不循环删除、不杀持有者或重启。原生入口使用 `--t06` 记录额外场景，Windows CI 也执行此门槛；宿主 Web/Headless 仍需独立验收。

T06 uses only disposable directories and an owned handle process. Record removal layers separately from dependency status. Unknown dependencies prohibit removal. Pass `--t06` to bind the additional OS fixture to the artifact annex. Windows CI also runs this gate; Web/Headless acceptance remains independent.

本计划不安排修改用户日常运行态。安装/重启日常 Web 或 Headless 配置与发布验收保持独立。

This plan does not schedule changes to daily user profiles. Applying or restarting those profiles remains separate from release acceptance.
