'use strict';

import { formatCSV, formatError, formatSuccess, getRedis, midgard, normalizeAddresses, runProcess, sha256 } from './functions.mjs';

// keep process promise in memory
let processPromise = null;

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
        return formatSuccess({key: key, message: 'Processing Already Running'});
    }

    // running this in the background doesn't seem to work, so we'll wait
    processPromise = runProcess(redis, key, wallets);

    return formatSuccess({key: key, message: 'Processing Started'});
};

export const getStatus = async (event) => {
    const key = event.queryStringParameters.key ?? null;
    // also get any options like format

    const redis = await getRedis();

    if (await redis.exists(key + '_status')) {
        const message = await redis.get(key + '_status');
        await redis.quit();
        return formatSuccess({
            ready:   (message === 'Completed'),
            message: message,
        });
    }

    await redis.quit();
    return formatError('Unknown Key');
};

export const fetchReport = async (event) => {
    const key = event.queryStringParameters.key ?? null;
    const format = event.queryStringParameters.format ?? null;

    const redis = await getRedis();

    if (await redis.exists(key + '_status')) {
        // get all the transactions (they are currently JSON strings
        const transactions = await redis.lRange(key + '_record', 0, -1);
        await redis.quit();

        // TODO from here, what do we do to make this the right format for koinly...
        let keys  = [];
        let base  = {};
        let lines = [''];
        let fix   = { find: '', replace: '' };

        switch (format) {
            case 'cointracking':
                keys  = ['type', 'buyAmount', 'buyCurr', 'sellAmount', 'sellCurr', 'fee', 'feeCurr', 'exchange', 'tradeGroup', 'comment', 'date', 'txID'];
                base  = { exchange: 'ThorChain' };
                lines = ['Type,Buy Amount,Buy Currency,Sell Amount,Sell Currency,Fee,Fee Currency,Exchange,Trade-Group,Comment,Date,Tx-ID'];
                fix   = { find: '', replace: '' };
                break;
        }

        for (const record of transactions) {
            const transaction = JSON.parse(record);
            lines.push(keys.map(key => transaction[key] ?? base[key]).join(",").replace(fix.find, fix.replace));
        }
        return formatCSV(lines.join('\n'));
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
