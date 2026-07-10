#!/usr/bin/env bash
# Deploy Zenos Memory to Vercel.
# Usage: ./scripts/deploy-vercel.sh [vercel-token]

set -euo pipefail

echo "Deploying Zenos Memory to Vercel..."

if [ "$#" -eq 0 ]; then
  npx vercel --prod --yes
else
  npx vercel --prod --token "$1" --yes
fi

echo "Deployment complete."
echo "Required production variable names are documented in CREDENTIALS.md."
echo "Never place credential values or Drive identifiers in this script or Git history."
