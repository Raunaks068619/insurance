#!/usr/bin/env bash
set -e

# Check Node version
NODE_VERSION=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$NODE_VERSION" ] || [ "$NODE_VERSION" -lt 22 ]; then
  echo "Node.js 22+ is required. Current: $(node -v 2>/dev/null || echo 'not found')"
  echo "Install from https://nodejs.org"
  exit 1
fi

# Ensure pnpm is available
if ! command -v pnpm &>/dev/null; then
  echo "Installing pnpm..."
  npm install -g pnpm
fi

# Install dependencies
pnpm install

# Start the server (seeds the DB automatically on boot)
pnpm start
