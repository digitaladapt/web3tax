'use strict';

import fs from 'fs';
import { formatText, formatError, formatSuccess, getRedis, normalizeConfig, normalizeAddresses, runProcess, sha256 } from './functions.mjs';

// endpoint: render the html
export const loadIndex = async () => {
    try {
        return formatText(await fs.promises.readFile('./index.html'));
    } catch (error) {
        console.log(error);
        return formatText('Unable to load page content');
    }
};

// endpoint: kickoff process, start downloading actions from midgard into redis
export const submitAddresses = async (event, context, callback) => {
    let wallets;
    try {
        wallets = normalizeAddresses(event.queryStringParameters);
        //console.log(wallets);
    } catch (errors) {
        callback(null, formatError('Invalid wallet address(es) provided: ' + errors.join(', ')));
        return;
    }

    if (wallets.length < 1) {
        callback(null, formatError('No wallet addresses provided'));
        return;
    }

    const config = normalizeConfig(event.queryStringParameters);

    // we need to ensure the same wallets, with a different config will generate a new report
    // since each option has an effect on the internal report built
    const key = process.env.REDIS_PREFIX + sha256({ wallets: wallets, config: config });

    const redis = await getRedis();

    if (await redis.exists(key + '_status')) {
        await redis.quit();
        callback(null, formatSuccess({key: key, message: 'Process already running'}));
        return;
    }

    callback(null, formatSuccess({key: key, message: 'Processing started'}));

    // running this in the background doesn't seem to work, so we'll wait
    await runProcess(redis, key, wallets, config).catch(async (error) => {
        await redis.set(key + '_status', 'Error: ' + error);
        await redis.expire(key + '_status', process.env.TTL);
        await redis.quit();
    });
};

export const getStatus = async (event) => {
    const key = event.queryStringParameters.key ?? null;

    const redis = await getRedis();

    if (await redis.exists(key + '_status')) {
        const message = await redis.get(key + '_status');
        await redis.quit();
        return formatSuccess({
            ready:   (message === 'Completed' ? 1 : (message.startsWith('Error') ? -1 : 0)),
            message: message,
        });
    }

    await redis.quit();
    return formatError('Unknown key');
};

export const fetchReport = async (event) => {
    const key = event.queryStringParameters.key ?? null;
    const format = event.queryStringParameters.format ?? null;
    const group = event.queryStringParameters.group?.replace(/[^0-9A-Za-z ]+/g, '') ?? null;

    const redis = await getRedis();

    if (await redis.exists(key + '_status')) {
        // get all the transactions (they are currently JSON strings
        const transactions = await redis.lRange(key + '_record', 0, -1);
        await redis.quit();

        let keys  = ['date', 'sellAmount', 'sellCurr', 'buyAmount', 'buyCurr', 'fee', 'feeCurr', 'netAmount', 'netCurr', 'type', 'comment', 'txID'];
        let base  = { netAmount: null, netCuur: null };
        let lines = ['Date,Sent Amount,Sent Currency,Received Amount,Received Currency,Fee Amount,Fee Currency,Net Worth Amount,Net Worth Currency,Label,Description,TxHash'];
        // re-categorize with the correct keywords
        let fix   = {
            find: /,Withdrawal,Sent|,Deposit,Received|,Trade,|,Deposit,|,Withdrawal,|,Staking,|,Lost,/g,
            replace: (found) => {
                switch (found) {
                    case ',Withdrawal,Sent': // label depends on description
                        return ',to_pool,Sent';
                    case ',Deposit,Received': // label depends on description
                        return ',from_pool,Received';
                    case ',Trade,':
                    case ',Deposit,':
                    case ',Withdrawal,':
                        return ',,';
                    case ',Staking,':
                        return ',reward,';
                    case ',Lost,':
                        return ',lost,';
                }
            },
            prepare: (record) => {
                record.date += ' UTC';
                return record;
            }
        };

        switch (format) {
            case 'cointracking':
                keys  = ['type', 'buyAmount', 'buyCurr', 'sellAmount', 'sellCurr', 'fee', 'feeCurr', 'exchange', 'tradeGroup', 'comment', 'date', 'txID'];
                base  = { exchange: 'ThorChain', tradeGroup: group };
                lines = ['Type,Buy Amount,Buy Currency,Sell Amount,Sell Currency,Fee,Fee Currency,Exchange,Trade-Group,Comment,Date,Tx-ID'];
                // DD.MM.YYYY date format
                fix   = {
                    find: /,(\d{4})-(\d{2})-(\d{2}) |,THOR,|,RUNE-[ETHB1A]{3},/g,
                    replace: (found) => {
                        if (/,(\d{4})-(\d{2})-(\d{2}) /.test(found)) {
                            return found.replace(/,(\d{4})-(\d{2})-(\d{2}) /, ",$3.$2.$1 ");
                        }
                        switch (found) {
                            case ',THOR,':
                                // the only "THOR" coin is THORSwap
                                return ',THOR2,';
                            case ',RUNE-B1A,':
                            case ',RUNE-ETH,':
                                return ',RUNE2,';
                        }
                    },
                    prepare: (record) => record
                };
                break;
            case 'cointracker':
                keys  = ['date', 'buyAmount', 'buyCurr', 'sellAmount', 'sellCurr', 'fee', 'feeCurr', 'type'];
                base  = {};
                lines = ['Date,Received Quantity,Received Currency,Sent Quantity,Sent Currency,Fee Amount,Fee Currency,Tag'];
                // MM/DD/YYYY date format
                // re-categorize with the correct keywords
                fix   = {
                    find: /(\d{4})-(\d{2})-(\d{2}) |,Trade|,Deposit|,Withdrawal|,Staking|,Lost/g,
                        replace: (found) => {
                        if (/(\d{4})-(\d{2})-(\d{2}) /.test(found)) {
                            return found.replace(/(\d{4})-(\d{2})-(\d{2}) /, "$2/$3/$1 ");
                        }
                        switch (found) {
                            case ',Trade':
                            case ',Deposit':
                            case ',Withdrawal':
                                return ',';
                            case ',Staking':
                                return ',staked';
                            case ',Lost':
                                return ',lost';
                        }
                    },
                    prepare: (record) => record
                };
                break;
            // CryptoTaxCalculator is less trivial than originally expected, the first currency column is used for both transfers in and out
            // so we have to put sell/buy there depending on context
            // @see: https://cryptotaxcalculator.io/guides/advanced-manual-csv-import/
            // ideally should do something like an extra line between JSON.parse(record) and lines.push(...), which would decided if baseCurr = buyCurr or sellCurr...
            // how about fix.extra being a callback, which takes a transaction, and sets the baseCurr and such..
            // default fix.extra to a no-op callback, and ensure we set it as such in each other use-case
            // could even make the no-op be a pass-through and simply return the input, so we can do:
            // const transaction = fix.extra(JSON.parse(record));
            case 'cryptotaxcalculator':
                keys  = ['date', 'type', 'baseCurr', 'baseAmount', 'quoteCurr', 'quoteAmount', 'feeCurr', 'fee', 'from', 'to', 'txID', 'comment'];
                base  = { from: null, to: null };
                lines = ['Timestamp (UTC),Type,Base Currency,Base Amount,Quote Currency (Optional),Quote Amount (Optional),Fee Currency (Optional),Fee Amount (Optional),From (Optional),To (Optional),ID (Optional),Description (Optional)'];
                fix   = {
                    find: '',
                    replace: '',
                    prepare: (record) => {
                        // DD/MM/YYYY date format
                        record.date = record.date.replace(/(\d{4})-(\d{2})-(\d{2}) /, "$3/$2/$1 ") + ' UTC';
                        if (record.type === 'Trade') {
                            record.baseCurr    = record.sellCurr;
                            record.baseAmount  = record.sellAmount;
                            record.quoteCurr   = record.buyCurr;
                            record.quoteAmount = record.buyAmount;
                            record.type = 'sell'; // sell indicates it will trigger capital gains, which we want
                            record.from = 'ThorChain';
                            record.to = 'ThorChain';
                        } else {
                            // only trades have both buy and sell, so in this case, base is whatever we have
                            record.baseCurr   = record.buyCurr   ?? record.sellCurr;
                            record.baseAmount = record.buyAmount ?? record.sellAmount;
                            switch (record.type) {
                                case 'Deposit':
                                    record.type = 'transfer-in';
                                    record.to = 'ThorChain';
                                    break;
                                case 'Withdrawal':
                                    record.type = 'transfer-out';
                                    record.from = 'ThorChain';
                                    break;
                                case 'Staking':
                                    record.type = 'staking';
                                    record.to = 'ThorChain';
                                    break;
                                case 'Lost':
                                    record.type = 'lost';
                                    record.from = 'ThorChain';
                                    break;
                            }
                        }
                        return record;
                    }
                };
                break;
        }

        for (const record of transactions) {
            const transaction = fix.prepare(JSON.parse(record));
            lines.push(keys.map(key => transaction[key] ?? base[key]).join(",").replace(fix.find, fix.replace));
        }
        return formatText(lines.join('\r\n'));
    }

    await redis.quit();
    return formatError('Unknown key');
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
        return formatSuccess({message: 'Successfully purged key'});
    }

    await redis.quit();
    return formatError('Unknown key');
};
