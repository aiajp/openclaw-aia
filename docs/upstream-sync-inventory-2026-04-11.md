# Upstream Sync Inventory — 2026-04-11

棚卸し目的: Cオプション(skill-scrumをランタイム非依存サービスに切り出し)の実行前に、OpenClaw上流との差分を洗い出し、マージvs塩漬け判断の材料を整える。

## TL;DR

- **AIA固有の実変更は32ファイル、約4,384行追加のみ**(想像より遥かに小さい)
- **src/コア変更は1コミットに集約**(`980ddd8997` stream-json) — 汎用機能なので上流PR化可能
- **synthagent-acp は plugin-sdk/acpx の公開APIのみを使用** — 上流の大規模リファクタでもAPI surfaceは維持されている。**マージリスク: LOW**
- **重要なAIA資産が git-untracked のまま放置されている**(synthagent-acp, skill-scrum等) — マージ事故で消失する恐れ。**最優先で要commit**
- **上流は現在 v2026.4.11 まで進行中**、merge-baseからのドリフトは12,648ファイル

---

## 1. 現状バージョン

| 項目                         | 値                                                       |
| ---------------------------- | -------------------------------------------------------- |
| Merge base                   | `d925b0113f` (`test: add parallels linux smoke harness`) |
| 現在のブランチ               | `feature/cli-stream-json-slack`                          |
| 上流最新タグ                 | `v2026.4.11` (他 4.9/4.9-beta.1/4.8/4.7 等)              |
| AIA独自コミット数            | 18                                                       |
| AIA真の変更                  | 32 files, +4,384 / -318                                  |
| 上流の進行量(merge-base以降) | 12,648 files, +1.4M / -482K                              |

---

## 2. AIA独自変更の分類

### (a) PR-able to upstream(上流に還元可能な汎用改修)

**Stream-JSON Claude Code Integration** — 単一コミット `980ddd8997`

| ファイル                                         | 変更内容                      |
| ------------------------------------------------ | ----------------------------- |
| `src/agents/cli-backends.ts`                     | stream-json対応               |
| `src/agents/cli-runner.ts`                       | onStdoutコールバック追加      |
| `src/agents/cli-runner/stream-json.ts`           | **新規** NDJSONパーサ (201行) |
| `src/auto-reply/reply/agent-runner-execution.ts` | ストリームイベント転送        |
| `src/commands/agent.ts`                          | CLIフラグ追加                 |
| `src/config/types.agent-defaults.ts`             | 設定型                        |

**特徴**:

- Claude Codeの`--output-format stream-json`を使ったリアルタイムプログレス転送
- AIA固有のビジネスロジックは含まない、汎用機能
- ブランチ名(`feature/cli-stream-json-slack`)が示す通り、もともと上流PR想定
- **推奨**: 上流にPR提出 → マージされれば維持コスト0

**リスク**: 上流がすでに類似機能を実装している可能性(要確認)。その場合は重複削除で対応。

### (b) AIA固有で維持必須

#### スキル群(skills/)

| スキル            | 状態             | サイズ            | 備考                                |
| ----------------- | ---------------- | ----------------- | ----------------------------------- |
| skill-freee       | tracked          | -                 | freee API連携                       |
| skill-obsidian    | tracked          | -                 | Obsidian Vault連携                  |
| skill-claude-code | tracked          | -                 | Claude Codeセッション               |
| skill-kanban (M)  | tracked          | -                 | 現行運用、廃止予定                  |
| skill-reviewer    | tracked          | -                 | skill-scrum/auto-reviewerに統合予定 |
| **skill-scrum**   | ⚠️ **untracked** | 1,567行(lib/のみ) | 🚨 要commit                         |

#### 拡張(extensions/)

- **synthagent-acp** ⚠️ **untracked** — SynthAgent ACP Backend プラグイン。🚨 要commit

#### スクリプト(scripts/)

| スクリプト                   | 状態             | 備考                 |
| ---------------------------- | ---------------- | -------------------- |
| update-ssh-sg.sh (M)         | tracked          | SSH SG自動更新       |
| on-review-trigger.ts         | tracked          | レビューフック       |
| on-review-trigger-wrapper.sh | tracked          | レビューフックラッパ |
| orchestrate-task.ts          | tracked          | タスク制御           |
| **synthagent-cli**           | ⚠️ **untracked** | 🚨 要commit          |
| **deploy-kanban-ec2.sh**     | ⚠️ **untracked** | 🚨 要commit          |
| **on-review-trigger.sh**     | ⚠️ **untracked** | 🚨 要commit          |

#### ドキュメント(docs/)

- `setup.md` (M), `SDD-scrum-agent.md` (??), `architecture-integration.md` (??), `github-projects-manual-setup.md` (??)

#### ルート

- `SPEC.md` — AIA製品仕様
- `AGENTS.md` (M) — AIA用カスタマイズ
- `.gitignore` (M) — AIA secrets除外
- `.claude/agents/` — security-reviewer, upstream-diff-analyzer
- `.claude/skills/` — deploy-ec2, upstream-sync
- `config/.gitkeep`, `docs/.gitkeep`

### (c) 除去可能 or 要整理

| パス                                     | 理由                             |
| ---------------------------------------- | -------------------------------- |
| `.playwright-mcp/`                       | MCP一時ファイル、gitignoreすべき |
| `openagents-readme-full.png`             | 一時スクリーンショット? 要確認   |
| `scripts/on-review-trigger.sh.bak`       | バックアップファイル、削除可     |
| `.env.local`                             | secrets、gitignoreすべき         |
| `docs/research-ai-agent-pricing-2026.md` | 調査資料、Obsidianに移動可       |

---

## 3. src/コア侵入の監査

**結論: CLAUDE.mdで禁止された `src/core/`, `src/gateway/` への変更はゼロ** ✅

src/への変更はすべて単一コミット(`980ddd8997`)に集約され、内容は Claude Code stream-json 連携の汎用機能。触られているのは:

- `src/agents/` (cli-backends, cli-runner, cli-runner/stream-json)
- `src/auto-reply/` (reply/agent-runner-execution)
- `src/commands/` (agent)
- `src/config/` (types.agent-defaults)

いずれも「core/gateway ではないが core-adjacent」な層。上流PR化すればこの懸念は完全消滅する。

---

## 4. acpx 上流リファクタの影響評価

### synthagent-acp の import surface

synthagent-acp は **`openclaw/plugin-sdk/acpx` の公開APIのみ**を使用(`src/plugin-sdk/acpx.ts`)。

使用しているシンボル:

- `OpenClawPluginApi`, `OpenClawPluginService`, `OpenClawPluginServiceContext`
- `AcpRuntimeError`
- `AcpRuntime`, `AcpRuntimeCapabilities`, `AcpRuntimeDoctorReport`
- `AcpRuntimeEnsureInput`, `AcpRuntimeEvent`, `AcpRuntimeHandle`, `AcpRuntimeStatus`, `AcpRuntimeTurnInput`
- `registerAcpRuntimeBackend`, `unregisterAcpRuntimeBackend`

### 上流 v2026.4.11 での存在確認

**全シンボル存続を確認済み** ✅

`upstream/main:src/plugin-sdk/acpx.ts` に上記すべてがエクスポートされている。上流は「use supported acpx runtime surface」というコミットメッセージが示す通り、SDK公開面を意図的に安定化させている。

### 上流の関連リファクタコミット

- `154a7edb7c refactor: consume acpx runtime library (#61495)` — 内部再編
- `fb61986767 refactor(acpx): embed ACP runtime in plugin` — ランタイム埋め込み
- `38a673b688 refactor: use supported acpx runtime surface` — SDK面の安定化
- `6211e3dcd6 fix: raise acpx runtime timeout` — fix
- `f6124f3e17 ACP: harden Discord recovery and reset flow (#62132)` — Discord用

**マージリスク評価**: **LOW**

- 影響は内部実装のみ、公開API surfaceは維持
- synthagent-acp は SDK消費者として清潔に書けている
- 予想される対応: 型推論の微調整、最大でも import path 整理

---

## 5. 判断材料

### マージ(i)を選ぶ根拠

- AIAの実変更は32ファイルと小さい
- src/変更は単一機能で上流PR化可能
- synthagent-acp のマージリスクは低い
- 上流の品質改善(テスト速度、リファクタ)の恩恵を受けられる
- **マージ難度の見積もり: Medium** — 手術は必要だが現実的

### 塩漬け(ii)を選ぶ根拠

- Hermesへの移行視野があるなら、上流追従コストは回収できない可能性
- 上流は急速に進化中 → 毎月のマージ負担が継続する
- AIA独自部分は隔離されているので、塩漬けしても当面困らない
- skill-scrumの切り出し(C)に注力できる

### どちらにしても必須(A)

- 🚨 **untracked資産のcommit**(synthagent-acp, skill-scrum, synthagent-cli等)。これをやらないとマージでも移行でも事故る。
- 🧹 **(c)分類の除去可能ファイル整理**。ノイズを減らしてから判断する。

---

## 6. 推奨アクション(優先順)

### Phase 0: 安全確保(即時、数時間)

1. **untracked な AIA 資産をすべてcommit**
   - `extensions/synthagent-acp/`
   - `skills/skill-scrum/`
   - `scripts/synthagent-cli`, `scripts/deploy-kanban-ec2.sh`, `scripts/on-review-trigger.sh`
   - `docs/SDD-scrum-agent.md`, `docs/architecture-integration.md`, `docs/github-projects-manual-setup.md`
2. **不要ファイルを除去 or gitignore**
   - `.playwright-mcp/`, `.env.local` → `.gitignore` 追加
   - `scripts/on-review-trigger.sh.bak` → 削除
3. **feature branchをmainにマージ**(現状 stream-json がブランチに閉じこもっている)

### Phase 1: 上流同期vs塩漬けの意思決定

- 本ドキュメントをもって akkey が判断
- **推奨**: (i)マージ先行。理由は synthagent-acp の影響が限定的と判明したこと、AIA変更量が小さいこと、塩漬けで得られるリターンが薄いこと

### Phase 2(マージ選択時): 上流マージ実行

- skill-scrum / synthagent-acp は凍結
- `git merge upstream/main` → コンフリクト解消(AIA独自部分優先)
- ビルド・テスト、EC2動作確認
- stream-json コミットは別途上流PR化検討

### Phase 3: skill-scrum 切り出し(C本番)

- クリーンなベースで `services/scrum-agent/` に抽出
- OpenClaw skill は薄いアダプタ化
- Hermes アダプタは後追いPoC

---

## 7. Open Questions

1. **stream-json は上流でもう実装されているか?** → `upstream/main` のChangelog/コミットで類似PR検索必要
2. **synthagent-acp はなぜ untracked のままか?** → secrets含んでいるのか、単に commit 漏れか確認必要
3. **.openclaw/workspace/CLAUDE.md(EC2側)** の同期ポリシー — 本棚卸しには含まれていない
4. **skill-reviewer は skill-scrum/auto-reviewer に吸収予定** → マージ前に統合するか、一時維持するか

---

**作成者**: Claude Code (Opus 4.6)
**最終更新**: 2026-04-11
