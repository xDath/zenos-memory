#!/usr/bin/env bash
# Deploy Zenos Memory to Vercel.
# Usage: ./scripts/deploy-vercel.sh [vercel-token|@/path/to/token-file]

set -euo pipefail

echo "Deploying Zenos Memory to Vercel..."

if [ "$#" -eq 0 ]; then
  npx vercel --prod --yes
else
  token="$1"
  if [[ "${token}" == @* ]]; then
    token_file="${token#@}"
    [[ -r "${token_file}" ]] || {
      echo "Vercel token file is not readable: ${token_file}" >&2
      exit 1
    }
    token="$(<"${token_file}")"
  fi
  [[ -n "${token}" ]] || {
    echo "Vercel token is empty." >&2
    exit 1
  }
  export VERCEL_TOKEN="${token}"
  unset token
  npx vercel --prod --yes
fi

echo "Deployment complete."
echo "Required production variable names are documented in CREDENTIALS.md."
echo "Never place credential values or Drive identifiers in this script or Git history."
