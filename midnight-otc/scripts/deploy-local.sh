#!/usr/bin/env bash
# Deploy OTC contract to local Midnight node (via Docker)
set -e

echo "🌙 Deploying to local Midnight node..."

# Check that the node is running
if ! curl -sf http://localhost:9933/health &>/dev/null; then
  echo "❌ Midnight local node not running."
  echo "   Start it with: docker-compose up midnight-node"
  exit 1
fi

echo "✓ Midnight node is running"

# Compile the Compact contract
echo "📝 Compiling contract..."
cd contracts
npm run compile || {
  echo "❌ Compile failed. Ensure @midnight-ntwrk/compact is installed."
  exit 1
}

# Deploy to local node
echo "🚀 Deploying..."
npm run deploy:local

echo "✅ Contract deployed to local Midnight node"
echo "   Update .env with the CONTRACT_ADDRESS from the output above"
