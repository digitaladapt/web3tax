'use strict';

import fetch from 'node-fetch';
import { createClient } from 'redis';
import crypto from 'crypto';

// return a connected redis client
export const getRedis = async () => {
    const [redisHost, redisPort] = process.env.REDIS_ENDPOINT.split(':');
    const client = createClient({ socket: {
        host: redisHost,
        port: redisPort
    }});

    client.on('error', (error) => {
        console.log('Redis Client Error:', error);
    });

    await client.connect();

    return client;
};

// gets transactions for specific page for the given wallet list: (["thor1..", "bnb1.."], 3)
// pagination starts with 0 (zero)
// addAction(action) and setCount(count) are callbacks
export const midgard = async (wallets, pagination, addAction, setCount) => {
    const url = process.env.MIDGARD_URL.replace('{WALLETS}', wallets.join(',')).replace('{OFFSET}', pagination * process.env.MIDGARD_LIMIT);
    console.log('url:', url);
    await fetch(url).then((response) => {
        return response.json();
    }).then((data) => {
        setCount(data.count);
        for (const action of data.actions) {
            addAction(action);
        }
    }).catch((error) => {
        console.log(error);
    });
};

// get a key based on the given input
export const sha256 = (input) => {
    return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
};

// FIXME functions below are currently unused

// convert "BNB.BUSD-BD1" into "BUSD"
const token = (asset) => {
    return asset.split('.')[1].split('-')[0];
};

