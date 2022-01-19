'use strict';

import { formatError, formatSuccess, getRedis, midgard, normalizeAddresses, runProcess, sha256 } from './functions.mjs';

// endpoint: kickoff process, start downloading actions from midgard into redis
export const submitAddresses = async (event) => {
    let wallets;
    try {
        wallets = normalizeAddresses(event.queryStringParameters);
        //console.log(wallets);
    } catch (errors) {
        return formatError('Invalid Wallet Address(es) provided: ' + errors.join(', '));
    }

    const key = sha256(wallets);

    const redis = await getRedis();

    if (await redis.exists(key + '_status')) {
        await redis.quit();
        return formatSuccess({key: key, message: 'Already Generated'});
    }

    // running this in the background doesn't seem to work, so we'll wait
    await runProcess(redis, key, wallets);

    return formatSuccess({key: key, message: 'Processing Completed'});
};

export const fetchReport = async (event) => {
    const key = event.queryStringParameters.key ?? null;
    // also get any options like format

    const redis = await getRedis();

    if (await redis.exists(key + '_status')) {
        // TODO for each row into needed format...
        //console.log('results:', await redis.lLen(key + '_record'));
        const transactions = await redis.lRange(key + '_record', 0, -1);
        await redis.quit();
        return formatSuccess({
            transactions: transactions,
        });
    }

    await redis.quit();
    return formatError('Unknown Key');
};

export const purgeReport = async (event) => {
    const key = event.queryStringParameters.key ?? null;
    // also get any options like format

    const redis = await getRedis();

    if (await redis.exists(key + '_status')) {
        redis.del(key);
        redis.del(key + '_status');
        redis.del(key + '_count');
        redis.del(key + '_record');

        await redis.quit();
        return formatSuccess({message: 'Sucessfully Purged'});
    }

    await redis.quit();
    return formatError('Unknown Key');
};
