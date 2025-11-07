#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/config-generator"

if ! command -v bun &> /dev/null; then
    echo "❌ Error: Bun is not installed"
    echo "   Install: curl -fsSL https://bun.sh/install | bash"
    exit 1
fi

if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    bun install
    echo ""
fi

bun run generator.ts
