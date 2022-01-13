'use strict';

import fetch from 'node-fetch';
import { createClient } from 'redis';
import crypto from 'crypto';

// format given date as "YYYY-MM-DD HH:MM:SS"
export const formatDate = (date) => {
    // date starts as unix-timestamp in nano-seconds, in timezone 4 hours off
    // 14,400,000 milliseconds (4 hours), to convert to UTC
    // not sure why the timestamps are in Eastern Time
    date = new Date((Number(date) / 1000000) - 14400000);

    return date.getFullYear() + "-" + (date.getMonth() < 9 ? "0" : "") + (date.getMonth() + 1) + "-" + (date.getDate() < 10 ? "0" : "") + date.getDate() + " " + (date.getHours() < 10 ? "0" : "") + date.getHours() + ":" + (date.getMinutes() < 10 ? "0" : "") + date.getMinutes() + ":" + (date.getSeconds() < 10 ? "0" : "") + date.getSeconds();
}

// consistent output formating for api
export const formatError = (message, statusCode) => {
    return {
        statusCode: statusCode ?? 400,
        body: JSON.stringify({
            status: 'error',
            message: message
        })
    };
};

// consistent output formating for api
export const formatSuccess = (content, statusCode) => {
    return {
        statusCode: statusCode ?? 200,
        body: JSON.stringify({
            status: 'success',
            ...content
        })
    };
};

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
    //console.log('url:', url);
    await fetch(url).then((response) => {
        return response.json();
    }).then(async (data) => {
        await setCount(data.count);
        for (const action of data.actions) {
            await addAction(action);
        }
    }).catch((error) => {
        console.log(error);
    });
};

// returns valid addresses in normalized format
// takes object, returns an array
export const normalizeAddresses = (addresses) => {
    let wallets = [];
    let errors  = [];

    loop:
    for (let [type, address] of Object.entries(addresses)) {
        switch (true) {
            case type.startsWith('eth'):
                // ether /^0x[a-f0-9]{40}$/
                address = address.toLowerCase();
                if (/^0x[a-f0-9]{40}$/.test(address)) {
                    wallets.push(address);
                    continue loop;
                }
                break;
            case type.startsWith('btc'):
                // legacy /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/
                // segwit /^bc1[a-z0-9]{38,90}$/
                if (/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) {
                    wallets.push(address);
                    continue loop;
                }
                address = address.toLowerCase();
                if (/^bc1[a-z0-9]{38,90}$/.test(address)) {
                    wallets.push(address);
                    continue loop;
                }
                break;
            case type.startsWith('bch'):
                // legacy /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/
                // normal /^(bitcoincash:)?(q|p)[a-z0-9]{38,90}$/
                if (/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) {
                    wallets.push(address);
                    continue loop;
                }
                address = address.toLowerCase();
                if (/^(bitcoincash:)?(q|p)[a-z0-9]{38,90}$/.test(address)) {
                    wallets.push(address);
                    continue loop;
                }
                break;
            case type.startsWith('bnb'):
                // binance /^bnb[a-z0-9]{38,90}$/
                address = address.toLowerCase();
                if (/^bnb[a-z0-9]{38,90}$/.test(address)) {
                    wallets.push(address);
                    continue loop;
                }
                break;
            case type.startsWith('ltc'):
                // legacy /^[LM3][a-km-zA-HJ-NP-Z1-9]{25,34}$/
                // lower  /^ltc[a-z0-9]{38,90}$/
                if (/^[LM3][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) {
                    wallets.push(address);
                    continue loop;
                }
                address = address.toLowerCase();
                if (/^ltc[a-z0-9]{38,90}$/.test(address)) {
                    wallets.push(address);
                    continue loop;
                }
                break;
            case type.startsWith('thor'):
                // thor /^thor[a-z0-9]{38,90}$/
                address = address.toLowerCase();
                if (/^thor[a-z0-9]{38,90}$/.test(address)) {
                    wallets.push(address);
                    continue loop;
                }
                break;
        }
        errors.push(address);
    }

    if (errors.length > 0) {
        throw errors;
    }

    wallets.sort();
    return wallets;
};

// download the results, and calculate the report
export const runProcess = async (redis, key, wallets) => {
    let firstRow = true;
    let theCount = -1;
    let thePage  = 0;

    await redis.set(key + '_status', 'Starting');
    await redis.expire(key + '_status', 10); // FIXME 3600);
    do {
        await midgard(wallets, thePage, async (row) => {
            //console.log('adding-row');
            redis.zAdd(key, {score: row.date.slice(0, -6), value: JSON.stringify(row)});
            if (firstRow) {
                firstRow = false;
                //console.log('set data-expire');
                redis.expire(key, await redis.ttl(key + '_status'));
            }
        }, async (count) => {
            theCount = count;
            //console.log('setting-count');
            redis.set(key + '_count', count);
            redis.expire(key + '_count', await redis.ttl(key + '_status'));
        });
        thePage++;
    } while (thePage * process.env.MIDGARD_LIMIT < theCount);

    //console.log('--------------');
    //console.log(await redis.zRange(key, 0, 9999999999999));
    //console.log('--------------');
    //console.log(await redis.get(key + '_count'));
    //console.log('--------------');

//    let record;
//    let checkIn;
//    let checkOut;
//    let checkFee;
//    let multi;
//    let fees;

    for (const row of await redis.zRange(key, 0, 9999999999999)) {
        const action = JSON.parse(row);

        // NOTES:
        // for each trade we'll need to have
        // a "deposit" transaction to match the withdrawal from the "other" wallet (non-rune only)
        //
        // a trade transaction
        //
        // a "withdrawal" transaction to match the output to the "other" wallet (non-rune only)
        //
        // -----
        //
        // for each add-liqidity we need to have
        // a "deposit" transaction with the given TX-ID for each asset sent in (1-2)
        // going  into the "ThorChain Wallet"...
        //
        // then a "withdrawal" transaction to send each asset into the pool
        //
        // also, optionally, a "non-taxible income" for the liquidity-units
        //
        //
        // beyond transactions, we need to log liquidity units and their cost-basis
        // we'll do that via half the liquidity units for each asset deposited...
        //
        // -----
        //
        // for each withdraw we need to have
        // a "

        //console.log(action);
        //console.log('--------------');

        if (action.status === 'pending') {
            // "pending" also included failed transactions
            continue;
        }

        switch (action.type) {
            case 'swap':
                await logTrade(redis, key, action);
                break;
            case 'addLiquidity':
                await logDeposit(redis, key, action);
                break;
            case 'withdraw':
                await logWithdraw(redis, key, action);
                break;
        }

//        record = {};
//        fees = {};
//
//        switch (action.type) {
//            case 'addLiquidity':
//                // one or two in, nothing out
//                checkIn  = true;
//                checkOut = false;
//                checkFee = false;
//                multi    = true;
//                record.type = 'Withdrawal';
//                break;
//            case 'withdraw':
//                // one trivial in, one or two out
//                // trivial: (previously 1/100,000,000 RUNE, now zero)
//                checkIn  = false;
//                checkOut = true;
//                checkFee = true;
//                multi    = true;
//                record.type = 'Deposit';
//                break;
//            case 'refund':
//                record.comment = 'Swap Failed and Refunded';
//                // NOTICE NO BREAK
//            case 'swap':
//            default:
//                // one in, one out
//                checkIn  = true;
//                checkOut = true;
//                checkFee = true;
//                multi    = false;
//                record.type = 'Trade';
//                break;
//        }
//
//        // 18,000 seconds (5 hours), to convert to UTC
//        // not sure why the timestamps are in Eastern Time
//        record.date = formatDate(action.date);
//
//        if (checkFee) {
//            for (const fee of Object.values(action.metadata)) {
//                fees[token(fee.networkFees[0]?.asset)] = fee.networkFees[0].amount / 100000000;
//                //console.log("FEE:", fee.networkFees[0].amount / 100000000, token(fee.networkFees[0]?.asset));
//            }
//        }
//
//        if (checkIn) {
//            for (const sent of action.in) {
//                //record["TxHash"]        = sent.txID;
//                //record["Sent Amount"]   = (sent.coins[0]?.amount ?? 0) / 100000000;
//                //record["Sent Currency"] = token(sent.coins[0]?.asset ?? "THOR.RUNE");
//                //if (fees[record["Sent Currency"]] !== undefined) {
//                //    record["Fee Amount"]   = fees[record["Sent Currency"]];
//                //    record["Fee Currency"] = record["Sent Currency"];
//
//                //    // when sending, the amount that actually left the wallet, is sent+fee...
//                //    record["Sent Amount"] += fees[record["Sent Currency"]];
//                //}
//                //if (multi) {
//                //    console.log(Object.values(record).join(","));
//                //}
//                console.log("IN:", sent.address, sent.txID, (sent.coins[0]?.amount ?? 0) / 100000000, sent.coins[0]?.asset ?? "THOR.RUNE");
//            }
//        }
//
//        console.log('record: ', record);
//        console.log('fees  : ', fees);
//        console.log('--------------');
//        //Type	Buy Amount	Buy Currency	Sell Amount	Sell Currency	Fee	Fee Currency	Exchange	Trade-Group	Comment	Date	Tx-ID
    }

    await redis.quit();
};

export const logTrade = async (redis, key, action) => {
    const date = formatDate(action.date);

    await logToWallet(redis, key, action);

    console.log({
        type: 'trade',
        buyAmount:  action.out[0].coins[0].amount / 100000000,
        buyCurr:    token(action.out[0].coins[0].asset),
        sellAmount: action.in[0].coins[0].amount / 100000000,
        sellCurr:   token(action.in[0].coins[0].asset),
        fee:        action.metadata.swap.networkFees[0].amount / 100000000,
        feeCurr:    token(action.metadata.swap.networkFees[0].asset),
        date:       date,
    });
    //await redis.rPush(key + '_record', {});

    if (action.out[0].coins[0].asset !== 'THOR.RUNE') {
        console.log({
            type:      'withdrawal',
            buyAmount: action.out[0].coins[0].amount / 100000000,
            buyCurr:   token(action.out[0].coins[0].asset),
            date:      date,
            txID:      action.out[0].txID,
        });
        //await redis.rPush(key + '_record', {});
    }

    console.log('==============');
};

const pooled = {};
export const logDeposit = async (redis, key, action) => {
    await logToWallet(redis, key, action);

    console.log(pooled);
    console.log('++++++++++++++');
};

export const logWithdraw = async (redis, key, action) => {
    const date = formatDate(action.date);

    // remember, this is a negative number
    const units = Number(action.metadata.withdraw.liquidityUnits) / 100000000;

    let asset  = 0;
    let rune   = 0;
    let liquid = 0;
    do {
        const a = pooled[action.pools[0]].shift();
        if (a.LP + liquid + units > 0) {
        }

        // until $liquid === a.LP, continue summing
    } while ();

    console.log('removing lp units. need calculate how much came out, and what the correct output is, so we can calculate the implicit trade and log that.. and then finally the from wallet transaction');
    console.log('--------------');
};

export const logToWallet = async (redis, key, action) => {
    const date = formatDate(action.date);
    const coins = {};

    for (const sent of action.in) {
        coins[token(sent.coins[0].asset)] = sent.coins[0].amount / 100000000;

        if (sent.coins[0].asset !== 'THOR.RUNE') {
            console.log({
                type:      'deposit',
                buyAmount: sent.coins[0].amount / 100000000,
                buyCurr:   token(sent.coins[0].asset),
                date:      date,
                txID:      sent.txID,
            });
            //await redis.rPush(key + '_record', {});
        }
    }

    // if adding liquidity, note how much was swapped in
    if ('addLiquidity' in action.metadata) {
        pooled[action.pools[0]] ||= [];
        pooled[action.pools[0]].push({
            LP: Number(action.metadata.addLiquidity.liquidityUnits) / 100000000,
            ...coins,
        });
    }
};

// get a key based on the given input
export const sha256 = (input) => {
    return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
};

// convert "BNB.BUSD-BD1" into "BUSD"
export const token = (asset) => {
    return asset.split('.')[1].split('-')[0];
};

