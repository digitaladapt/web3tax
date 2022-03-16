#!/bin/bash

# find all related active redis keys and delete them

redis-cli --scan --pattern live_* | xargs redis-cli del

