#!/bin/bash

# Summary:
# script expects to be run from project folder
# we use the redis identified by the endpoint
# all records use a prefix to avoid collision with anything else using redis
# midgard pages results (max 50)
# we have to point to a Midgard instance (data provider)
# possible values:
# Official Midgard   # https://midgard.thorchain.info/v2/actions?limit=50&address={WALLETS}&offset={OFFSET}
# NineRealms Midgard # https://midgard.ninerealms.com/v2/actions?limit=50&address={WALLETS}&offset={OFFSET}
# port: tcp port to bind, for web interface and api calls (in production, you'd want a proxy like nginx to handle https)
# ttl: time-to-live (in seconds); production 7200 (2 hours), test 120 (2 minutes)

cd "$(dirname "$0")" || exit

REDIS_ENDPOINT=localhost:6379 \
REDIS_PREFIX='live_' \
MIDGARD_LIMIT=50 \
MIDGARD_URL='https://midgard.ninerealms.com/v2/actions?limit=50&address={WALLETS}&offset={OFFSET}' \
THORNODE_LIMIT=50 \
THORNODE_URL='https://thornode.ninerealms.com/txs?limit=50&message.action=send&transfer.{DIRECTION}={WALLET}&page={PAGE}' \
chihuahua_LIMIT=50 \
chihuahua_URL='https://lcd-chihuahua.cosmostation.io/cosmos/tx/v1beta1/txs?pagination.limit=50&pagination.offset={OFFSET}&events={DIRECTION}=%27{WALLET}%27' \
PORT=3000 \
TTL=7200 \
/usr/bin/env node server.mjs 2>&1 | tee -a output.log; \
