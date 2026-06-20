#!/usr/bin/env bash
set -e

# Run from this script's own directory, so it works no matter where it is invoked from.
cd "$(dirname "$0")"

# Check Node version
NODE_VERSION=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$NODE_VERSION" ] || [ "$NODE_VERSION" -lt 22 ]; then
  echo "Node.js 22+ is required. Current: $(node -v 2>/dev/null || echo 'not found')"
  echo "Install from https://nodejs.org"
  exit 1
fi

# Ensure pnpm is available. Prefer corepack (ships with Node 16.13+, no sudo / global
# write needed); fall back to a global npm install only if corepack is unavailable.
if ! command -v pnpm &>/dev/null; then
  echo "pnpm not found — enabling via corepack..."
  corepack enable pnpm 2>/dev/null || npm install -g pnpm
fi

# Install dependencies
pnpm install

# Start the server (seeds the DB automatically on boot)
pnpm start
