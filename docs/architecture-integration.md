# OpenClaw × Kanban × SynthAgent 統合アーキテクチャ

## システム関係図

```
┌─────────────────────────────────────────────────────────────────┐
│                        Akkey (Slack)                            │
└──────────────────────────┬──────────────────────────────────────┘
                           │ Slack Events API
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  OpenClaw Gateway (EC2常駐)                                     │
│  ─────────────────────────                                      │
│  責務: メッセージルーティング、Claude API呼び出し、             │
│        セッション管理、スキル実行                                │
│                                                                 │
│  エージェント起動方式:                                           │
│    ① embedded — Gateway内でClaude APIを直接呼び出し             │
│    ② acp     — ACP (Agent Control Protocol) 経由で外部エージェント│
│                                                                 │
│  拡張: Plugin SDK → registerAcpRuntimeBackend()                 │
└────────┬───────────────────┬────────────────────────────────────┘
         │                   │
         │ ① embedded        │ ② ACP (stdio JSON-RPC)
         ▼                   ▼
┌─────────────────┐  ┌──────────────────────────────────────────┐
│  Claude API     │  │  ACP Runtime Backend (プラグイン)         │
│  (Bedrock等)    │  │  ──────────────────────                   │
│                 │  │  SynthAgent用カスタムバックエンドを        │
│  haiku/sonnet/  │  │  registerAcpRuntimeBackend() で登録       │
│  opus           │  │                                           │
└─────────────────┘  │  内部で HTTP → SynthAgent API を呼び出し  │
                     └──────────────────┬───────────────────────┘
                                        │ HTTP POST
                                        ▼
┌─────────────────────────────────────────────────────────────────┐
│  SynthAgent (FastAPI HTTP Server)                               │
│  ─────────────────────────────                                  │
│  責務: RAG検索、LLMルーティング、顧客別エージェント応答        │
│                                                                 │
│  プロトコル:                                                     │
│    POST /v1/agent/chat         — 同期チャット                    │
│    POST /v1/agent/chat/stream  — SSEストリーミング               │
│    POST /v1/a2a/invoke         — Agent-to-Agent (将来)           │
│    POST /v1/mcp/*              — MCP ツール連携 (将来)           │
│                                                                 │
│  認証: x-api-key ヘッダー (sa_live_... / sa_test_...)           │
└─────────────────────────────────────────────────────────────────┘

         ── 別系統 ──

┌─────────────────────────────────────────────────────────────────┐
│  Kanban (Vite + React ボード UI)                                │
│  ───────────────────────────────                                │
│  責務: タスク管理、マルチエージェント並列実行、                  │
│        worktree隔離、PTYターミナル                               │
│                                                                 │
│  エージェント起動: CLI binary → PTY spawn                       │
│  通信: tRPC + WebSocket (ブラウザ↔サーバー)                     │
│                                                                 │
│  SynthAgent連携: synthagent-cli ラッパー経由                    │
│    (PTYモデル → HTTP API ブリッジ)                               │
└─────────────────────────────────────────────────────────────────┘
```

## 3システムの責務境界

### OpenClaw — 指揮統制（Command & Control）

| 項目                 | 内容                                                          |
| -------------------- | ------------------------------------------------------------- |
| 核心機能             | Slack→Claude API→Skills のメッセージパイプライン              |
| エージェント管理     | `AgentConfig` (YAML) + ACP Runtime Backend                    |
| 外部エージェント統合 | `registerAcpRuntimeBackend()` Plugin SDK                      |
| セッション識別       | `agent:<id>:subagent:<uuid>` / `agent:<id>:acp:<uuid>`        |
| 制約                 | コアモジュール (`src/core/`, `src/gateway/`) は原則変更しない |

### Kanban — タスク実行基盤（Task Execution Platform）

| 項目             | 内容                                                     |
| ---------------- | -------------------------------------------------------- |
| 核心機能         | Kanbanボード + マルチエージェントPTYオーケストレーション |
| エージェント管理 | `RuntimeAgentCatalog` (TypeScript定数)                   |
| エージェント起動 | PTY spawn (`node-pty`) → CLI binary                      |
| タスク隔離       | Git worktree per task                                    |
| 通信             | tRPC (HTTP) + WebSocket (状態/ターミナルI/O)             |

### SynthAgent — AI応答エンジン（AI Response Engine）

| 項目       | 内容                                                  |
| ---------- | ----------------------------------------------------- |
| 核心機能   | RAG + LLM ルーティング + 顧客別カスタマイズ           |
| プロトコル | REST / SSE / A2A / MCP (すべてHTTP)                   |
| 認証       | API Key (pepper-hashed)                               |
| 依存       | PostgreSQL + pgvector, Redis, AWS (Bedrock/SageMaker) |
| CLIなし    | 純粋HTTPサーバー、`uvicorn` で起動                    |

## 統合パターン

### パターン A: OpenClaw → SynthAgent (推奨)

**方式**: ACP Runtime Backend プラグイン

```
openclaw.yaml:
  agents:
    list:
      - id: synthagent
        runtime:
          type: acp
          acp:
            backend: synthagent-acp  # カスタムバックエンド
            mode: oneshot
```

**実装**: `extensions/synthagent-acp/` に ACP バックエンドとして実装済み

```
extensions/synthagent-acp/
├── openclaw.plugin.json   # プラグインマニフェスト (configSchema含む)
├── package.json
├── index.ts               # プラグインエントリポイント
└── src/
    ├── service.ts          # PluginService (start/stop ライフサイクル)
    └── runtime.ts          # AcpRuntime 実装
                            #   ensureSession → /health で疎通確認、session_id生成
                            #   runTurn → POST /v1/agent/chat/stream → SSE→AcpRuntimeEvent変換
                            #   cancel → AbortController でHTTPリクエスト中断
                            #   doctor → /health + /ready + API key チェック
```

**メリット**:

- openclawのネイティブ拡張方式に準拠
- Gateway経由でセッション管理・認証が統一される
- Slackからの指示がそのままSynthAgentに到達

### パターン B: Kanban → SynthAgent

**方式**: CLIアダプタ (`scripts/synthagent-cli`)

```
kanban agent-catalog:
  id: "synthagent"
  binary: "synthagent-cli"
  → PTY spawn
  → stdin/stdout ←→ HTTP POST /v1/agent/chat/stream
```

**メリット**:

- kanbanの既存PTYモデルを壊さない
- ボードUIからClaude/Codex/Clineと同列で操作可能

**制約**:

- PTY↔HTTP変換のオーバーヘッド
- セッション管理が簡易的（ステートレス）

### パターン C: OpenClaw → Kanban (将来検討)

**方式**: kanbanをopenclawのスキルとして統合

```
skills/skill-kanban/
  → kanban tRPC APIを呼び出し
  → タスク作成・ステータス確認をSlackから操作
```

**ユースケース**:

- 「kanbanに新しいタスクを追加して」→ tRPC workspace.saveState
- 「進行中のタスクを教えて」→ tRPC workspace.getState

## 統合優先順位

| 優先度 | 統合                  | 方式                               | 状態                                                              |
| ------ | --------------------- | ---------------------------------- | ----------------------------------------------------------------- |
| 1      | kanban → SynthAgent   | CLIアダプタ (パターンB)            | ✅ 実装済 (`scripts/synthagent-cli`, `src/core/agent-catalog.ts`) |
| 2      | openclaw → SynthAgent | ACP Backend プラグイン (パターンA) | ✅ 実装済 (`extensions/synthagent-acp/`)                          |
| 3      | openclaw → kanban     | スキル統合 (パターンC)             | ⏳ 未実装                                                         |

## 触ってはいけない境界

| システム   | 変更禁止領域                        | 理由                     |
| ---------- | ----------------------------------- | ------------------------ |
| openclaw   | `src/core/`, `src/gateway/`         | 上流マージ維持           |
| openclaw   | `.github/workflows/`                | 上流CI維持               |
| kanban     | `src/core/api-contract.ts` (上流型) | フォーク同期             |
| SynthAgent | `data-plane/src/api/middleware/`    | 認証・レート制限の整合性 |

## 環境変数マップ

| 変数                  | 使用システム                      | 説明                |
| --------------------- | --------------------------------- | ------------------- |
| `SYNTHAGENT_BASE_URL` | openclaw, kanban (synthagent-cli) | SynthAgent APIのURL |
| `SYNTHAGENT_API_KEY`  | openclaw, kanban (synthagent-cli) | SynthAgent認証キー  |
| `ANTHROPIC_API_KEY`   | openclaw                          | Claude API認証      |
| `SLACK_BOT_TOKEN`     | openclaw                          | Slack Bot OAuth     |
| `KANBAN_DEBUG_MODE`   | kanban                            | デバッグモード      |

## 型の整合性

### RuntimeAgentId (kanban由来)

kanbanの `RuntimeAgentId` は Zod enum で定義。
openclaw-aia の `src/core/api-contract.ts` に AIA拡張として `"synthagent"` を追加済み。

```typescript
// kanban上流: ["claude", "codex", "gemini", "opencode", "droid", "cline"]
// AIA拡張:    + "synthagent"
```

**注意**: この型はkanbanのPTYモデル専用。openclawの `AgentConfig.id` (string型) とは別系統。
openclawでSynthAgentを参照する際は `AgentConfig` の `id: "synthagent"` + `runtime.type: "acp"` を使う。

### AgentConfig (openclaw由来)

```typescript
type AgentRuntimeConfig =
  | { type: "embedded" }          // Claude API直接
  | { type: "acp"; acp?: { ... } } // 外部エージェント (SynthAgent含む)
```

## 決定ログ

| 日付       | 決定                                           | 理由                                              |
| ---------- | ---------------------------------------------- | ------------------------------------------------- |
| 2026-03-27 | kanbanのagent-catalogをsrc/core/に統合         | SynthAgentをkanbanボードから操作可能にするため    |
| 2026-03-27 | SynthAgent連携にCLIアダプタを採用 (kanban向け) | kanbanのPTYモデルとHTTP APIの橋渡しに最小限の変更 |
| 2026-03-27 | openclaw→SynthAgentはACP Backend方式を予定     | openclawネイティブの拡張パターンに準拠            |
