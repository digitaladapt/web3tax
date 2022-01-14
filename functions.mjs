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
            await redis.zAdd(key, {score: row.date.slice(0, -6), value: JSON.stringify(row)});
            if (firstRow) {
                firstRow = false;
                //console.log('set data-expire');
                await redis.expire(key, await redis.ttl(key + '_status'));
            }
        }, async (count) => {
            theCount = count;
            //console.log('setting-count');
            await redis.set(key + '_count', count);
            await redis.expire(key + '_count', await redis.ttl(key + '_status'));
        });
        thePage++;
    } while (thePage * process.env.MIDGARD_LIMIT < theCount);

    //console.log('--------------');
    //console.log(await redis.zRange(key, 0, 9999999999999));
    //console.log('--------------');
    //console.log(await redis.get(key + '_count'));
    //console.log('--------------');

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
        // a "deposit" transaction where we get back whatever we had swapped in from our pooled history
        // for the number of LP units withdrawn...
        //
        // If needed, a "trade" to resolve cross currency issues (this will require to know the pool swap rate at
        // that point in time, which will need to be looked up (and stored for a long time).
        //
        // furthermore, we'll need to account for gains/loss (is loss possible?)
        // for each currency (these will be "income" transactions
        //
        // and finally for any non-rune, a "withdrawal" to the other wallet

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

        //console.log('--------------');
    }

    await redis.quit();
};

export const logTrade = async (redis, key, action) => {
    const date = formatDate(action.date);

    await logToWallet(redis, key, action);

    await storeRecord(redis, key, {
        type: 'trade',
        buyAmount:  action.out[0].coins[0].amount / 100000000,
        buyCurr:    token(action.out[0].coins[0].asset),
        sellAmount: action.in[0].coins[0].amount / 100000000,
        sellCurr:   token(action.in[0].coins[0].asset),
        fee:        action.metadata.swap.networkFees[0].amount / 100000000,
        feeCurr:    token(action.metadata.swap.networkFees[0].asset),
        date:       date,
    });

    if (action.out[0].coins[0].asset !== 'THOR.RUNE') {
        await storeRecord(redis, key, {
            type:      'withdrawal',
            buyAmount: action.out[0].coins[0].amount / 100000000,
            buyCurr:   token(action.out[0].coins[0].asset),
            date:      date,
            txID:      action.out[0].txID,
        });
    }
};

// remember: pooled uses the full pool asset name, not the nice token name
// so that "BNB.ETH-1C9" and "ETH.ETH" are separate, instead of both being simply "ETH"
const pooled = {};
export const logDeposit = async (redis, key, action) => {
    await logToWallet(redis, key, action);
    //console.log(pooled);
};

export const logWithdraw = async (redis, key, action) => {
    const date = formatDate(action.date);

    // liquidity-units actually removed, remember, this is a negative number
    const units = Number(action.metadata.withdraw.liquidityUnits) / 100000000;

    // the nice name of the token asset in the pool alongside RUNE
    const asset = token(action.pools[0]);

    // calculated tokens, to determine cost-basis, currently just first-in-first-out, but should work on supporting more
    const basis = {LP: 0, RUNE: 0, [asset]: 0};
    do {
        // calculate the first-in-first-out rune/asset sent into the liquidity pools, so we can handle the accounting correctly
        // notice we round all math to exactly 8 places at every step, to ensure rounding errors aren't a problem
        const deposit = pooled[action.pools[0]].shift();
        if (deposit) {
            if (Number((deposit.LP + basis.LP + units).toFixed(8)) > 0) {
                const percent = (deposit.LP + basis.LP + units) / deposit.LP;

                // since we need just a portion of this current deposit, add the needed amount to our basis
                basis.LP     = Number((basis.LP     + deposit.LP            - (deposit.LP            * percent)).toFixed(8));
                basis[asset] = Number((basis[asset] + (deposit[asset] ?? 0) - ((deposit[asset] ?? 0) * percent)).toFixed(8));
                basis.RUNE   = Number((basis.RUNE   + (deposit.RUNE ?? 0)   - ((deposit.RUNE ?? 0)   * percent)).toFixed(8));

                // update the deposit, with the leftover, so we can track the next withdraw correctly
                deposit.LP     = Number((deposit.LP            * percent).toFixed(8));
                deposit[asset] = Number(((deposit[asset] ?? 0) * percent).toFixed(8));
                deposit.RUNE   = Number(((deposit.RUNE ?? 0)   * percent).toFixed(8));

                // take the leftover and put it back into the pooled, and break out of the loop
                pooled[action.pools[0]].unshift(deposit);
                break;
            } else {
                basis.LP     = Number((basis.LP     + deposit.LP           ).toFixed(8));
                basis[asset] = Number((basis[asset] + (deposit[asset] ?? 0)).toFixed(8));
                basis.RUNE   = Number((basis.RUNE   + (deposit.RUNE ?? 0)  ).toFixed(8));
            }
        } else {
            console.log('Error: Liquidity Units Provided mismatch for pool: ' + action.pools[0]);
            break;
        }
    } while (Number((basis.LP + units).toFixed(8)) < 0);

    // coins actually received
    const coins = {};

    for (const received of action.out) {
        coins[token(received.coins[0].asset)] = received.coins[0].amount / 100000000;
    }

    // we now have how much we originally deposited (in "basis"), and how much was actually withdrawn (in "coins")
    // TODO from here
    // so, withdraw is either: 50%/50% or 100% of asset or rune...
    //
    // the only extra complication would be a deposit of something more complex (like 25%/75% from "expert mode")
    // or other stuff like the XRUNE kickoff, where it was 99% RUNE and 1 XRUNE into the pool...
    // possible cases:
    // deposited rune, rune/asset, asset
    // withdrawn rune, rune/asset, asset
    // for a total of 6 cases that all need to be handled
    console.log('withdrawing basis: ' + JSON.stringify(basis) + ', from the pool: ' + asset + ', resulting in an outcome of: ' + JSON.stringify(coins));
};

export const logToWallet = async (redis, key, action) => {
    const date = formatDate(action.date);
    const coins = {};

    for (const sent of action.in) {
        coins[token(sent.coins[0].asset)] = sent.coins[0].amount / 100000000;

        if (sent.coins[0].asset !== 'THOR.RUNE') {
            await storeRecord(redis, key, {
                type:      'deposit',
                buyAmount: coins[token(sent.coins[0].asset)],
                buyCurr:   token(sent.coins[0].asset),
                date:      date,
                txID:      sent.txID,
            });
        }
    }

    // if adding liquidity, note how much was swapped in
    if ('addLiquidity' in action.metadata) {
        pooled[action.pools[0]] || (pooled[action.pools[0]] = []);
        pooled[action.pools[0]].push({
            LP: Number(action.metadata.addLiquidity.liquidityUnits) / 100000000,
            ...coins,
        });
    }
};

let firstRecord = true;
export const storeRecord = async (redis, key, record) => {
    //console.log(JSON.stringify(record));
    await redis.rPush(key + '_record', JSON.stringify(record));
    if (firstRecord) {
        firstRecord = false;
        //console.log('set record-expire');
        await redis.expire(key + '_record', await redis.ttl(key + '_status'));
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

