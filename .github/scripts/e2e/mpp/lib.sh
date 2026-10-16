# Shared plumbing for the MPP e2e client scripts. Source this, then call:
#
#   rpc <method> <params-json>   a JSON-RPC call against the chain
#   new_payer                    sets PAYER_KEY and PAYER_ADDR to a fresh
#                                throwaway key, faucet-funded with OUSD and
#                                pathUSD (the faucet gives no USDC.e)
#   assert_http_200 <file>       asserts the captured response is a 200
#   verify_settlement <file> [token]
#                                reads the payment-receipt header out of the
#                                captured response and proves the referenced
#                                transaction settled on chain, moving `token`
#                                when one is given

RPC="${MPP_RPC_URL:-https://rpc.moderato.tempo.xyz}"
URL="http://localhost:8080/res/v1/web/search?q=tempo+moderato"
# Two of the tokens the server offers on Moderato, the two the faucet funds.
PATH_USD="0x20c0000000000000000000000000000000000000"
OUSD="0x20c0000000000000000000006a37DA5C996874BE"

rpc() {
  curl -sf -m 15 -X POST "$RPC" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}"
}

new_payer() {
  # The guard is load-bearing: a second --no-save install into the same
  # node_modules prunes the first one's dependency tree.
  node -e 'require.resolve("viem/accounts")' 2> /dev/null \
    || npm install --no-save --no-audit --no-fund --loglevel=error viem
  PAYER_KEY="0x$(openssl rand -hex 32)"
  PAYER_ADDR=$(PAYER_KEY="$PAYER_KEY" node -e \
    'console.log(require("viem/accounts").privateKeyToAccount(process.env.PAYER_KEY).address)')
  echo "payer: $PAYER_ADDR"

  rpc tempo_fundAddress "[\"$PAYER_ADDR\"]" > /dev/null

  # Both funded tokens are paid with, so wait until both have landed.
  local ousd=0 path_usd=0
  for _ in $(seq 1 30); do
    ousd=$(balance_of "$OUSD")
    path_usd=$(balance_of "$PATH_USD")
    if [ "$ousd" -gt 0 ] && [ "$path_usd" -gt 0 ]; then
      echo "funded: $ousd OUSD and $path_usd pathUSD base units"
      break
    fi
    sleep 2
  done
  [ "$ousd" -gt 0 ] && [ "$path_usd" -gt 0 ] \
    || { echo "faucet never funded $PAYER_ADDR" >&2; return 1; }
}

# The payer's balance of the token at $1, in base units.
balance_of() {
  echo $(($(rpc eth_call "[{\"to\":\"$1\",\"data\":\"0x70a08231000000000000000000000000${PAYER_ADDR#0x}\"},\"latest\"]" | jq -re .result)))
}

# Clients echo the status line differently: mppx keeps the wire form
# "HTTP/1.1 200 OK", tempo request collapses it to "HTTP 200".
assert_http_200() {
  grep -Eq "^HTTP(/[0-9.]+)? 200" "$1" \
    || { echo "the paid request did not return 200" >&2; return 1; }
  echo "paid request returned 200"
}

verify_settlement() {
  local tx
  tx=$(python3 - "$1" <<'EOF'
import base64, json, re, sys

text = open(sys.argv[1]).read()
match = re.search(r"(?im)^payment-receipt:\s*(\S+)", text)
assert match, "no payment-receipt header in the response"
header = match.group(1)
receipt = json.loads(base64.b64decode(header + "=" * (-len(header) % 4)))
assert receipt["status"] == "success", receipt
print(receipt["reference"])
EOF
  )
  local receipt block
  receipt=$(rpc eth_getTransactionReceipt "[\"$tx\"]")
  block=$(jq -re 'select(.result.status == "0x1") | .result.blockNumber' <<< "$receipt")
  if [ -n "${2:-}" ]; then
    jq -re --arg token "$2" \
      'any(.result.logs[]; (.address | ascii_downcase) == ($token | ascii_downcase))' \
      <<< "$receipt" > /dev/null \
      || { echo "$tx moved no $2" >&2; return 1; }
  fi
  echo "settled on chain: $tx in block $((block))"
  echo "  https://explore.testnet.tempo.xyz/receipt/$tx"
}
