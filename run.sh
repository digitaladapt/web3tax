#!/bin/bash

while true; do \
REDIS_ENDPOINT=localhost:6379 \
MIDGARD_LIMIT=50 \
MIDGARD_URL='https://midgard.thorchain.info/v2/actions?limit=50&address={WALLETS}&offset={OFFSET}' \
node server.mjs 2>&1 | tee -a output.log; \
echo '--- Restarting ---'; \
done

