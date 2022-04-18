'use strict';

import fs from 'fs';
import {
    formatText,
    formatError,
    formatSuccess,
    getRedis,
    normalizeConfig,
    normalizeAddresses,
    runProcess,
    sha256,
    discord
} from './functions.mjs';
import { exec } from "child_process";
import { promisify } from 'util';
const execPromise = promisify(exec);

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
        // console.log(wallets);
    } catch (errors) {
        if (errors.hasOwnProperty('join')) {
            callback(null, formatError('Invalid wallet address(es) provided: ' + errors.join(', ')));
        } else {
            callback(null, formatError(errors.message));
        }
        return;
    }

    if (wallets.all.length < 1) {
        callback(null, formatError('No wallet addresses provided'));
        return;
    }

    const config = normalizeConfig(event.queryStringParameters);

    // we need to ensure the same wallets, with a different config will generate a new report
    // since each option has an effect on the internal report built
    const key = process.env.REDIS_PREFIX + sha256({ wallets: wallets.all, config: config });

    const redis = await getRedis();

    if (await redis.exists(key + '_status')) {
        await redis.quit();
        console.log('already running|' + Date.now() + '|' + key);
        callback(null, formatSuccess({key: key, message: 'Process already running'}));
        return;
    }

    callback(null, formatSuccess({key: key, message: 'Processing started'}));

    // running this in the background doesn't seem to work, so we'll wait
    console.log('processing|' + Date.now() + '|' + key);
    await runProcess(redis, key, wallets, config).catch(async (error) => {
        await discord("key: " + key + ", had an error: " + JSON.stringify(error));
        console.log(error);
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
    return formatError('Unknown key', null, { ready: -1 });
};

export const findRelated = async (event) => {
    const address = event.queryStringParameters.thor ?? null;
    if (/^thor[a-z0-9]{38,90}$/.test(address)) {
        // get actions performed by this thor wallet, and grep/cut/sort/uniq to pluck out just the interesting bit
        // script expected to return something like: '''"addr1", "addr2",''' (with a trailing comma)
        // should probably process the json in code, but the shell script is fine for now
        const program = 'curl -s "https://midgard.thorchain.info/v2/actions?address={WALLET}" | grep "address" | cut -d \\: -f 2 | sort | uniq | grep -v "thor1"'.replace('{WALLET}', address);
        try {
            const { stdout } = await execPromise(program);
            const wallets = JSON.parse('[' + stdout + '""]');
            wallets.pop(); // blank final element to handle trailing comma
            return formatSuccess({ wallets: wallets });
        } catch (error) {
            return formatError('Unsuccessful Request', null, { wallets: [] });
        }
    }

    return formatError('Invalid Request', null, { wallets: [] });
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

        // default to koinly, if no known format specified
        // https://help.koinly.io/en/articles/3662999-how-to-create-a-custom-csv-file-with-your-data
        let keys  = ['date', 'sellAmount', 'sellCurr', 'buyAmount', 'buyCurr', 'fee', 'feeCurr', 'netAmount', 'netCurr', 'type', 'comment', 'txID'];
        let base  = { netAmount: null, netCurr: null };
        let lines = ['Date,Sent Amount,Sent Currency,Received Amount,Received Currency,Fee Amount,Fee Currency,Net Worth Amount,Net Worth Currency,Label,Description,TxHash'];
        // re-categorize with the correct keywords
        // TODO use the prepare instead of find/replace, better way to handle these changes
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
            // https://cointracking.info/import/import_csv/
            case 'cointracking':
                keys  = ['type', 'buyAmount', 'buyCurr', 'sellAmount', 'sellCurr', 'fee', 'feeCurr', 'exchange', 'tradeGroup', 'comment', 'date', 'txID'];
                base  = { exchange: 'thor', tradeGroup: group };
                lines = ['Type,Buy Amount,Buy Currency,Sell Amount,Sell Currency,Fee,Fee Currency,Exchange,Trade-Group,Comment,Date,Tx-ID'];
                // DD.MM.YYYY date format
                // TODO use the prepare instead of find/replace, better way to handle these changes
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
                            case ',LUNA,':
                                // the only "LUNA" coin is Terra's Luna
                                return ',LUNA2,';
                            case ',RUNE-B1A,':
                            case ',RUNE-ETH,':
                                return ',RUNE2,';
                        }
                    },
                    prepare: (record) => record
                };
                break;
            // https://help.cointracker.io/en/articles/5172429-converting-transaction-history-csvs-to-the-cointracker-csv-format
            case 'cointracker':
                keys  = ['date', 'buyAmount', 'buyCurr', 'sellAmount', 'sellCurr', 'fee', 'feeCurr', 'type'];
                base  = {};
                lines = ['Date,Received Quantity,Received Currency,Sent Quantity,Sent Currency,Fee Amount,Fee Currency,Tag'];
                // MM/DD/YYYY date format
                // re-categorize with the correct keywords
                // TODO use the prepare instead of find/replace, better way to handle these changes
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
            // https://cryptotaxcalculator.io/guides/advanced-manual-csv-import/
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
                            record.from = 'thor';
                            record.to = 'thor';
                        } else {
                            // only trades have both buy and sell, so in this case, base is whatever we have
                            record.baseCurr   = record.buyCurr   ?? record.sellCurr;
                            record.baseAmount = record.buyAmount ?? record.sellAmount;
                            switch (record.type) {
                                case 'Deposit':
                                    record.type = 'transfer-in';
                                    record.to = 'thor';
                                    break;
                                case 'Withdrawal':
                                    record.type = 'transfer-out';
                                    record.from = 'thor';
                                    break;
                                case 'Staking':
                                    record.type = 'staking';
                                    record.to = 'thor';
                                    break;
                                case 'Lost':
                                    record.type = 'lost';
                                    record.from = 'thor';
                                    break;
                            }
                        }
                        return record;
                    }
                };
                break;
            case 'taxbit':
                keys  = ['date', 'type', 'sellAmount', 'sellCurr', 'sellSource', 'buyAmount', 'buyCurr', 'buySource', 'fee', 'feeCurr', 'exchangeID', 'txID'];
                base  = { sellSource: null, buySource: null, exchangeID: null };
                lines = ['Date and Time,Transaction Type,Sent Quantity,Sent Currency,Sending Source,Received Quantity,Received Currency,Receiving Destination,Fee,Fee Currency,Exchange Transaction ID,Blockchain Transaction Hash'];
                fix   = {
                    find: '',
                    replace: '',
                    prepare: (record) => {
                        // YYYY-MM-DDTHH:MM:SSZ date format
                        record.date = record.date.replace(' ', 'T') + 'Z';
                        switch (record.type) {
                            case 'Deposit':
                                record.type = 'Transfer In';
                                record.buySource = record.baseCurr;
                                break;
                            /* TODO: types: Buy, Transfer In, Trade, Transfer Out, Sale, Income, Expense, Gifts */
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
        await redis.del(key + '_action');
        await redis.del(key + '_status');
        await redis.del(key + '_count');
        await redis.del(key + '_record');

        await redis.quit();
        return formatSuccess({message: 'Successfully purged key'});
    }

    await redis.quit();
    return formatError('Unknown key');
};
