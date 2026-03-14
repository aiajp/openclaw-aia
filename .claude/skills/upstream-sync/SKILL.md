---
name: upstream-sync
description: Fetch and merge upstream openclaw/openclaw changes with conflict detection and AIA-safe merge
disable-model-invocation: true
---

# Upstream Sync

OpenClaw本家（openclaw/openclaw）の最新変更をAIAフォークにマージする。

## Parameters

- `dry-run` (optional): マージせずに差分のみ表示する
- `target-branch` (optional): マージ先ブランチ。デフォルト: `main`

## Pre-flight Checks

1. ワーキングツリーがクリーンであることを確認（`git status --porcelain`）
2. upstream リモートが設定されていることを確認
3. 現在のブランチが `main` であることを確認

## Sync Steps

```bash
# 1. upstream リモートの確認・設定
git remote get-url upstream 2>/dev/null || git remote add upstream https://github.com/openclaw/openclaw.git

# 2. upstream の最新を取得
git fetch upstream

# 3. 差分サマリを表示
echo "=== Upstream changes since last sync ==="
git log --oneline HEAD..upstream/main | head -30
echo ""
echo "=== Files changed ==="
git diff --stat HEAD..upstream/main
echo ""
echo "=== AIA カスタマイズへの影響チェック ==="
git diff HEAD..upstream/main -- src/core/ src/gateway/ | head -50
```

## Dry-run の場合はここで停止

差分レポートを表示して終了。ユーザーにマージするか確認する。

## Merge Steps（dry-run でない場合）

```bash
# 4. マージブランチを作成
git checkout -b upstream-sync/$(date +%Y%m%d)

# 5. マージ実行
git merge upstream/main --no-edit

# 6. コンフリクト検出
if [ $? -ne 0 ]; then
    echo "=== CONFLICTS DETECTED ==="
    git diff --name-only --diff-filter=U
    echo ""
    echo "コンフリクトを手動で解決してください。"
    echo "解決後: git add . && git commit"
    exit 1
fi

# 7. AIA カスタマイズファイルの確認
echo "=== AIA カスタマイズファイルの状態 ==="
git diff HEAD~1 -- skills/ config/ docs/ CLAUDE.md SPEC.md
```

## AIA Safe Zones

以下のディレクトリ/ファイルはAIA固有のため、upstream変更とのコンフリクトに注意:

- `skills/skill-claude-code/`
- `skills/skill-freee/`
- `skills/skill-obsidian/`
- `config/`
- `docs/setup.md`
- `CLAUDE.md` (AGENTS.mdへのsymlink)
- `SPEC.md`
- `.claude/`

## Post-merge

1. `pnpm install` で依存関係を更新
2. `pnpm build` でビルド確認
3. `pnpm test` でテスト実行
4. 問題なければ `main` にマージ: `git checkout main && git merge upstream-sync/$(date +%Y%m%d)`
