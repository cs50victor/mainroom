#!/usr/bin/env bash
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_ZONE_ID:?CLOUDFLARE_ZONE_ID is required}"

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <dns-name> [dns-name ...]" >&2
  exit 2
fi

ensure_record() {
  local name="$1"
  local content="100::"
  local records record id current_content current_proxied

  records="$(curl -fsS \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H "Content-Type: application/json" \
    "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records?type=AAAA&per_page=100")"

  record="$(jq -r --arg name "$name" '.result[] | select(.name == $name) | [.id, .content, (.proxied | tostring)] | @tsv' <<<"$records" | head -n 1)"

  if [ -z "$record" ]; then
    jq -nc --arg name "$name" --arg content "$content" \
      '{type:"AAAA", name:$name, content:$content, ttl:1, proxied:true, comment:"Managed by mainroom deploy workflow"}' \
      | curl -fsS -X POST \
        -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
        -H "Content-Type: application/json" \
        --data @- \
        "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records" \
      | jq -e '.success == true' >/dev/null
    echo "created proxied AAAA record for $name"
    return
  fi

  IFS=$'\t' read -r id current_content current_proxied <<<"$record"

  if [ "$current_content" = "$content" ] && [ "$current_proxied" = "true" ]; then
    echo "proxied AAAA record already correct for $name"
    return
  fi

  jq -nc --arg content "$content" '{content:$content, ttl:1, proxied:true}' \
    | curl -fsS -X PATCH \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      -H "Content-Type: application/json" \
      --data @- \
      "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records/$id" \
    | jq -e '.success == true' >/dev/null
  echo "updated proxied AAAA record for $name"
}

for name in "$@"; do
  ensure_record "$name"
done
