#!/bin/bash

# Summary:
# we use the redis identified by the endpoint
# all records use a prefix to avoid collision with anything else using redis
# midgard pages results (max 50)
# we have to point to a Midgard instance (data provider)
# possible values:
# Official Midgard   # https://midgard.thorchain.info/v2/actions?limit=50&address={WALLETS}&offset={OFFSET}
# NineRealms Midgard # https://midgard.ninerealms.com/v2/actions?limit=50&address={WALLETS}&offset={OFFSET}
# port: tcp port to bind, for web interface and api calls (in production, you'd want a proxy like nginx to handle https)
# ttl: time-to-live (in seconds); production 7200 (2 hours), test 120 (2 minutes)
# non-test version is wrapped in loop-forever, so that it restarts if it crashes.

REDIS_ENDPOINT=localhost:6379 \
REDIS_PREFIX='test_' \
MIDGARD_LIMIT=50 \
MIDGARD_URL='https://midgard.ninerealms.com/v2/actions?limit=50&address={WALLETS}&offset={OFFSET}' \
PORT=3001 \
TTL=120 \
node server.mjs 2>&1 | tee -a output-test.log
