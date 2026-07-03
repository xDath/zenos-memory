#!/bin/bash
# Deploy Zenos Memory to Vercel
# Usage: ./scripts/deploy-vercel.sh [vercel-token]

set -e

echo "🚀 Deploying Zenos Memory to Vercel..."

if [ -z "$1" ]; then
  npx vercel --prod --yes
else
  npx vercel --prod --token "$1" --yes
fi

echo "✅ Deploy done!"
echo ""
echo "Make sure these env vars are set in Vercel Dashboard:"
echo "  GOOGLE_SERVICE_ACCOUNT_KEY= (full JSON as string)"
echo "  ZENOS_MEMORY_DRIVE_FOLDER_ID=15Gsy7dgsanrAZ-6Aq1HIHvjNjAJV51An"
echo "  ZENOS_MEMORY_API_KEY=your-key"
echo "  USE_LOCAL_STORE=false"
