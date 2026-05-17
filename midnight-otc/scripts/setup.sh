#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Setup script for MidnightOTC hackathon project
# Run: bash scripts/setup.sh
# ─────────────────────────────────────────────────────────────────────────────

set -e

echo "🌙 MidnightOTC Setup"
echo "────────────────────"

# Check prerequisites
check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo "❌ $1 is not installed. Please install it and re-run."
    exit 1
  fi
  echo "✓ $1 found"
}

check_cmd node
check_cmd npm
check_cmd docker

# Node version check
NODE_VERSION=$(node -v | cut -d'.' -f1 | tr -d 'v')
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "❌ Node.js 18+ required (found v${NODE_VERSION})"
  exit 1
fi
echo "✓ Node.js version OK"

# Copy env file if it doesn't exist
if [ ! -f .env ]; then
  cp .env.example .env
  echo "✓ Created .env from .env.example (mock mode enabled by default)"
else
  echo "ℹ .env already exists, skipping"
fi

# Install all dependencies
echo ""
echo "📦 Installing dependencies..."
npm install

echo ""
echo "✅ Setup complete!"
echo ""
echo "Quick start (mock mode — no Midnight node needed):"
echo "  npm run dev"
echo "  → Frontend: http://localhost:3000"
echo "  → Relayer:  ws://localhost:3001"
echo ""
echo "Full Midnight local node:"
echo "  docker-compose up"
echo "  Then update .env: NEXT_PUBLIC_USE_MOCK=false"
echo "  Then: npm run deploy:local && npm run dev"
echo ""
echo "Run tests:"
echo "  npm test"
