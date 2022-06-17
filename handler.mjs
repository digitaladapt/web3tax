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
import {ASSET_DECIMAL, BASE_OFFSET} from "./calculations.mjs";
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

export const loadConvert = async () => {
    try {
        return formatText(await fs.promises.readFile('./convert-address.js'));
    } catch (error) {
        console.log(error);
        return formatText('var error = "Unable to load javascript content";');
    }
};

export const loadProof = async () => {
    try {
        return formatText(await fs.promises.readFile('./keybase.txt'));
    } catch (error) {
        console.log(error);
        return formatText('Unable to load keybase content');
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

export const donations = async (event, context, callback) => {
    const redis = await getRedis();

    // serve up whatever data we currently have, so we're always fast
    const updated = Number(await redis.get('timestamp_web3tax_donations'));
    let output = await redis.get('current_web3tax_donations');
    if ( ! output) {
        output = '{"total":null}';
    }
    callback(null, formatSuccess(JSON.parse(output)));

    // if the data we currently have is outdated, fix it
    if (updated + 3600 < Date.now()) {
        const programs = [
            'curl "https://thornode.ninerealms.com/txs?limit=50&message.action=send&transfer.recipient=thor1vkevvt4u0t7yra4xfk79hy7er38462w8yszx8y&page={PAGE}" | jq .txs[].tx.value.msg[].value.amount[].amount,.total_count',
            'curl "https://midgard.thorchain.info/v2/actions?limit=50&offset={OFFSET}&address=thor1vkevvt4u0t7yra4xfk79hy7er38462w8yszx8y,bnb1v54rp3w9h2hlresmvl0msf4vycnvnuc7nyp6cr,bc1ql7a704xh4ptzcvm8lx6r8hwxcmau09dul6yh7y,ltc1qzw06k68yesj62ja0z9p4s527et496tdtstxvs5,qzcxt5hl30yk3w052n3x6wjvky9rwn0p6guz95qmje,0x165d707704716b02c050935F8Ce6E0429C9829e6,DAN3K84Bn697mFK6GJ27EmZVuyop9vNMwZ,terra1t8magaxn4q6jllgx4hregjh4gtn2k96caqmd7p" | jq \'(.actions[].out[].coins[] | select(.asset == "THOR.RUNE").amount),.count\'',
        ];
        let total = 0;
        for (const theProgram of programs) {
            let page = 0;
            let offset = 0;
            let count = -1;
            do {
                offset = page * 50;
                page++;
                const program = theProgram.replace('{PAGE}', String(page)).replace('{OFFSET}', String(offset));
                try {
                    const {stdout} = await execPromise(program);
                    const received = JSON.parse('[' + stdout.replace(/\n/g, ',') + '""]');
                    received.pop(); // blank final element to handle trailing comma
                    count = received.pop(); // last element is total_count
                    for (const element of received) {
                        total += Number(element) / BASE_OFFSET;
                    }
                } catch (error) {
                    // should probably note the error
                    break;
                }
            } while (page * 50 < count);
        }
        await redis.set('current_web3tax_donations', JSON.stringify({ total: total }));
        await redis.set('timestamp_web3tax_donations', Date.now());
    }
};

export const fetchReport = async (event) => {
    const key = event.queryStringParameters.key ?? null;
    const format = event.queryStringParameters.format ?? null;
    const group = event.queryStringParameters.group?.replace(/[^0-9A-Za-z ]+/g, '') ?? null;

    const redis = await getRedis();

    if (await redis.exists(key + '_status')) {
        // get all the transactions (they are currently JSON strings)
        const transactions = await redis.lRange(key + '_record', 0, -1);
        await redis.quit();

        // default to koinly, if no known format specified
        // https://help.koinly.io/en/articles/3662999-how-to-create-a-custom-csv-file-with-your-data
        let keys  = ['date', 'sellAmount', 'sellCurr', 'buyAmount', 'buyCurr', 'fee', 'feeCurr', 'netAmount', 'netCurr', 'type', 'comment', 'txID'];
        let base  = { netAmount: null, netCurr: null };
        let lines = ['Date,Sent Amount,Sent Currency,Received Amount,Received Currency,Fee Amount,Fee Currency,Net Worth Amount,Net Worth Currency,Label,Description,TxHash'];
        let fix   = {
            find: '',
            replace: '',
            prepare: (record) => {
                // suffix date format with UTC
                record.date += ' UTC';
                if (record.comment?.startsWith('Sent to Pool')) {
                    record.type = 'to_pool';
                } else if (record.comment?.startsWith('Received from Pool')) {
                    record.type = 'from_pool';
                } else {
                    switch (record.type) {
                        case 'Trade':
                        case 'Deposit':
                        case 'Withdrawal':
                            record.type = null;
                            break;
                        case 'Staking':
                            record.type = 'reward';
                            break;
                        case 'Lost':
                            record.type = 'lost';
                            break;
                    }
                }
                return record;
            }
        };

        switch (format) {
            // https://help.coinledger.io/en/articles/2584884-manual-import-guide
            // https://help.coinledger.io/en/articles/6028758-universal-manual-import-template-guide
            case 'coinledger':
                keys  = ['date','exchange','sellCurr','sellAmount','buyCurr','buyAmount','feeCurr','fee','type','comment','txID'];
                base  = { exchange: 'thor' };
                lines = ['Date (UTC),Platform (Optional),Asset Sent,Amount Sent,Asset Received,Amount Received,Fee Currency (Optional),Fee Amount (Optional),Type,Description (Optional),TxHash (Optional)'];
                fix   = {
                    find: '',
                    replace: '',
                    prepare: (record) => {
                        // MM/DD/YYYY date format
                        record.date = record.date.replace(/(\d{4})-(\d{2})-(\d{2}) /, "$2/$3/$1 ");
                        // per their instructions, amount sent/received is to include any fees
                        if (record.feeCurr && record.buyCurr && record.feeCurr === record.buyCurr) {
                            record.buyAmount = (Number(record.buyAmount) + Number(record.fee)).toFixed(ASSET_DECIMAL);
                        } else if (record.feeCurr && record.sellCurr && record.feeCurr === record.sellCurr) {
                            record.sellAmount = (Number(record.sellAmount) + Number(record.fee)).toFixed(ASSET_DECIMAL);
                        }
                        switch (record.type) {
                            case 'Other Fee':
                            case 'Lost':
                                record.type = 'Investment Loss';
                                break;
                        }
                        return record;
                    }
                };
                break;
            // https://cointracking.info/import/import_csv/
            case 'cointracking':
                keys  = ['type', 'buyAmount', 'buyCurr', 'sellAmount', 'sellCurr', 'fee', 'feeCurr', 'exchange', 'tradeGroup', 'comment', 'date', 'txID'];
                base  = { exchange: 'thor', tradeGroup: group };
                lines = ['Type,Buy Amount,Buy Currency,Sell Amount,Sell Currency,Fee,Fee Currency,Exchange,Trade-Group,Comment,Date,Tx-ID'];
                fix   = {
                    find: '',
                    replace: '',
                    prepare: (record) => {
                        // DD.MM.YYYY date format
                        record.date.replace(/,(\d{4})-(\d{2})-(\d{2}) /, ",$3.$2.$1 ");
                        for (const curr of ['buyCurr', 'sellCurr', 'feeCurr']) {
                            switch (record[curr]) {
                                case 'THOR':
                                    // the only "THOR" coin is THORSwap
                                    record[curr] = 'THOR2';
                                    break;
                                case 'LUNA':
                                    // the only "LUNA" coin is Terra's Luna
                                    record[curr] = 'LUNA2';
                                    break;
                                case 'RUNE-B1A':
                                case 'RUNE-ETH':
                                    // the only "RUNE" coin is THORChain
                                    record[curr] = 'RUNE2';
                                    break;
                            }
                        }
                        return record;
                    }
                };
                break;
            // https://help.cointracker.io/en/articles/5172429-converting-transaction-history-csvs-to-the-cointracker-csv-format
            case 'cointracker':
                keys  = ['date', 'buyAmount', 'buyCurr', 'sellAmount', 'sellCurr', 'fee', 'feeCurr', 'type'];
                base  = {};
                lines = ['Date,Received Quantity,Received Currency,Sent Quantity,Sent Currency,Fee Amount,Fee Currency,Tag'];
                fix   = {
                    find: '',
                    replace: '',
                    prepare: (record) => {
                        // MM/DD/YYYY date format
                        record.date = record.date.replace(/(\d{4})-(\d{2})-(\d{2}) /, "$2/$3/$1 ");
                        switch (record.type) {
                            case 'Trade':
                            case 'Deposit':
                            case 'Withdrawal':
                                record.type = null;
                                break;
                            case 'Staking':
                                record.type = 'staked';
                                break;
                            case 'Lost':
                                record.type = 'lost';
                                break;
                        }
                        return record;
                    }
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
            // https://help.taxbit.com/hc/en-us/articles/360047756913-Importing-Transactions-Manually-with-a-CSV-File
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
                        if (record.buyCurr) {
                            record.buySource = (record.meta.isCosmosTx ? record.buyCurr : 'THOR') + ' Wallet';
                        }
                        if (record.sellCurr) {
                            record.sellSource = (record.meta.isCosmosTx ? record.sellCurr : 'THOR') + ' Wallet';
                        }
                        switch (record.type) {
                            case 'Deposit':    record.type = 'Transfer In';  break;
                            case 'Withdrawal': record.type = 'Transfer Out'; break;
                            case 'Staking':    record.type = 'Income';       break;
                            case 'Lost':       record.type = 'Expense';      break;
                            case 'Other Fee':  record.type = 'Expense';      break;
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
