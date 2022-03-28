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
# test has extra flags in node command to detect errors and trace them to their source

cd "$(dirname "$0")" || exit

REDIS_ENDPOINT=localhost:6379 \
REDIS_PREFIX='test_' \
MIDGARD_LIMIT=50 \
MIDGARD_URL='https://midgard.ninerealms.com/v2/actions?limit=50&address={WALLETS}&offset={OFFSET}' \
THORNODE_LIMIT=50 \
THORNODE_URL='https://thornode.ninerealms.com/txs?limit=50&message.action=send&transfer.{DIRECTION}={WALLET}&page={PAGE}' \
chihuahua_LIMIT=100 \
chihuahua_URL='https://lcd-chihuahua.cosmostation.io/cosmos/tx/v1beta1/txs?pagination.limit=100&pagination.offset={OFFSET}&events={DIRECTION}%3D%27{WALLET}%27' \
chihuahua_NODES='https://api.chihuahua.wtf/cosmos/staking/v1beta1/validators?pagination.limit=500' \
cerberus_LIMIT=100 \
cerberus_URL='https://lcd-cerberus.cosmostation.io/cosmos/tx/v1beta1/txs?pagination.limit=100&pagination.offset={OFFSET}&events={DIRECTION}%3D%27{WALLET}%27' \
cerberus_NODES='https://lcd-cerberus.cosmostation.io/cosmos/staking/v1beta1/validators?pagination.limit=500' \
PORT=3001 \
TTL=600 \
/usr/bin/env node --trace-warnings --unhandled-rejections=strict server.mjs 2>&1 | tee -a output-test.log
