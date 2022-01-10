'use strict';

import { createClient } from 'redis';
import fetch from 'node-fetch';

// return a redis client
const getRedis = async () => {
    // get config from environment
    const [redisHost, redisPort] = process.env.REDIS_ENDPOINT.split(':');

    const client = createClient({
        socket: {
            host: redisHost,
            port: redisPort
        }
    });

    client.on('error', (error) => {
        console.log('Redis Client Error:', error);
    });

    await client.connect();

    return client;
};

const token = (asset) => {
    // convert "BNB.BUSD-BD1" into "BUSD"
    return asset.split('.')[1].split('-')[0];
};

const midgard = async (wallets, pagination) => {
    // TODO
    // const url = "https://midgard/{wallets}?offset={pagination}
    // fetch(url).then
};

export const hello = async (event) => {
    let res = {}

    const redis = await getRedis();
    if (await redis.exists('CACHE_KEY')) {
        // exists
        res = await redis.get('CACHE_KEY');
    } else {
        // does NOT exist
        res = await redis.set('CACHE_KEY', JSON.stringify({'message': 'Hello World!'}));
    }
    await redis.quit();

    return {
        statusCode: 200,
        body: JSON.stringify(
            {
                message: 'Go Serverless v1.0! Your function executed successfully!',
                res: res,
                input: event,
            },
            null,
            2
        ),
    };

    // Use this code if you don't use the http event with the LAMBDA-PROXY integration
    // return { message: 'Go Serverless v1.0! Your function executed successfully!', event };
};
