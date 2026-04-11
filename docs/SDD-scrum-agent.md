# SDD: スクラムエージェント + GitHub Projects移行

## ステータス: v1.0

## 作成日: 2026-03-31

## 更新日: 2026-04-03

## 著者: Akkey + 秘書AI

---

> **開発方針**: 本SDD（スクラムエージェント）の開発自体は、現行の **KANBAN + OpenClaw → Claude Code** 基盤で実施する。
> スクラムエージェントが安定稼働した後、開発基盤を **GitHub Projects → OpenClaw → Claude Code** に移行し、KANBANを廃止する（Phase 5）。
> つまり「現行の仕組みで、次の仕組みを作る」。

---

## 0. 前提条件

### チーム構成

| 役割          | 担当                       | 備考                                     |
| ------------- | -------------------------- | ---------------------------------------- |
| Product Owner | Akkey                      | Sprint Planning承認、Backlog優先順位決定 |
| Scrum Master  | スクラムエージェント（AI） | Sprint運営自動化                         |
| Dev Team      | Claude Code（自律）        | Task Executor経由でPR作成                |
| Reviewer      | Claude Opus API（自律）    | Auto Reviewer + 週1品質レビュー          |

### SESブロック時間

| 時間帯      | 月〜金              | 土日    |
| ----------- | ------------------- | ------- |
| 9:30-18:00  | INTLOOP SES（8.5h） | AIA自由 |
| 6:00-9:30   | AIA可能（3.5h）     | AIA自由 |
| 18:00-23:00 | AIA可能（5h）       | AIA自由 |

- SES中もSlack承認等の軽作業は可能
- 突発作業: 月1回あるかどうか → バッファ2ptで吸収
- リリース前は残業あり（不定期）

### Akkey AIA投入時間（実績ベース）

- 平日夜: 2〜3h × 5日 = 10〜15h
- 土曜AIAデー: 6〜8h
- **現実ライン: 週15〜23h**

### Claude Code 自律稼働時間

- **24h × 7日 = 168h**（EC2常時稼働、SES中も動く）
- Task Executorが1時間ごとに "Ready" Issueを自動消化
- → これが最大の武器。Akkeyが寝ている間もSES中も開発が進む

### FP（Function Point）定義

**二段階見積もり方式**: FP（複雑度）→ AI実行時間見積もり → Sprint容量計算

AI開発では人間基準の作業時間が無意味になるため、FP（機能の複雑度）を基準とし、
そこからAI実行時間を見積もる。FPは実装者の速度に依存しない客観的指標。

**FPはTask（Sub Issue）に付与する。Issue（親）には付与しない。**

#### Step 1: FP（複雑度）判定

| FP  | 複雑度 | 判定基準                          | Task例                                     |
| --- | ------ | --------------------------------- | ------------------------------------------ |
| 1   | 極小   | 変更ファイル1、ロジック変更なし   | typo修正、設定変更、ラベル追加             |
| 2   | 小     | 変更ファイル1-2、単一ロジック     | 小さなbugfix、テスト追加、ドキュメント更新 |
| 3   | 中     | 変更ファイル2-4、複数ロジック連携 | API endpoint追加、handler実装、CI設定      |
| 5   | 大     | 変更ファイル5+、新コンポーネント  | 新機能実装、skill全体、Workflow一式        |
| 8   | 特大   | アーキテクチャ影響、分割推奨      | システム間統合、DB設計変更 → 3+5等に分解   |

**判定の入力項目（スクラムエージェントが自動算出）:**

- 変更ファイル数（予測）
- 新規 API / インターフェース数
- 既存インターフェースへの影響
- テスト追加の必要性
- 外部システム連携の有無

#### Step 2: AI実行時間見積もり

| FP  | AI実行時間（見積もり） | Sprint 1 実績                      |
| --- | ---------------------- | ---------------------------------- |
| 1   | 〜5分                  | CONTRIBUTING.md: 約2分             |
| 2   | 〜15分                 | ドキュメント更新: 約5分            |
| 3   | 〜30分                 | cron確認: 約15分, 移行確認: 約10分 |
| 5   | 〜1時間                | E2Eテスト: 約20分                  |
| 8   | 〜2時間                | 未検証、分割推奨                   |

**実績調整**: Sprint毎にFP→実績時間の対応を更新。Sprint 4以降は移動平均で自動調整。

#### Issue（親）のFP目安

| 規模           | FP合計 | Task分解例      |
| -------------- | ------ | --------------- |
| 小機能         | 5〜8   | 2〜3 Tasks      |
| 中機能         | 8〜13  | 3〜5 Tasks      |
| 大機能（Epic） | 13+    | Issue自体を分割 |

### Sprint設定

| 項目                    | 値              | 根拠                                                                              |
| ----------------------- | --------------- | --------------------------------------------------------------------------------- |
| Sprint期間              | 1週間（月〜日） | INTLOOP SES + AIA体制に最適                                                       |
| Sprint容量（計画）      | 60FP            | AI実行: FP 1=5分、1時間で12FP → 1日5hアクティブで60FP/日。1週間で余裕を持って60FP |
| バッファ                | 5FP             | SES突発対応 + AI実行エラーリトライ                                                |
| 実効容量                | 55FP            | 60FP - 5FP                                                                        |
| Task Executorポーリング | 1時間ごと       | FP 3（30分）完了後すぐ次を拾える                                                  |

**注**: Sprint 1（旧SP基準18pt）はFP換算で約15FP相当。初回はE2E検証タスクが多く実際の開発量は少なかった。
Sprint 2以降は実プロダクト開発タスクで容量を検証し、Sprint 4で安定化させる。

### 容量の実績調整ルール

- Sprint 1〜3: ベースライン収集期間（容量は手動調整可）
- Sprint 4以降: 過去3Sprint移動平均ベロシティで自動調整
- 達成率80%未満が2Sprint連続 → 容量を10%減
- 達成率100%超が2Sprint連続 → 容量を10%増

### Issue / Task 階層定義

GitHub Projectsの Sub Issues 機能を活用し、Issue（機能単位）とTask（作業単位）を階層化する。

|                 | Issue（親）                      | Task（Sub Issue）                      |
| --------------- | -------------------------------- | -------------------------------------- |
| 粒度            | 機能単位・成果物                 | 作業単位・実装ステップ                 |
| FP規模          | まとまった量（8〜13+）           | 数FP（1〜5）                           |
| 例              | 「SynthAgent E2Eテスト基盤構築」 | 「ヘルスチェックAPI E2Eテスト」        |
| 作成者          | Akkey（PO）またはSDD分解         | スクラムエージェントが提案 → Akkey承認 |
| Sprint Board    | 載せない（Label: Parent）        | Sprint Boardで管理・遷移する           |
| Claude Code実行 | 対象外                           | Task Executorが拾って実行              |

```
SDD（要件定義）
  │ 機能を洗い出す
  ▼
Issue（機能単位 = FPの塊、Label: Parent）
  │ スクラムエージェントが Task に分解提案
  ▼
Task（Sub Issue = 数FP、Claude Codeが実行可能な粒度）
  │ Task Executorが "Ready" から拾う
  ▼
Claude Code（実装 → PR → Auto Review → merge）
```

**Story Points は Task（Sub Issue）に付与する。** Issue（親）の FP は子Task の SP合計から自動算出。

### 責務分離: GitHub Projects vs スクラムエージェント

GitHub Projectsが「管理基盤」、スクラムエージェントが「実行エンジン」。
スクラム管理のUIや構造を自前で再発明しない。

**GitHub Projects がコントロールする範囲:**

| 機能                                | 方法                                    |
| ----------------------------------- | --------------------------------------- |
| Issue / Task（Sub Issue）階層管理   | Sub Issues 機能                         |
| カンバンView（親Issue除外）         | Board View + フィルタ `-label:Parent`   |
| イテレーション（スプリント期間）    | Iteration フィールド                    |
| Custom Fields（SP, Priority, Type） | GitHub Projects native                  |
| カード自動遷移                      | GitHub Actions（PR/merge/ブランチ連動） |
| ロードマップ・ガントチャート        | Timeline View + Milestone               |
| PR ↔ Issue 自動クローズ             | Development 連携                        |

**スクラムエージェントがやる範囲:**

| 機能                        | 方法                                         |
| --------------------------- | -------------------------------------------- |
| Issue → Task 分解の**提案** | AI分析 → Sub Issue 作成 → Slack承認          |
| "Ready" Task を拾って実行   | Task Executor（cron）                        |
| Sprint Planning 提案        | Backlog分析 → 容量に合わせて選択 → Slack承認 |
| Daily Standup レポート      | GitHub Projects API 集計 → Slack投稿         |
| Sprint Review レポート      | ベロシティ・品質メトリクス → Weeklyノート    |
| Auto Review                 | Opus API でPRレビュー → approve/reject       |
| リトライ実行                | reject 検知 → Claude Code 再起動（最大2回）  |

---

## 1. 背景と目的

### 現状の課題

AIA株式会社の開発タスク管理は以下の問題を抱えている:

1. **KANBAN（clineフォーク）がEC2上で不安定** — git repo未接続、プロジェクト未追加で実質停止
2. **自律開発はAkkeyの手動キックに依存** — W13の32PRはAkkeyが直接投入して実現
3. **スプリント管理がない** — タスクはWeeklyノートに散在、優先順位は暗黙的
4. **GitHub上のIssue/PRとタスク管理が分離** — KANBANとGitHubが繋がっていない

### 目的

- **GitHub Projectsをスプリントボードの Single Source of Truth にする**
- **スクラムエージェントが自律的にスプリントを運営する**（PO = Akkey、それ以外はAI）
- **KANBANの自律開発機能（2フェーズ実行、自動レビュー、リトライ）をGitHub Projects上で再現する**

---

## 2. アーキテクチャ

```
Akkey（PO）
    │ Sprint Planning時にBacklog優先順位を承認
    │ 日常はSlack通知の ✅/❌ のみ
    ↓
GitHub Projects（Sprint Board — SSoT）
    │ Issues = Sprint Backlog
    │ Views: Board / Table / Timeline
    │ Custom Fields: Story Points, Sprint, Priority
    ↑↓
スクラムエージェント（OpenClaw skill-scrum）
    │
    ├── 🗓️ Sprint Planner
    │     毎週月曜 06:00 JST cron起動
    │     Backlogから優先順位順にIssue選択 → Sprint Boardに移動
    │     → Slack通知「Sprint N 計画: XX pt / 容量 YY pt。承認？」
    │
    ├── 🔨 Task Executor
    │     Sprint Board の "Ready" カラムを監視
    │     Issue を拾う → Claude Code 起動 → ブランチ作成 → 実装 → PR作成
    │     Issue ステータスを "In Progress" → "In Review" に自動遷移
    │
    ├── 🔍 Auto Reviewer
    │     PR作成を検知（GitHub Webhook or polling）
    │     Opus API でセマンティックレビュー
    │     approve → auto-merge / request_changes → Claude Codeで修正 → 再レビュー（最大2回）
    │
    ├── 📊 Daily Standup Reporter
    │     毎朝 08:00 JST cron起動
    │     GitHub Projects APIで進捗集計
    │     → Slack #claw に投稿:
    │       ✅ 昨日完了: N issues (X pt)
    │       🔄 進行中: N issues
    │       ⚠️ ブロッカー: ...
    │       📉 バーンダウン: 残 XX pt / 期間残 Y日
    │
    └── 📈 Sprint Review Generator
          毎週日曜 20:00 JST cron起動
          ベロシティ計算、バーンダウン生成
          → Weeklyノートの振り返りセクションに自動記入
          → 次スプリントの容量推奨値を提示
```

---

## 3. GitHub Projects 設計

### 3.1 プロジェクト構成

```
GitHub Org: aiajp
    └── Project: "AIA Sprint Board"（org横断）
          ├── View: Board（カンバン — Task用）
          │     Columns: Backlog | Ready | In Progress | In Review | Done
          │     Filter: -label:Parent（親Issueを除外、Taskのみ表示）
          ├── View: Features（テーブル — Issue親用）
          │     Filter: label:Parent
          │     Sub Issues展開で進捗確認
          ├── View: Sprint（テーブル）
          │     Group by: Sprint / Assignee
          ├── View: Timeline（ロードマップ）
          └── View: Burndown（チャート — GitHub native or 外部）
```

### 3.2 対象リポジトリ

| リポジトリ             | 状態                     | スプリント対象                           |
| ---------------------- | ------------------------ | ---------------------------------------- |
| aiajp/synthagent       | ほぼ完成、L4ローンチ残り | エンハンス・バグ修正                     |
| aiajp/rag-in-a-box     | 市場投入済み             | エンハンス・機能強化                     |
| aiajp/openclaw-aia     | 稼働中                   | プラグイン追加・スクラムエージェント自身 |
| aiajp/aia-corporate-lp | 公開中                   | LP改修タスク                             |

### 3.3 Custom Fields

| フィールド    | 型            | 値                                     | 対象                                  | 備考                 |
| ------------- | ------------- | -------------------------------------- | ------------------------------------- | -------------------- |
| Story Points  | Number        | 1, 2, 3, 5, 8                          | Task（Sub Issue）のみ                 |                      |
| Sprint        | Iteration     | 1週間サイクル                          | Task（Sub Issue）のみ                 |                      |
| Priority      | Single Select | Critical / High / Medium / Low         | Issue, Task 両方                      |                      |
| Type          | Single Select | Feature / Task / Bug / Spike           | Issue = Feature, Sub Issue = Task/Bug |                      |
| Model         | Single Select | `opus` / `sonnet` / `haiku`            | Task（Sub Issue）のみ                 | デフォルト: `sonnet` |
| Assignee      | Text          | `claude-code` / `akkey`                | Task（Sub Issue）のみ                 |                      |
| Review Status | Single Select | Pending / Approved / Changes Requested | Task（Sub Issue）のみ                 |                      |

**Model フィールド決定ルール:**

| 条件                         | 使用モデル                         | 理由                             |
| ---------------------------- | ---------------------------------- | -------------------------------- |
| Task に Model 指定あり       | 指定値を使用                       | 明示的な指定を優先               |
| Task に Model 指定なし       | `sonnet`（デフォルト）             | コスト効率と実行速度のバランス   |
| 2フェーズ実行（orchestrate） | Plan = `opus` / Execute = `sonnet` | Task Executorが自動切替          |
| Auto Reviewer                | `opus`（API直接）                  | セマンティックレビューは最高品質 |

Task Executor は GitHub Projects API から Task の Model フィールドを読み取り、
Claude Code CLI に `--model <value>` フラグとして渡す。
（kanban `runtime-api.ts` の `--model` 注入ロジックを移植）

**Labels（階層識別用）:**

- `Parent` — Issue（親、機能単位）に付与。カンバンViewから除外するため
- Sub Issue にはこのラベルを付けない（Sprint Boardに表示される）

### 3.4 Issue Templates

```yaml
# .github/ISSUE_TEMPLATE/feature.yml
name: Feature（機能 = Issue親）
description: 機能単位のIssue。Sub IssueとしてTaskを紐づける
labels: ["Type: Feature", "Parent"]
body:
  - type: textarea
    id: description
    attributes:
      label: 機能概要
      description: この機能で何を実現するか
  - type: textarea
    id: tasks
    attributes:
      label: 想定Task分解（スクラムエージェントが精緻化）
      description: おおまかなTask候補（省略可、AIが提案）
  - type: dropdown
    id: priority
    attributes:
      label: 優先度
      options: ["Critical", "High", "Medium", "Low"]
```

```yaml
# .github/ISSUE_TEMPLATE/task.yml
name: Task（作業単位 = Sub Issue）
description: 実装タスク（スクラムエージェントが自動実行可能）
labels: ["Type: Task"]
body:
  - type: textarea
    id: description
    attributes:
      label: タスク内容
      description: 何を実装・修正するか
  - type: textarea
    id: acceptance
    attributes:
      label: 完了基準
      description: どうなれば完了か（テスト含む）
  - type: dropdown
    id: points
    attributes:
      label: Story Points
      options: ["1", "2", "3", "5", "8", "13"]
  - type: dropdown
    id: priority
    attributes:
      label: 優先度
      options: ["Critical", "High", "Medium", "Low"]
```

### 3.5 Labels

```yaml
# Type
- "Type: Epic" # 8B5CF6
- "Type: Story" # 3B82F6
- "Type: Task" # 10B981
- "Type: Bug" # EF4444
- "Type: Spike" # F59E0B

# Priority
- "P: Critical" # DC2626
- "P: High" # EA580C
- "P: Medium" # CA8A04
- "P: Low" # 65A30D

# Story Points
- "SP: 1" # 0E8A16
- "SP: 2" # FBCA04
- "SP: 3" # F9D0C4
- "SP: 5" # D93F0B
- "SP: 8" # B60205
- "SP: 13" # 5319E7

# Status（GitHub Projectsのカラムと連動）
- "Status: Ready" # 22C55E
- "Status: In Progress" # 3B82F6
- "Status: In Review" # A855F7
- "Status: Blocked" # EF4444
```

---

## 3.6 GitHub Actions — カード自動遷移

KANBANの核心価値「カードが自動で動く」をGitHub Actionsで再現する。
全4リポジトリに共通Workflowを配置。

### 遷移マトリクス

```
                    ┌─────────────────────────────────────────────┐
                    │            GitHub Projects Board             │
                    │                                             │
  Sprint Planning   │  Backlog ──→ Ready                          │
  (cron/手動)       │                │                            │
                    │                ↓ Task Executor起動          │
                    │           In Progress                       │
                    │                │                            │
                    │                ↓ PR作成                     │
                    │            In Review                        │
                    │              ↙    ↘                         │
                    │     approve      reject                     │
                    │        ↓           ↓                        │
                    │      Done    In Progress（リトライ）         │
                    │                    ↓                        │
                    │              In Review（再レビュー）         │
                    │              max 2回 → 失敗なら Blocked      │
                    └─────────────────────────────────────────────┘
```

### Workflow 1: PR作成時 → Issue を "In Review" に移動

```yaml
# .github/workflows/scrum-pr-opened.yml
name: "Scrum: PR → In Review"
on:
  pull_request:
    types: [opened, reopened]

jobs:
  move-to-review:
    runs-on: ubuntu-latest
    steps:
      - name: Extract issue number from branch
        id: issue
        run: |
          # ブランチ名: feature/AIAA-42-description or fix/42-description
          BRANCH="${{ github.head_ref }}"
          ISSUE_NUM=$(echo "$BRANCH" | grep -oP '\d+' | head -1)
          echo "number=$ISSUE_NUM" >> "$GITHUB_OUTPUT"

      - name: Move issue to "In Review"
        if: steps.issue.outputs.number != ''
        uses: actions/github-script@v7
        with:
          github-token: ${{ secrets.PROJECT_TOKEN }}
          script: |
            // GitHub Projects v2 GraphQL API でカラム移動
            const issueNumber = ${{ steps.issue.outputs.number }};
            const projectId = '${{ vars.PROJECT_ID }}';
            const statusFieldId = '${{ vars.STATUS_FIELD_ID }}';
            const inReviewOptionId = '${{ vars.IN_REVIEW_OPTION_ID }}';

            // Issue の Project Item ID を取得
            const { repository } = await github.graphql(`
              query($owner: String!, $repo: String!, $number: Int!) {
                repository(owner: $owner, name: $repo) {
                  issue(number: $number) {
                    projectItems(first: 10) {
                      nodes { id }
                    }
                  }
                }
              }
            `, {
              owner: context.repo.owner,
              repo: context.repo.repo,
              number: issueNumber
            });

            const itemId = repository.issue.projectItems.nodes[0]?.id;
            if (!itemId) return;

            // ステータスを "In Review" に更新
            await github.graphql(`
              mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
                updateProjectV2ItemFieldValue(input: {
                  projectId: $projectId
                  itemId: $itemId
                  fieldId: $fieldId
                  value: { singleSelectOptionId: $optionId }
                }) { projectV2Item { id } }
              }
            `, {
              projectId, itemId,
              fieldId: statusFieldId,
              optionId: inReviewOptionId
            });
```

### Workflow 2: PR マージ時 → Issue を "Done" に移動 + Issue クローズ

```yaml
# .github/workflows/scrum-pr-merged.yml
name: "Scrum: Merge → Done"
on:
  pull_request:
    types: [closed]

jobs:
  move-to-done:
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    steps:
      - name: Extract issue number
        id: issue
        run: |
          BRANCH="${{ github.head_ref }}"
          ISSUE_NUM=$(echo "$BRANCH" | grep -oP '\d+' | head -1)
          echo "number=$ISSUE_NUM" >> "$GITHUB_OUTPUT"

      - name: Move issue to "Done" and close
        if: steps.issue.outputs.number != ''
        uses: actions/github-script@v7
        with:
          github-token: ${{ secrets.PROJECT_TOKEN }}
          script: |
            const issueNumber = ${{ steps.issue.outputs.number }};
            // ... GraphQL で "Done" カラムに移動（Workflow 1と同構造）

            // Issue をクローズ
            await github.rest.issues.update({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: issueNumber,
              state: 'closed',
              state_reason: 'completed'
            });
```

### Workflow 3: Auto Reviewer（PR作成 → OpenClaw通知 → Claude Codeレビュー）

GitHub Actionsはレビュー通知のみ。実際のレビューはOpenClaw → Claude Codeで実行。

```
PR作成/push
    │ GitHub Actions (scrum-auto-review.yml)
    │ Slack Bot API で OpenClaw に通知
    ▼
OpenClaw (EC2常駐)
    │ Slack通知を検知 → skill-scrum/auto-reviewer 起動
    ▼
Claude Code (--model opus)
    │ リポジトリ全体のコンテキストを踏まえてレビュー
    │ gh pr review → approve / request_changes
    ▼
GitHub (PR)
    │ approve → auto-merge → scrum-pr-merged → Done
    │ reject → scrum-retry → リトライ or Blocked
```

```yaml
# .github/workflows/scrum-auto-review.yml
name: "Scrum: Auto Review"
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  notify-openclaw:
    runs-on: ubuntu-latest
    steps:
      - name: Extract issue number from branch
        id: issue
        run: |
          BRANCH="${{ github.head_ref }}"
          ISSUE_NUM=$(echo "$BRANCH" | grep -oP '\d+' | head -1)
          echo "number=$ISSUE_NUM" >> "$GITHUB_OUTPUT"

      - name: Notify OpenClaw via Slack
        run: |
          curl -s -X POST "https://slack.com/api/chat.postMessage" \
            -H "Authorization: Bearer ${{ secrets.SLACK_BOT_TOKEN }}" \
            -H "Content-Type: application/json" \
            -d "{
              \"channel\": \"#claw\",
              \"text\": \"🔍 Auto Review requested: PR #${{ github.event.pull_request.number }} in ${{ github.repository }} (Task #${{ steps.issue.outputs.number }})\\nBranch: ${{ github.head_ref }}\"
            }"
```

**OpenClaw側の実装（skill-scrum/auto-reviewer.ts）:**

- Slack通知を検知してレビューを開始
- Claude Code CLI（`--model opus`）でリポジトリをcheckout → PR diffを読む → レビュー
- `gh pr review` で approve / request_changes を投稿
- KANBANの `on-review-trigger.ts` からレビューロジックを移植

### Workflow 4: レビューreject → リトライ（Task Executor再起動）

```yaml
# .github/workflows/scrum-retry.yml
name: "Scrum: Review Reject → Retry"
on:
  pull_request_review:
    types: [submitted]

jobs:
  retry-on-reject:
    if: github.event.review.state == 'changes_requested'
    runs-on: ubuntu-latest
    steps:
      - name: Check retry count
        id: retry
        run: |
          # PRコメントから過去のリトライ回数をカウント
          RETRY_COUNT=$(gh pr view ${{ github.event.pull_request.number }} \
            --json comments -q '[.comments[] | select(.body | contains("Auto-retry"))] | length')
          echo "count=$RETRY_COUNT" >> "$GITHUB_OUTPUT"
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Move to Blocked (max retries reached)
        if: steps.retry.outputs.count >= 2
        run: |
          gh pr comment ${{ github.event.pull_request.number }} \
            --body "Auto-retry limit reached (2/2). Moving to Blocked. @akkey manual review needed."
          # Issue を "Blocked" に移動（GraphQL）
        env:
          GH_TOKEN: ${{ secrets.PROJECT_TOKEN }}

      - name: Trigger retry via OpenClaw
        if: steps.retry.outputs.count < 2
        run: |
          # OpenClaw の Task Executor にリトライを依頼
          # 方法A: GitHub Actions → SSH → EC2 の OpenClaw skill-scrum を起動
          # 方法B: Slack Webhook → OpenClaw が検知して実行
          # 方法C: repository_dispatch イベントで EC2 の listener が拾う
          gh pr comment ${{ github.event.pull_request.number }} \
            --body "Auto-retry ($((RETRY_COUNT + 1))/2): Requesting Claude Code fix based on review feedback."
          # Slack webhook でOpenClawに通知
          curl -s -X POST "https://slack.com/api/chat.postMessage" \
            -H "Authorization: Bearer ${{ secrets.SLACK_BOT_TOKEN }}" \
            -H "Content-Type: application/json" \
            -d "{\"channel\": \"#claw\", \"text\": \"PR #${{ github.event.pull_request.number }} rejected. Retry $((RETRY_COUNT + 1))/2 starting.\"}"
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Workflow 5: Task Executor 起動時 → Issue を "In Progress" に移動

```yaml
# .github/workflows/scrum-task-started.yml
name: "Scrum: Task Started → In Progress"
on:
  create: # ブランチ作成時
    branches:
      - "feature/**"
      - "fix/**"
      - "enhance/**"

jobs:
  move-to-in-progress:
    runs-on: ubuntu-latest
    steps:
      - name: Extract issue number from branch
        id: issue
        run: |
          BRANCH="${{ github.event.ref }}"
          ISSUE_NUM=$(echo "$BRANCH" | grep -oP '\d+' | head -1)
          echo "number=$ISSUE_NUM" >> "$GITHUB_OUTPUT"

      - name: Move issue to "In Progress"
        if: steps.issue.outputs.number != ''
        uses: actions/github-script@v7
        with:
          github-token: ${{ secrets.PROJECT_TOKEN }}
          script: |
            // ... GraphQL で "In Progress" カラムに移動
```

### 共有Workflow テンプレート

全4リポジトリに同じWorkflowを配置する必要がある。
管理を楽にするため `.github` リポジトリ（org共通）を使用:

```
aiajp/.github/
└── workflow-templates/
    ├── scrum-pr-opened.yml
    ├── scrum-pr-merged.yml
    ├── scrum-auto-review.yml
    ├── scrum-retry.yml
    └── scrum-task-started.yml
```

### 必要なSecrets / Variables（リポジトリレベル、4リポジトリ共通）

> **注**: aiajpは個人アカウントのためOrg-level Secrets/Variablesは使用不可。リポジトリ単位で設定。

| 名前                    | 種別     | 用途                                                                            | 状態      |
| ----------------------- | -------- | ------------------------------------------------------------------------------- | --------- |
| `PROJECT_TOKEN`         | Secret   | GitHub Projects v2 GraphQL操作用 Classic PAT（repo + project + workflow scope） | ✅ 設定済 |
| `ANTHROPIC_API_KEY`     | Secret   | Auto Reviewer の Opus API呼び出し                                               | ✅ 設定済 |
| `SLACK_BOT_TOKEN`       | Secret   | Slack Bot API経由の通知（chat.postMessage）                                     | ✅ 設定済 |
| `PROJECT_ID`            | Variable | AIA Sprint Board の Project ID                                                  | ✅ 設定済 |
| `STATUS_FIELD_ID`       | Variable | Status カスタムフィールドID                                                     | ✅ 設定済 |
| `READY_OPTION_ID`       | Variable | "Ready" のOption ID                                                             | ✅ 設定済 |
| `IN_REVIEW_OPTION_ID`   | Variable | "In Review" のOption ID                                                         | ✅ 設定済 |
| `IN_PROGRESS_OPTION_ID` | Variable | "In Progress" のOption ID                                                       | ✅ 設定済 |
| `DONE_OPTION_ID`        | Variable | "Done" のOption ID                                                              | ✅ 設定済 |
| `BACKLOG_OPTION_ID`     | Variable | "Backlog" のOption ID                                                           | ✅ 設定済 |
| `PRIORITY_FIELD_ID`     | Variable | Priority フィールドID                                                           | ✅ 設定済 |
| `STORY_POINTS_FIELD_ID` | Variable | Story Points フィールドID                                                       | ✅ 設定済 |
| `TYPE_FIELD_ID`         | Variable | Type フィールドID                                                               | ✅ 設定済 |
| `MODEL_FIELD_ID`        | Variable | Model フィールドID                                                              | ✅ 設定済 |
| `SPRINT_FIELD_ID`       | Variable | Sprint (Iteration) フィールドID                                                 | ✅ 設定済 |

**Slack通知方式**: Incoming Webhook ではなく Slack Bot Token (`xoxb-`) + `chat.postMessage` API を使用。
OpenClawと同じBot Tokenを共有し、トークン管理を一本化。

---

## 4. KANBAN → GitHub Projects 移行計画

### 4.1 機能マッピング

| KANBAN機能                         | GitHub Projects での代替                  | 実装方法                  |
| ---------------------------------- | ----------------------------------------- | ------------------------- |
| ボード表示                         | Board View                                | GitHub Projects native    |
| タスクカード作成                   | Issue作成                                 | `gh issue create`         |
| タスク開始（Claude Code起動）      | Issue → "In Progress" + Claude Code spawn | **スクラムエージェント**  |
| 2フェーズ実行（Plan→Execute）      | Issue内にPlan→PR→Review                   | **スクラムエージェント**  |
| 自動レビュー（Opus CLI）           | PR Webhook → Opus API review              | **スクラムエージェント**  |
| リトライ（reject→修正→再レビュー） | PR comment → Claude Code修正 → re-review  | **スクラムエージェント**  |
| タスク依存関係                     | Issue references / blocking               | GitHub native             |
| 優先順位タグ                       | Custom Field: Priority                    | GitHub Projects native    |
| Web UI                             | GitHub Projects UI                        | GitHub native（ブラウザ） |

### 4.2 移行不要な機能

- KANBAN Web UI（port 3484）→ GitHub Projects UIで代替
- KANBAN tRPC API → GitHub GraphQL API + gh CLIで代替
- skill-kanban → **skill-scrum** に置き換え

### 4.3 移行で新しく必要な機能

| 機能               | 実装先                            | 詳細                                                                |
| ------------------ | --------------------------------- | ------------------------------------------------------------------- |
| **カード自動遷移** | **GitHub Actions**（5 Workflows） | ブランチ作成→In Progress、PR→In Review、Merge→Done、Reject→リトライ |
| **Auto Reviewer**  | **GitHub Actions**                | Opus API呼び出し→approve/reject→auto-merge                          |
| **Task Executor**  | **OpenClaw skill-scrum**          | Readyカラム監視→Claude Code起動→ブランチ作成→実装→PR                |
| **Sprint管理**     | **OpenClaw skill-scrum**          | Iteration作成、Backlog→Ready移動、容量管理                          |
| **Daily Standup**  | **OpenClaw cron**                 | GitHub Projects API集計→Slack投稿                                   |
| **Sprint Review**  | **OpenClaw cron**                 | ベロシティ+品質レポート→Weeklyノート                                |

### 4.4 責務分担: GitHub Actions vs OpenClaw

```
GitHub Actions（イベント駆動 — PR/ブランチが動いたら即反応）
├── カード遷移（4 Workflows: task-started, pr-opened, pr-merged, retry）
├── Auto Review **通知**（PR作成 → Slackで OpenClaw に通知）
└── Auto Merge（CI green + approve）

OpenClaw skill-scrum（cron駆動 + Slack通知駆動）
├── Task Executor（1時間ごと — Readyを拾ってClaude Code起動）
├── **Auto Reviewer**（Slack通知を受けて Claude Code --model opus でレビュー）
├── Sprint Planner（毎週月曜 — Backlog→Ready移動）
├── Daily Standup（毎朝 — 集計→Slack）
├── Sprint Review（毎週日曜 — レポート→Weeklyノート）
└── リトライ実行（reject検知 → Claude Code再起動）
```

この分担により:

- **GitHub Actions**: リアルタイム反応（カード遷移 + OpenClawへの通知）
- **OpenClaw**: 実行エンジン（タスク実行、レビュー、レポート生成）
- **レビューは Claude Code** がリポジトリ全体のコンテキストを踏まえて実施（API直接呼びより高品質）
- 両者は Slack Bot API で連携

### 4.5 KANBANコード移植マップ

EC2上の `/home/ubuntu/kanban/` から移植すべきコードと移植先:

#### 移植優先度: 高（そのまま再利用可能）

| 元ファイル                                                     | 移植先                                                                         | 変更内容                                                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `scripts/orchestrate-task.ts`                                  | `skill-scrum/lib/task-executor.ts`                                             | KANBAN tRPC呼び出し → GitHub Projects API + Claude Code spawn に置き換え                            |
| `scripts/on-review-trigger.ts`                                 | `.github/workflows/scrum-auto-review.yml` + `skill-scrum/lib/auto-reviewer.ts` | レビューロジックはそのまま。トリガーをKANBAN WebSocket → GitHub Actions Webhook に変更              |
| `core/agent-catalog.ts`                                        | `skill-scrum/lib/agent-catalog.ts`                                             | Claude Code起動コマンド定義。`binary`, `baseArgs`, `autonomousArgs` をそのまま利用                  |
| `server/runtime-state-hub.ts` の `broadcastTaskReadyForReview` | GitHub Actions Workflow 1（PR → In Review）                                    | レビュートリガーの発火ロジック。環境変数 `KANBAN_REVIEW_TRIGGER_SCRIPT` → GitHub Webhook に置き換え |

#### 移植優先度: 中（構造を参考に書き直し）

| 元ファイル                     | 参考箇所                                                       | 新規実装                                                             |
| ------------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| `core/task-board-mutations.ts` | `RuntimeCreateTaskInput`（prompt, priority, tags, autoReview） | `skill-scrum/lib/github-projects.ts` — Issue作成 + Custom Fields設定 |
| `core/api-contract.ts`         | `RuntimeBoardCard`, `RuntimeBoardColumnId`, Priority型         | GitHub Projects v2のフィールド型に対応づけ                           |
| `skills/skill-kanban/SKILL.md` | アクション定義（status, start, stop）                          | `skill-scrum/SKILL.md` — スクラム用アクション定義                    |

#### 移植不要

| 元ファイル                           | 理由                                                     |
| ------------------------------------ | -------------------------------------------------------- |
| `cline-sdk/*`                        | Cline専用セッション管理。Claude Code直接呼び出しには不要 |
| `src/trpc/*`                         | KANBAN tRPC API。GitHub GraphQL APIで完全に代替          |
| `web-ui/*`                           | KANBAN Web UI。GitHub Projects UIで代替                  |
| `src/server/browser.ts`, `assets.ts` | Web UIサーバー。不要                                     |

#### 未実装の発見事項

- **`skill-claude-code/handler.ts` が空** — SKILL.mdの設計はあるが実装なし
- Task Executor実装時に **skill-claude-code の handler.ts も同時に実装必要**
- Claude Code呼び出しコマンド: `claude --permission-mode bypassPermissions --print '<task>'`
- ホワイトリスト方式のディレクトリ制限はSKILL.mdに定義済み

---

## 5. スクラムエージェント 詳細設計

### 5.1 実装形態

**Phase 1-4**: OpenClaw の Skill として実装: `skills/skill-scrum/`

- AIA社内専用、OpenClawから直接呼び出し
- GitHub Projects API + Claude Code spawn がコアロジック

**将来（Phase 5+）**: 独立サービスに分離

- `/Volumes/Dev_SSD/scrumagent/` — スタンドアロン FastAPI サーバー（SynthAgentと同構成）
- `openclaw-aia/extensions/scrumagent-acp/` — ACP Backend で OpenClaw 統合
- `openclaw-aia/scripts/scrumagent-cli` — CLIアダプタで KANBAN 統合
- SaaS化の前提として、skill-scrum の lib/ をそのまま独立サービスのコアに移植可能な設計にしておく

**現Phase のディレクトリ構成:**

```
skills/skill-scrum/
├── SKILL.md              # スキル定義・トリガー
├── handler.ts            # メインハンドラー
├── lib/
│   ├── github-projects.ts  # GitHub Projects GraphQL API操作
│   ├── sprint-planner.ts   # Sprint Planning ロジック
│   ├── task-executor.ts    # Claude Code起動・PR作成
│   ├── auto-reviewer.ts    # Opus APIレビュー（on-review-trigger.ts移植）
│   ├── daily-standup.ts    # Daily Standup レポート生成
│   └── sprint-review.ts    # Sprint Review・ベロシティ計算
└── templates/
    ├── daily-standup.md    # Slack投稿テンプレート
    └── sprint-review.md   # Weeklyノート記入テンプレート
```

### 5.2 GitHub API アクセス

```typescript
// GitHub Projects v2 GraphQL API
// gh CLI をラップして操作

// Issue操作
gh issue create --repo aiajp/synthagent --title "..." --body "..." --label "Type: Task,SP: 3"
gh issue edit N --add-project "AIA Sprint Board"

// Projects操作（GraphQL）
gh api graphql -f query='...'  // Sprint iteration 作成、カラム移動、Custom Fields更新

// PR操作
gh pr create --repo aiajp/synthagent --title "..." --body "..." --head feature/AIAA-N
gh pr review N --approve / --request-changes --body "..."
gh pr merge N --squash
```

### 5.3 Task Executor フロー（KANBANからの移植）

**対象: Task（Sub Issue）のみ。親Issueは直接実行しない。**

```
1. GitHub Projects API で "Ready" カラムの Task（Sub Issue）を取得
   - フィルタ: label != "Parent"（親Issueを除外）
2. 最優先（Priority × Story Points）の Task を1つ選択
3. Task を "In Progress" に移動
4. Claude Code セッション起動:
   - Working dir: Task のリポジトリに対応するローカルパス
   - Prompt: Task の description + acceptance criteria + 親Issue のコンテキスト
   - Model: Plan = Opus / Execute = Sonnet（2フェーズ）
5. Claude Code が PR を作成
   - PR description に "Closes #<task番号>" を含める
6. Task を "In Review" に移動
7. Auto Reviewer を起動（既存の on-review-trigger.ts ロジック移植）
8. approve → auto-merge → Task を "Done" に移動
   reject → Claude Code で修正 → 再レビュー（最大2回）
9. 親Issue の全Sub Issueが "Done" → 親Issue も自動クローズ
```

### 5.4 OpenClaw Cron ジョブ

```json
// ~/.openclaw/cron/jobs.json
[
  {
    "id": "sprint-planning",
    "schedule": "0 6 * * 1",
    "command": "Sprint Planning を実行して。Backlogから優先度順にIssueを選んでSprint Boardに移動。容量は20 Story Pointsを目安に。",
    "channel": "slack",
    "enabled": true
  },
  {
    "id": "daily-standup",
    "schedule": "0 8 * * 1-5",
    "command": "Daily Standup レポートを生成して #claw に投稿して。",
    "channel": "slack",
    "enabled": true
  },
  {
    "id": "task-executor",
    "schedule": "0 * * * *",
    "command": "GitHub Projects の Ready カラムにタスクがあれば1つ拾って実行開始して。",
    "channel": "slack",
    "enabled": true
  },
  {
    "id": "sprint-review",
    "schedule": "0 20 * * 0",
    "command": "Sprint Review を実行して。ベロシティ計算、バーンダウン生成、Weeklyノートに記入して。",
    "channel": "slack",
    "enabled": true
  }
]
```

### 5.5 モデル割り当て

#### スクラムエージェント内部コンポーネント

| コンポーネント          | モデル   | 理由                             |
| ----------------------- | -------- | -------------------------------- |
| Sprint Planner          | Sonnet   | Backlog分析・選択は中程度の判断  |
| Task Executor (Plan)    | Opus     | コードベース調査・実装計画       |
| Task Executor (Execute) | Sonnet   | 計画に従った実装（コスト1/5）    |
| Auto Reviewer           | Opus API | セマンティックレビューは最高品質 |
| Daily Standup           | Haiku    | 集計・テンプレート埋めのみ       |
| Sprint Review           | Sonnet   | ベロシティ分析・振り返り         |

#### GitHub Projects → OpenClaw → Claude Code のモデル受け渡し

```
GitHub Projects                    OpenClaw (Task Executor)              Claude Code
┌──────────────┐                  ┌─────────────────────┐              ┌──────────┐
│ Task #42     │  GraphQL API     │ skill-scrum         │  CLI spawn   │          │
│ Model: opus  │ ──────────────→  │ model = "opus"      │ ──────────→  │ --model  │
│              │                  │                     │  claude      │  claude-  │
│ Task #43     │                  │ model = null        │  --model     │  opus-4-6│
│ Model: (なし)│ ──────────────→  │ → default: "sonnet" │  $MODEL      │          │
└──────────────┘                  └─────────────────────┘              └──────────┘
```

**モデル決定フロー（Task Executor内）:**

```typescript
// kanban runtime-api.ts からの移植パターン
function resolveModel(task: GitHubTask): string {
  // 1. Task に明示指定があればそれを使う
  if (task.model) return task.model;

  // 2. 2フェーズ実行の場合、フェーズに応じて切替
  if (task.phase === "plan") return "claude-opus-4-6";
  if (task.phase === "execute") return "claude-sonnet-4-6";

  // 3. デフォルト: sonnet（コスト効率）
  return "claude-sonnet-4-6";
}

// Claude Code 起動時に --model フラグ注入
const args = ["--print", "--permission-mode", "bypassPermissions"];
args.push("--model", resolveModel(task));
```

**コスト影響（参考）:**

| モデル | 入力       | 出力     | Task 3pt (1.5h) 想定コスト |
| ------ | ---------- | -------- | -------------------------- |
| opus   | $15/MTok   | $75/MTok | ~$3-5                      |
| sonnet | $3/MTok    | $15/MTok | ~$0.6-1                    |
| haiku  | $0.80/MTok | $4/MTok  | ~$0.15-0.3                 |

2フェーズ実行（Plan=opus 30min + Execute=sonnet 1h）で、全工程opusの約40%のコストに。

---

## 6. スプリント運用フロー

### 月曜 06:00 — Sprint Planning（自動）

```
スクラムエージェント:
1. 前Sprint の未完了Taskを確認 → 自動キャリーオーバー
2. Backlog の Issue（親）から、未完了の Task（Sub Issue）を Priority × SP で並び替え
3. 容量（20pt目安、前Sprintベロシティから調整）まで Task を選択
4. Slack に計画を投稿:
   「Sprint 5 計画（4/7-4/13）
    🎯 容量: 18pt（前Sprint実績: 15pt）
    📋 選択Task:
    ── Issue #40: SynthAgent E2Eテスト基盤構築
      - #42 [3pt] ヘルスチェックAPI E2Eテスト
      - #43 [3pt] チャットAPI E2Eテスト
    ── Issue #41: LP ヒーロー改修
      - #44 [5pt] ヒーローセクション実装
      - #45 [2pt] レスポンシブ対応
    ── Issue #39: OpenClaw cron設定
      - #46 [3pt] cron設定 + Slack通知
    合計: 16pt / 容量: 18pt
    承認しますか？ ✅ / ❌ / 変更あり」
5. Akkey が ✅ → Task を Sprint Board "Ready" に移動
```

### 毎日 08:00 — Daily Standup（自動）

```
スクラムエージェント → Slack #claw:
「📊 Daily Standup（4/8 火）Sprint 5 Day 2/7
  ✅ 昨日完了: #42 ヘルスチェックAPI E2E (3pt) ← Issue #40
  🔄 進行中: #43 チャットAPI E2E (3pt) — PR #51 レビュー中
  📋 次: #44 ヒーローセクション実装 (5pt) ← Issue #41
  ⚠️ ブロッカー: なし
  📉 バーンダウン: 残10pt / 期間残5日 — 順調
  📦 Issue進捗: #40 (2/4 tasks done) | #41 (0/2) | #39 (0/1)」
```

### 2時間ごと — Task Executor（自動）

```
スクラムエージェント:
1. "Ready" カラムにIssueがあるか確認
2. あれば最優先を1つ取得
3. Claude Code起動 → PR作成 → Auto Review
4. なければ何もしない（静かに終了）
```

### 日曜 20:00 — Sprint Review + 品質レビュー（自動）

```
スクラムエージェント:
1. 完了Issue集計 → ベロシティ計算
2. バーンダウン推移を計算
3. 品質メトリクス収集:
   - テストカバレッジ推移
   - lint warnings 数
   - Auto Reviewer検出問題（critical/warning/info）
   - reject率（reject数/全PR数）
   - reject→fix成功率
4. Weeklyノートに自動記入:
   「### Sprint Review
    📊 進捗
    - ベロシティ: 25pt（計画28pt、達成率89%）
    - 完了: #42, #43, #44, #45（4/5 issues）
    - 未完了: #46 freee残仕訳 → 次Sprint carry-over
    - 阻害要因: AWS Japan返信待ちで#44が2日停滞

    🔍 品質レポート
    - PR統計: 12本マージ、リトライ3回
    - テストカバレッジ: 82% → 85%（+3%）
    - lint warnings: 3件（前週比 -2）
    - Auto Reviewer検出: critical 1 / warning 5 / info 2
    - reject率: 20%（2/10 — 正常範囲）
    - reject→fix成功率: 100%（2/2）

    ⚠️ 要Akkey確認（あれば）:
    - #48 アーキテクチャ変更の影響範囲確認推奨」
5. 次Sprint容量推奨: 過去3Sprint移動平均ベロシティ
6. 品質アラート: reject率30%超 or critical検出3件超 → Slack即時通知
```

---

## 7. 実装ロードマップ

### Phase 1: 基盤構築（Week 1）✅ 完了 2026-04-03

- [x] GitHub Projects "AIA Sprint Board" 作成 — 既存ボードを再設定
- [x] Custom Fields設定（Story Points, Sprint(Iteration), Priority, Type, **Model**）
- [x] Issue Templates + Labels セットアップ（全4リポジトリ: synthagent, rag-in-a-box, openclaw-aia, aia-corporate-lp）
- [x] Secrets/Variables 設定（リポジトリレベル × 4リポジトリ、PROJECT_TOKEN, ANTHROPIC_API_KEY, SLACK_BOT_TOKEN, 12 Variables）
- [ ] 既存KANBAN上のタスク・Weeklyノートの未完了タスクをGitHub Issuesに移行

### Phase 2: カード自動遷移 + Auto Review通知（Week 2）✅ 完了 2026-04-03

- [x] GitHub Actions Workflow 5つを3リポジトリに配置（synthagent, rag-in-a-box, openclaw-aia）
  - scrum-task-started.yml（ブランチ作成 → In Progress）
  - scrum-pr-opened.yml（PR作成 → In Review）
  - scrum-auto-review-request.yml（PR作成/push → Slack通知でOpenClawにレビュー依頼）
  - scrum-retry.yml（reject → リトライ/Blocked + Slack通知）
  - scrum-pr-merged.yml（merge → Done + Issue close + Slack通知）
- [x] Auto Reviewの設計変更: GitHub Actions直接Opus API → OpenClaw → Claude Codeに移行
  - GitHub Actionsは通知のみ、レビュー実行はOpenClaw側（Phase 3で実装）
- [x] E2Eテスト完了（rag-in-a-box Issue #1, #3 で検証）
  - Ready → In Progress → In Review → Done 全遷移確認済み
  - Auto Review通知（pull_request イベント）発火確認済み

### Phase 3: Task Executor + skill-scrum 実装（Week 3）✅ 完了 2026-04-03

- [x] `skill-scrum/SKILL.md` — スキル定義（トリガー、アクション、操作分類、Cronジョブ）
- [x] `skill-scrum/handler.ts` — メインハンドラー（status/execute/review/standup ディスパッチ）
- [x] `skill-scrum/lib/github-projects.ts` — GitHub Projects v2 GraphQL APIラッパー
  - Board状態取得、カラム遷移、Issue/PR操作
- [x] `skill-scrum/lib/task-executor.ts` — Ready Task → Claude Code spawn → PR作成
  - モデル自動選択（Task.model指定 > 2フェーズ > デフォルトsonnet）
  - Priority×SPソートで最優先Task選択
- [x] `skill-scrum/lib/auto-reviewer.ts` — Claude Code (opus) でPRレビュー
  - リポジトリ全体コンテキスト付きレビュー（GitHub Actions直接API呼びから移行）
  - approve → auto-merge / reject → scrum-retry.yml連携
- [ ] `skill-claude-code/handler.ts` — 既存SKILL.md設計あり、skill-scrumから呼び出し可能（後回し）
- [ ] OpenClaw cron 設定: task-executor（1時間ごと）
- [ ] Task Executor E2Eテスト（Ready Task → Claude Code → PR → Auto Review → Done）

### Phase 4: スプリント運営（Week 4）✅ 実装完了 2026-04-03

- [x] `skill-scrum/lib/sprint-planner.ts` — Sprint Planning 自動化 + Slack承認フロー
  - Backlog優先度ソート、容量計算、キャリーオーバー、親Issue別グルーピング
  - `plan` → Slack投稿 → `approve-plan` → Ready移動
- [x] `skill-scrum/lib/daily-standup.ts` — Daily Standup レポート + Slack投稿
  - Sprint日数表示、バーンダウン、Issue進捗（n/m tasks done）
- [x] `skill-scrum/lib/sprint-review.ts` — ベロシティ計算 + 品質レポート
  - 達成率、reject率、次Sprint容量推奨（移動平均調整ルール）
- [x] handler.ts に全アクション統合（status/plan/approve-plan/execute/review/standup/sprint-review）
- [x] OpenClaw cron 設定 — EC2 `/home/ubuntu/.openclaw/cron/jobs.json` に4ジョブ登録
  - task-executor（毎時）, standup（平日08:00 JST）, planning（月曜06:00 JST）, review（日曜20:00 JST）
- [x] skill-scrum を EC2 にデプロイ（`/home/ubuntu/openclaw-aia/skills/skill-scrum/`）
- [x] Sprint 1 完了（13FP、達成率100%）— 2026-04-03
  - #3 E2Eテスト (FP5) + #4 handler.ts (FP3) + #5 cron (FP2) + #6 移行確認 (FP2) + #7 ドキュメント (FP2)
  - SP→FP移行: 従来のSP（人間作業時間基準）→ FP（機能複雑度基準）+ AI実行時間見積もりに変更
  - GitHub Projects フィールド名: Story Points → FP に変更済み

### Phase 5: 安定化 + KANBAN廃止（Week 5）

- [x] Sprint 1 の振り返り → FPベース見積もりに移行完了
- [ ] KANBAN systemdサービス停止（`systemctl disable kanban`）
- [ ] skill-kanban をskill-scrumで完全置き換え
- [ ] EC2ディスク回収（/home/ubuntu/kanban/ 削除で数GB回復）
- [ ] ドキュメント整備（SPEC.md更新、運用手順書）

---

## 8. 非開発タスクとの関係

```
【開発タスク】GitHub Projects → スクラムエージェント → Claude Code
【非開発タスク】Paperclip → CEO/Founding Engineer → freee MCP / Obsidian / Slack
```

スクラムエージェントは開発タスク専用。非開発タスク（freee、弁護士、SES）は引き続きPaperclipで管理。

ただし、Daily Standupレポートに非開発タスクの状況も含める（Paperclip APIから取得）ことで、Akkeyの朝の確認を1箇所に集約する。

---

## 9. リスクと対策

| リスク                 | 影響                     | 対策                                     |
| ---------------------- | ------------------------ | ---------------------------------------- |
| GitHub API レート制限  | タスク実行が止まる       | ポーリング間隔を調整、キャッシュ活用     |
| Claude Code の実行失敗 | PRが作れない             | リトライ + Slack通知でAkkeyに報告        |
| 自動マージの事故       | 壊れたコードがmainに入る | テスト必須（CI green でないとmerge不可） |
| ベロシティ計算の精度   | Sprint容量が合わない     | 3Sprint分の移動平均で安定化              |
| EC2停止/リブート       | 全サービス停止           | systemd auto-restart + health check cron |

---

## 10. 成功基準

- [ ] Sprint 1（28pt）が人間介入なし（承認除く）で完走する
- [ ] Daily Standup が毎朝08:00にSlackに自動投稿される
- [ ] Task Executor が1時間ごとにReadyタスクを自動消化する
- [ ] PRの80%以上が自動レビュー→自動マージで完了する
- [ ] 週1品質レビューがWeeklyノートに自動記入される
- [ ] reject率が30%以下を維持する
- [ ] Sprint 3 終了時点でベロシティが安定する（±20%以内）
- [ ] KANBANサービスを停止しても開発が回り続ける
