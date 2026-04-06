#!/usr/bin/env bash
# setup-codex.sh
# Claude Code内でCodexを使えるようにセットアップする

set -euo pipefail

echo "======================================"
echo "🔧 Codex Setup for Claude Code"
echo "======================================"
echo ""

# 1. Codexのインストール確認
echo "📦 Step 1/5: Checking Codex installation..."
CODEX_PATH=$(which codex 2>/dev/null || echo "")

if [[ -z "$CODEX_PATH" ]]; then
    echo "❌ Codex is not installed"
    echo ""
    read -p "Install Codex now? (y/n): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "📥 Installing @openai/codex..."
        npm install -g @openai/codex
        CODEX_PATH=$(which codex 2>/dev/null || echo "")
        if [[ -z "$CODEX_PATH" ]]; then
            echo "❌ Installation failed"
            exit 1
        fi
        echo "✅ Codex installed successfully at $CODEX_PATH"
    else
        echo "⚠️  Skipping installation. Please install manually:"
        echo "   npm install -g @openai/codex"
        exit 1
    fi
else
    echo "✅ Codex found at $CODEX_PATH"
fi

echo ""

# 2. Codexログイン状態確認
echo "🔑 Step 2/5: Checking Codex authentication..."
if codex whoami &>/dev/null; then
    echo "✅ Codex is authenticated"
else
    echo "⚠️  Codex is not authenticated"
    echo "   Please run: codex login"
    echo "   (You need a ChatGPT account or OpenAI API key)"
    exit 1
fi

echo ""

# 3. Claude Codeが利用可能か確認
echo "🤖 Step 3/5: Checking Claude Code..."
if ! command -v claude &>/dev/null; then
    echo "❌ Claude Code CLI is not installed"
    echo "   Please install Claude Code first:"
    echo "   npm install -g @anthropic-ai/claude-code"
    exit 1
fi
echo "✅ Claude Code found"

echo ""

# 4. プラグインマーケットプレイス追加（対話的に）
echo "🔌 Step 4/5: Setting up Codex plugin in Claude Code"
echo ""
echo "⚠️  Interactive setup required!"
echo ""
echo "Please run the following commands in a Claude Code session:"
echo ""
echo "  1. Start Claude Code:"
echo "     claude"
echo ""
echo "  2. Add the plugin marketplace:"
echo "     /plugin marketplace add openai/codex-plugin-cc"
echo ""
echo "  3. Install the Codex plugin:"
echo "     /plugin install codex@openai-codex"
echo ""
echo "  4. Reload plugins:"
echo "     /reload-plugins"
echo ""
echo "  5. Verify setup:"
echo "     /codex:setup"
echo ""

read -p "Press Enter after completing the above steps..."

echo ""

# 5. 完了メッセージ
echo "======================================"
echo "✅ Setup Complete!"
echo "======================================"
echo ""
echo "Available Codex commands in Claude Code:"
echo "  /codex:review              - Run Codex code review"
echo "  /codex:adversarial-review  - Challenge review"
echo "  /codex:rescue              - Delegate task to Codex"
echo "  /codex:status              - Check Codex job status"
echo "  /codex:result              - Get Codex result"
echo "  /codex:cancel              - Cancel Codex job"
echo ""
echo "📚 Documentation:"
echo "  https://github.com/openai/codex-plugin-cc"
echo ""
