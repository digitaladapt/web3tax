'use strict';

import { formatCSV, formatError, formatSuccess, getRedis, midgard, normalizeConfig, normalizeAddresses, runProcess, sha256 } from './functions.mjs';

// keep process promise in memory
let processPromise = null;

// endpoint: kickoff process, start downloading actions from midgard into redis
export const submitAddresses = async (event) => {
    let wallets;
    try {
        wallets = normalizeAddresses(event.queryStringParameters);
        //console.log(wallets);
    } catch (errors) {
        return formatError('Invalid Wallet Address(es) Provided: ' + errors.join(', '));
    }

    if (wallets.length < 1) {
        return formatError('No Wallet Addresses Provided');
    }

    const config = normalizeConfig(event.queryStringParameters);

    // we need to ensure the same wallets, with a different config will generate a new report
    // since each option has an effect on the internal report built
    const key = sha256({ wallets: wallets, config: config });

    const redis = await getRedis();

    if (await redis.exists(key + '_status')) {
        await redis.quit();
        return formatSuccess({key: key, message: 'Process Already Running'});
    }

    // running this in the background doesn't seem to work, so we'll wait
    processPromise = runProcess(redis, key, wallets, config);

    return formatSuccess({key: key, message: 'Processing Started'});
};

export const getStatus = async (event) => {
    const key = event.queryStringParameters.key ?? null;

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

        let keys  = ['date', 'sellAmount', 'sellCurr', 'buyAmount', 'buyCurr', 'fee', 'feeCurr', 'netAmount', 'netCurr', 'type', 'comment', 'txID'];
        let base  = { netAmount: null, netCuur: null };
        let lines = ['Date,Sent Amount,Sent Currency,Received Amount,Received Currency,Fee Amount,Fee Currency,Net Worth Amount,Net Worth Currency,Label,Description,TxHash'];
        // re-categorize with the correct keywords
        let fix   = { find: /,Withdrawal,Sent|,Deposit,Received|,Trade,|,Deposit,|,Withdrawal,|,Income,|,Lost,/g, replace: (found) => {
            switch (found) {
                case ',Withdrawal,Sent': // label depends on description
                    return ',to_pool,Sent';
                case ',Deposit,Received': // label depends on description
                    return ',from_pool,Received';
                case ',Trade,':
                case ',Deposit,':
                case ',Withdrawal,':
                    return ',,';
                case ',Income,':
                    return ',realized gain,';
                case ',Lost,':
                    return ',lost,';
            }
        }};

        switch (format) {
            case 'cointracking':
                keys  = ['type', 'buyAmount', 'buyCurr', 'sellAmount', 'sellCurr', 'fee', 'feeCurr', 'exchange', 'tradeGroup', 'comment', 'date', 'txID'];
                base  = { exchange: 'ThorChain' };
                lines = ['Type,Buy Amount,Buy Currency,Sell Amount,Sell Currency,Fee,Fee Currency,Exchange,Trade-Group,Comment,Date,Tx-ID'];
                // DD.MM.YYYY date format
                fix   = { find: /,(\d{4})-(\d{2})-(\d{2}) /g, replace: ",$3.$2.$1 " };
                break;
            case 'cointracker':
                keys  = ['date', 'buyAmount', 'buyCurr', 'sellAmount', 'sellCurr', 'fee', 'feeCurr', 'type'];
                base  = {};
                lines = ['Date,Received Quantity,Received Currency,Sent Quantity,Sent Currency,Fee Amount,Fee Currency,Tag'];
                // MM/DD/YYYY date format
                // re-categorize with the correct keywords
                fix   = { find: /(\d{4})-(\d{2})-(\d{2}) |,Trade|,Deposit|,Withdrawal|,Income|,Lost/g, replace: (found) => {
                    if (/(\d{4})-(\d{2})-(\d{2}) /.test(found)) {
                        return found.replace(/(\d{4})-(\d{2})-(\d{2}) /, "$2/$3/$1 ");
                    }
                    switch (found) {
                        case ',Trade':
                        case ',Deposit':
                        case ',Withdrawal':
                            return ',';
                        case ',Income':
                            return ',staked';
                        case ',Lost':
                            return ',lost';
                    }
                }};
                break;
        }

        for (const record of transactions) {
            const transaction = JSON.parse(record);
            lines.push(keys.map(key => transaction[key] ?? base[key]).join(",").replace(fix.find, fix.replace));
        }
        return formatCSV(lines.join('\r\n'));
    }

    await redis.quit();
    return formatError('Unknown Key');
};

export const purgeReport = async (event) => {
    const key = event.queryStringParameters.key ?? null;

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
