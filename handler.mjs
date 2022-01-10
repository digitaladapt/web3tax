'use strict';

import RedisCache from './RedisCache.mjs';
import fetch from 'node-fetch'

const token = (asset) => {
    // convert "BNB.BUSD-BD1" into "BUSD"
    return asset.split('.')[1].split('-')[0];
};

const midgard = async (wallets, pagination) => {
    // const url = "https://midgard/{wallets}?offset={pagination}
    // fetch(url).then
};

export const hello = async (event) => {
  const CACHE_KEY = 'CACHE_KEY'
  let res = {}
  let checkCache = await RedisCache.get(CACHE_KEY)
  if (checkCache) {
    res = checkCache
  } else {
    await RedisCache.set(CACHE_KEY, {'message': 'Hello World!'})
    res = {'message': 'Set cache success!'}
  }

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
