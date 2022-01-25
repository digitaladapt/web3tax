#!/bin/bash

while true; do \
REDIS_ENDPOINT=localhost:6379 \
MIDGARD_LIMIT=50 \
MIDGARD_URL='https://midgard.thorchain.info/v2/actions?limit=50&address={WALLETS}&offset={OFFSET}' \
PORT=3001 \
TTL=60 \
node server.mjs 2>&1 | tee -a output-test.log; \
echo '--- Restarting ---'; \
done

