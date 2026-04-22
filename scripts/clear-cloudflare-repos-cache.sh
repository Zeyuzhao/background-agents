#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: clear-cloudflare-repos-cache.sh [options]

Clear the control-plane repository cache from the remote Cloudflare KV namespace.

By default this deletes:
  - repos:list
  - all github:installation-token:v1:* keys

Options:
  --namespace-id <id>    Use an explicit KV namespace id instead of terraform output.
  --terraform-dir <dir>  Terraform dir to read session_index_kv_id from.
                         Default: terraform/environments/production
  --local                Operate on local Wrangler KV instead of remote.
  --dry-run              Print keys that would be deleted without deleting them.
  -h, --help             Show this help text.
EOF
}

require_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "Required command not found: $name" >&2
    exit 1
  fi
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TERRAFORM_DIR="$REPO_ROOT/terraform/environments/production"
KV_NAMESPACE_ID=""
RESOURCE_FLAG="--remote"
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace-id)
      KV_NAMESPACE_ID="${2:?Missing value for --namespace-id}"
      shift 2
      ;;
    --terraform-dir)
      TERRAFORM_DIR="${2:?Missing value for --terraform-dir}"
      shift 2
      ;;
    --local)
      RESOURCE_FLAG="--local"
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$KV_NAMESPACE_ID" ]]; then
  require_command terraform
  if [[ ! -d "$TERRAFORM_DIR" ]]; then
    echo "Terraform directory not found: $TERRAFORM_DIR" >&2
    exit 1
  fi

  KV_NAMESPACE_ID="$(
    cd "$TERRAFORM_DIR"
    terraform output -raw session_index_kv_id
  )"
fi

if [[ -z "$KV_NAMESPACE_ID" ]]; then
  echo "Failed to resolve session_index_kv_id" >&2
  exit 1
fi

require_command jq
require_command npx

WRANGLER=(npx wrangler kv key)
REPO_CACHE_KEY="repos:list"
TOKEN_CACHE_PREFIX="github:installation-token:v1:"

echo "Using KV namespace: $KV_NAMESPACE_ID"
echo "Resource location: ${RESOURCE_FLAG#--}"

delete_key() {
  local key="$1"

  if [[ "$DRY_RUN" == true ]]; then
    echo "[dry-run] would delete: $key"
    return
  fi

  "${WRANGLER[@]}" delete "$key" --namespace-id "$KV_NAMESPACE_ID" "$RESOURCE_FLAG"
}

echo
echo "Clearing repo list cache key"
delete_key "$REPO_CACHE_KEY"

echo
echo "Listing GitHub installation token cache keys"
TOKEN_KEYS="$("${WRANGLER[@]}" list --namespace-id "$KV_NAMESPACE_ID" "$RESOURCE_FLAG" --prefix "$TOKEN_CACHE_PREFIX")"

TOKEN_KEY_NAMES="$(printf '%s' "$TOKEN_KEYS" | jq -r '.[].name')"

if [[ -z "$TOKEN_KEY_NAMES" ]]; then
  echo "No GitHub installation token cache keys found."
else
  while IFS= read -r key; do
    [[ -n "$key" ]] || continue
    delete_key "$key"
  done <<< "$TOKEN_KEY_NAMES"
fi

echo
if [[ "$DRY_RUN" == true ]]; then
  echo "Dry run complete."
else
  echo "Cloudflare repo cache cleared."
fi
