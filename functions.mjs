'use strict';

import fetch from 'node-fetch';
import { createClient } from 'redis';
import crypto from 'crypto';

let printDetails = false; // for debugging

// format given date as "YYYY-MM-DD HH:MM:SS"
export const formatDate = (date, offset) => {
    if (typeof offset !== 'number') {
        offset = 0;
    }
    // date starts as unix-timestamp in nano-seconds
    // plus an offset in seconds
    date = new Date((Number(date) / 1000000) + (offset * 1000));

    return date.getFullYear() + "-" + (date.getMonth() < 9 ? "0" : "") + (date.getMonth() + 1) + "-" + (date.getDate() < 10 ? "0" : "") + date.getDate() + " " + (date.getHours() < 10 ? "0" : "") + date.getHours() + ":" + (date.getMinutes() < 10 ? "0" : "") + date.getMinutes() + ":" + (date.getSeconds() < 10 ? "0" : "") + date.getSeconds();
}

// output for csv files
export const formatCSV = (content) => {
    return {
        statusCode: 200,
        body: content,
    };
};

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
        //console.log('response: fetch successful');
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
    const wallets = [];
    const errors  = [];

    loop:
    for (let [type, address] of Object.entries(addresses)) {
        // ignore empty addresses
        if (address.length < 1) {
            continue;
        }

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
            case type.startsWith('opt-'):
                // disregard options
                continue loop;
        }
        errors.push(address);
    }

    if (errors.length > 0) {
        throw errors;
    }

    wallets.sort();
    return wallets;
};

export const normalizeConfig = (options) => {
    const config = {
        // REMEMBER: add *ALL* defaults here
        detailedLP:      false,
        includeUpgrades: false,
    };

    for (let [type, option] of Object.entries(options)) {
        // ignore empty options
        if (option.length < 1 || !type.startsWith('opt-')) {
            continue;
        }

        switch (type) {
            case 'opt-separate':
                config.includeUpgrades = Boolean(option);
                break;
            // REMEMBER: add *ALL* defaults to config init
        }
    }

    // no need to sort config, since properties are statically defined
    return config;
};

// download the results, and calculate the report
export const runProcess = async (redis, key, wallets, config) => {
    //console.log('starting to run the process');
    let firstRow = true;
    let theCount = -1;
    let thePage  = 0;

    await redis.set(key + '_status', 'Starting to Download Transactions');
    await redis.expire(key + '_status', process.env.TTL);
    do {
        await midgard(wallets, thePage, async (row) => {
            //console.log('adding-row');
            await redis.zAdd(key, {score: row.date.slice(0, -6), value: JSON.stringify(row)});
            if (firstRow) {
                firstRow = false;
                //console.log('set data-expire');
                await redis.expire(key, process.env.TTL);
            }
        }, async (count) => {
            theCount = count;
            //console.log('setting-count');
            await redis.set(key + '_count', count);
            await redis.set(key + '_status', 'Downloading ' + Math.min((thePage + 1) * process.env.MIDGARD_LIMIT, count) + ' of ' + count);
            await redis.expire(key + '_count', process.env.TTL);
            await redis.expire(key + '_status', process.env.TTL);
        });
        thePage++;
    } while (thePage * process.env.MIDGARD_LIMIT < theCount);

    await redis.set(key + '_status', 'Now Processing Transactions');
    await redis.expire(key + '_status', process.env.TTL);
    let rowNumber = 0;

    //console.log('--------------');
    //console.log(await redis.zRange(key, 0, 9999999999999));
    //console.log('--------------');
    //console.log(await redis.get(key + '_count'));
    //console.log('--------------');

    for (const row of await redis.zRange(key, 0, 9999999999999)) {
        rowNumber++;
        await redis.set(key + '_status', 'Processing ' + rowNumber + ' of ' + theCount);
        await redis.expire(key + '_status', process.env.TTL);

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

        //console.log(action.type);

        if (action.status === 'pending') {
            // "pending" also included failed transactions
            continue;
        }

        switch (action.type) {
            case 'swap':
                await logTrade(redis, key, action, config);
                break;
            case 'addLiquidity':
                await logDeposit(redis, key, action, config);
                break;
            case 'withdraw':
                await logWithdraw(redis, key, action, config);
                break;
            case 'switch':
                await logUpgrade(redis, key, action, config);
                break;
        }

        //console.log('--------------');
    }

    await redis.set(key + '_status', 'Completed');
    await redis.expire(key + '_status', process.env.TTL);
    console.log('completed|' + Date.now() + '|' + key);

    await redis.quit();

    //console.log('process completed');
};

// asset, if provided, will scope down the returned fee only if one matches the specified asset
// use token(), asset should be like "RUNE" or "LTC"
export const actionFee = (action, config, asset, skipFee) => {
    if (skipFee) {
        return {};
    }

    if (typeof asset !== 'string') {
        asset = null;
    }

    for (const [type, entry] of Object.entries(action.metadata)) {
        if (entry.hasOwnProperty('networkFees')) {
            for (const fee of entry.networkFees) {
                if (!asset || asset === token(fee.asset, config)) {
                    return {
                        fee:     Number((fee.amount / 100000000).toFixed(8)),
                        feeCurr: token(fee.asset, config),
                    };
                }
            }
        }

        // withdrawal transactions still have a transaction cost (coin-in used to be provided, now no coin, just thor address)
        // swaps from RUNE have also have a transaction cost
        if (((type === 'withdraw' && ((action.in[0].coins.length === 0 && action.in[0].address.startsWith('thor1')) || action.in[0].coins[0].asset === 'THOR.RUNE'))
            || (type === 'swap' && action.in[0].coins[0].asset === 'THOR.RUNE' && action.out[0].coins[0].asset !== 'THOR.RUNE')
            || (type === 'deposit')) && (asset === 'RUNE' || !asset)) {
            return {
                // FUTURE TODO: remember, fee could change in the future
                // I think there is a midgard command to lookup parameters like transaction fee
                fee:     0.02,
                feeCurr: 'RUNE',
            };
        }
    }

    return {};
};

export const logTrade = async (redis, key, action, config) => {
    await logToWallet(redis, key, action, config);

    await storeRecord(redis, key, {
        type: 'Trade',
        buyAmount:  action.out[0].coins[0].amount / 100000000,
        buyCurr:    token(action.out[0].coins[0].asset, config),
        sellAmount: action.in[0].coins[0].amount / 100000000,
        sellCurr:   token(action.in[0].coins[0].asset, config),
        ...actionFee(action, config),
        date:       formatDate(action.date),
    });

    if (action.out[0].coins[0].asset !== 'THOR.RUNE') {
        await storeRecord(redis, key, {
            type:       'Withdrawal',
            sellAmount: action.out[0].coins[0].amount / 100000000,
            sellCurr:   token(action.out[0].coins[0].asset, config),
            ...actionFee(action, config, token(action.out[0].coins[0].asset, config)),
            date:       formatDate(action.date, 1),
            txID:       action.out[0].txID,
        });
    }
};

export const logLPTrade = async (redis, key, buyAmount, buyCurr, sellAmount, sellCurr, action, config, skipFee, extraWithdraw) => {
    const date = formatDate(action.date);

    await storeRecord(redis, key, {
        type: 'Trade',
        buyAmount:  buyAmount,
        buyCurr:    buyCurr,
        sellAmount: sellAmount,
        sellCurr:   sellCurr,
        ...actionFee(action, config, buyCurr, skipFee),
        date:       date,
    });

    if (buyCurr !== 'RUNE') {
        // notice, that we always skip the fee for the withdraw after the trade, since we've already handled it in the trade
        await logLPWithdraw(redis, key, Number((buyAmount + (extraWithdraw ?? 0)).toFixed(8)), buyCurr, action, config, true);
    }
};

export const logLPWithdraw = async (redis, key, sellAmount, sellCurr, action, config, skipFee) => {
    const date = formatDate(action.date, 2);

    await storeRecord(redis, key, {
        type:       'Withdrawal',
        sellAmount: sellAmount,
        sellCurr:   sellCurr,
        ...actionFee(action, config, sellCurr, skipFee),
        date:       date,
        txID:       outMatch(action, sellCurr, config).txID,
    });
};

export const logLPIncome = async (redis, key, buyAmount, buyCurr, action, config, skipFee) => {
    const date = formatDate(action.date, 1);

    await storeRecord(redis, key, {
        type: 'Income',
        buyAmount:  buyAmount,
        buyCurr:    buyCurr,
        ...actionFee(action, config, buyCurr, skipFee),
        comment:    'Profit from Pool: ' + chainToken(action.pools[0]) + '/THOR.RUNE',
        date:       date,
    });
};

export const logLPLoss = async (redis, key, sellAmount, sellCurr, action, config, skipFee) => {
    const date = formatDate(action.date, 1);

    await storeRecord(redis, key, {
        type: 'Lost',
        sellAmount: sellAmount,
        sellCurr:   sellCurr,
        ...actionFee(action, config, sellCurr, skipFee),
        comment:    'Loss from Pool: ' + chainToken(action.pools[0]) + '/THOR.RUNE',
        date:       date,
    });
};

export const outMatch = (action, asset, config) => {
    for (const sent of action.out) {
        if (token(sent.coins[0].asset, config) === asset) {
            return sent;
        }
    }
    return action.out[0];
};

// remember: pooled uses the full pool asset name, not the nice token name
// so that "BNB.ETH-1C9" and "ETH.ETH" are separate, instead of both being simply "ETH"
const pooled = {};
export const logDeposit = async (redis, key, action, config) => {
    const units = await logToWallet(redis, key, action, config);
    //console.log(pooled);

    // then a "withdrawal" transaction for each asset sent into the pool
    for (const sent of action.in) {
        await storeRecord(redis, key, {
            type:       'Withdrawal',
            sellAmount: sent.coins[0].amount / 100000000,
            sellCurr:   token(sent.coins[0].asset, config),
            comment:    'Sent to Pool: ' + chainToken(action.pools[0]) + '/THOR.RUNE',
            ...actionFee(action, config, token(sent.coins[0].asset, config)),
            date:       formatDate(action.date),
        });
    }

    // then (optionally), a "non-taxible income" for the liquidity units
    if (config.detailedLP) {
        await storeRecord(redis, key, {
            type:      'Income (non taxable)',
            buyAmount: units,
            buyCurr:   token(action.pools[0], config) + '-RUNE',
            comment:   'Sent to Pool: ' + chainToken(action.pools[0]) + '/THOR.RUNE',
            date:      formatDate(action.date, 1),
        });
    }
};

export const logWithdraw = async (redis, key, action, config) => {
    //printDetails = true;

    // the nice name of the token asset in the pool alongside RUNE
    const asset = token(action.pools[0], config);

    // calculated tokens, to determine cost-basis, currently just first-in-first-out, but should work on supporting more
    const basis = calculateBasis(action, config);

    // coins actually received (note we initialize to zero, so we know the keys exist within the object)
    const coins = {
        RUNE: 0,
        [asset]: 0,
    };

    for (const received of action.out) {
        coins[token(received.coins[0].asset, config)] = received.coins[0].amount / 100000000;
    }

    //console.log('basis:', basis, ', coins:', coins);

    // we now have how much we originally deposited (in "basis"), and how much was actually withdrawn (in "coins")
    //console.log('withdrawing basis: ' + JSON.stringify(basis) + ', from the pool: ' + chainToken(action.pools[0]) + ', resulting in an outcome of: ' + JSON.stringify(coins));

    // okay, here is where it gets complicated, since ThorChain has asymetrical liquidity pools,
    // there are a number of possible cases to handle; one example is when withdrawing (after depositing both asset/rune),
    // the user can withdraw the value as just rune if desired, so to track it properly, a "trade" needs to be logged.

    // if desired, a "withdrawal" of the LP Units
    if (config.detailedLP) {
        await storeRecord(redis, key, {
            type:       'Expense (non taxable)',
            sellAmount: basis.LP,
            sellCurr:   token(action.pools[0], config) + '-RUNE',
            comment:    'Received from Pool: ' + chainToken(action.pools[0]) + '/THOR.RUNE',
            date:       formatDate(action.date, -2),
        });
    }

    // a "deposit" for each basis we get out (1 or 2)
    // the rune withdraw request transaction fee will be included in the first "deposit"
    if (basis.RUNE > 0) {
        await storeRecord(redis, key, {
            type:      'Deposit',
            buyAmount: basis.RUNE,
            buyCurr:   'RUNE',
            ...actionFee(action, config, 'RUNE'),
            comment:    'Received from Pool: ' + chainToken(action.pools[0]) + '/THOR.RUNE',
            date:      formatDate(action.date, -1),
        });
    }
    if (basis[asset] > 0) {
        await storeRecord(redis, key, {
            type:      'Deposit',
            buyAmount: basis[asset],
            buyCurr:   asset,
            ...actionFee(action, config, 'RUNE', (basis.RUNE > 0)),
            comment:    'Received from Pool: ' + chainToken(action.pools[0]) + '/THOR.RUNE',
            date:      formatDate(action.date, -1),
        });
    }

    // if needed, a "trade" for types:   A to B   |||   A to A/B   |||   A/B to A
    // RUNE to ASSET or ASSET to RUNE   |||   RUNE to BOTH or ASSET to BOTH   |||   BOTH to RUNE or BOTH to ASSET
    if (basis.RUNE > 0 && coins.RUNE <= 0 && basis[asset] <= 0 && coins[asset] > 0) {
        //console.log('RUNE to ASSET');
        await logLPTrade(redis, key, coins[asset], asset, basis.RUNE, 'RUNE', action, config);
    } else if (basis.RUNE <= 0 && coins.RUNE > 0 && basis[asset] > 0 && coins[asset] <= 0) {
        //console.log('ASSET to RUNE');
        await logLPTrade(redis, key, coins.RUNE, 'RUNE', basis[asset], asset, action, config);
    } else if (basis.RUNE > 0 && coins.RUNE > 0 && basis[asset] <= 0 && coins[asset] > 0) {
        //console.log('RUNE to BOTH');
        // so we convert half the basis.RUNE into coins[asset], then income/loss the difference between half the basis.RUNE and the coins.RUNE
        // remember "half" doesn't always divide evenly, so we'll have to do basis-newbasis for the other half
        const newBasis = Number((basis.RUNE / 2).toFixed(8));
        await logLPTrade(redis, key, coins[asset], asset, Number((basis.RUNE - newBasis).toFixed(8)), 'RUNE', action, config);
        if (newBasis < coins.RUNE) {
            // additionally we have a profit of RUNE to report as income
            await logLPIncome(redis, key, Number((coins.RUNE - newBasis).toFixed(8)), 'RUNE', action, config, true);
        } else if (newBasis > coins.RUNE) {
            // additionally we have a loss of RUNE to report as loss
            await logLPLoss(redis, key, Number((newBasis - coins.RUNE).toFixed(8)), 'RUNE', action, config, true);
        } // notice if exactly equal, no income/loss transaction to log
    } else if (basis.RUNE <= 0 && coins.RUNE > 0 && basis[asset] > 0 && coins[asset] > 0) {
        //console.log('ASSET to BOTH');
        // so we convert half the basis[asset] into coins.RUNE, then income/loss the difference between half the basis[asset] and the coins[asset]
        // remember "half" doesn't always divide evenly, so we'll have to do basis-newbasis for the other half
        const newBasis = Number((basis[asset] / 2).toFixed(8));
        await logLPTrade(redis, key, coins.RUNE, 'RUNE', Number((basis[asset] - newBasis).toFixed(8)), asset, action, config);
        if (newBasis < coins[asset]) {
            // additionally we have a profit of ASSET to report as income
            await logLPIncome(redis, key, Number((coins[asset] - newBasis).toFixed(8)), asset, action, config, true);
        } else if (newBasis > coins[asset]) {
            // additionally we have a loss of ASSET to report as loss
            await logLPLoss(redis, key, Number((newBasis - coins[asset]).toFixed(8)), asset, action, config, true);
        } // notice if exactly equal, no income/loss transaction to log
    } else if (basis.RUNE > 0 && coins.RUNE > 0 && basis[asset] > 0 && coins[asset] <= 0) {
        //console.log('BOTH to RUNE');
        // so we convert asset to rune, if basis.RUNE < coins.RUNE, just take the difference, as the output of the trade
        // however, if basis.RUNE >= coins.RUNE, we'll report all the losses
        if (basis.RUNE < coins.RUNE) {
            await logLPTrade(redis, key, Number((coins.RUNE - basis.RUNE).toFixed(8)), 'RUNE', basis[asset], asset, action, config);
        } else {
            // unlikely case: started with both assets, withdraw as RUNE, but got less RUNE then was deposited, multiple losses
            await logLPLoss(redis, key, basis[asset], asset, action, config);
            if (basis.RUNE > coins.RUNE) {
                await logLPLoss(redis, key, Number((basis.RUNE - coins.RUNE).toFixed(8)), 'RUNE', action, config, true);
            }
        }
    } else if (basis.RUNE > 0 && coins.RUNE <= 0 && basis[asset] > 0 && coins[asset] > 0) {
        //console.log('BOTH to ASSET');
        // so we convert rune to asset, if basis[asset] < coins[asset], just take the difference, as the output of the trade
        // however, if basis[asset] >= coins[asset], we'll report all the losses
        if (basis[asset] < coins[asset]) {
            // note the final extra parameter, which adds back in the basis, for the withdrawal
            await logLPTrade(redis, key, Number((coins[asset] - basis[asset]).toFixed(8)), asset, basis.RUNE, 'RUNE', action, config, false, basis[asset]);
        } else {
            // unlikely case: started with both assets, withdraw as asset, but got less asset then was deposited, multiple losses
            await logLPLoss(redis, key, basis.RUNE, 'RUNE', action, config);
            if (basis[asset] > coins[asset]) {
                await logLPLoss(redis, key, Number((basis[asset] - coins[asset]).toFixed(8)), asset, action, config, true);
            }
        }
    } else if (basis.RUNE <= 0 && coins.RUNE <= 0 && basis[asset] > 0 && coins[asset] > 0) {
        //console.log('ASSET to ASSET');
        // simple profit/loss and withdrawal
        if (basis[asset] < coins[asset]) {
            await logLPIncome(redis, key, Number((coins[asset] - basis[asset]).toFixed(8)), asset, action, config);
        } else if (basis[asset] > coins[asset]) {
            await logLPLoss(redis, key, Number((basis[asset] - coins[asset]).toFixed(8)), asset, action, config);
        } // notice if exactly equal, no income/loss transaction to log

        await logLPWithdraw(redis, key, coins[asset], asset, action, config, true);
    } else if (basis.RUNE > 0 && coins.RUNE > 0 && basis[asset] <= 0 && coins[asset] <= 0) {
        //console.log('RUNE to RUNE');
        // simple profit/loss
        if (basis.RUNE < coins.RUNE) {
            await logLPIncome(redis, key, Number((coins.RUNE - basis.RUNE).toFixed(8)), 'RUNE', action, config);
        } else if (basis.RUNE > coins.RUNE) {
            await logLPLoss(redis, key, Number((basis.RUNE - coins.RUNE).toFixed(8)), 'RUNE', action, config);
        } // notice if exactly equal, no income/loss transaction to log
    } else if (basis.RUNE > 0 && coins.RUNE > 0 && basis[asset] > 0 && coins[asset] > 0) {
        //console.log('BOTH to BOTH');

        // simple profit/loss for RUNE
        if (basis.RUNE < coins.RUNE) {
            await logLPIncome(redis, key, Number((coins.RUNE - basis.RUNE).toFixed(8)), 'RUNE', action, config);
        } else if (basis.RUNE > coins.RUNE) {
            await logLPLoss(redis, key, Number((basis.RUNE - coins.RUNE).toFixed(8)), 'RUNE', action, config);
        } // notice if exactly equal, no income/loss transaction to log


        // simple profit/loss and withdrawal for ASSET
        if (basis[asset] < coins[asset]) {
            await logLPIncome(redis, key, Number((coins[asset] - basis[asset]).toFixed(8)), asset, action, config);
        } else if (basis[asset] > coins[asset]) {
            await logLPLoss(redis, key, Number((basis[asset] - coins[asset]).toFixed(8)), asset, action, config);
        } // notice if exactly equal, no income/loss transaction to log

        await logLPWithdraw(redis, key, coins[asset], asset, action, config, true);
    } else {
        console.log('Error: Unhandled Case: basis:', basis, 'coins:', coins);
    }

    //printDetails = false;
    //console.log('---------------');
};

export const calculateBasis = (action, config) => {
    // liquidity-units actually removed, remember, this is a negative number
    const units = Number(action.metadata.withdraw.liquidityUnits) / 100000000;

    // the nice name of the token asset in the pool alongside RUNE
    const asset = token(action.pools[0], config);

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

    return basis;
};

export const logUpgrade = async (redis, key, action, config) => {
    if (config.includeUpgrades) {
        // log move to wallet before upgrade
        await logToWallet(redis, key, action, config);

        // optional, since people may or maynot want that
        await storeRecord(redis, key, {
            type: 'Trade',
            buyAmount:  action.out[0].coins[0].amount / 100000000,
            buyCurr:    token(action.out[0].coins[0].asset, config),
            sellAmount: action.in[0].coins[0].amount / 100000000,
            sellCurr:   token(action.in[0].coins[0].asset, config),
            // no fees for upgrades (beyond external chain transaction fee)
            comment:    'Upgraded ' + chainToken(action.in[0].coins[0].asset),
            date:       formatDate(action.date),
        });
    } else {
        // even if people don't consider the upgrade a trade, it still moved to this wallet
        // FIXME ENABLE THE NEXT LINE AGAIN
        //await logToWallet(redis, key, action, config, 'Upgraded ' + chainToken(action.in[0].coins[0].asset));
    }
};

// for "addLiquidity" will return number of LiquidityUnits added, otherwise null
export const logToWallet = async (redis, key, action, config, comment) => {
    const date = formatDate(action.date, -1);
    const coins = {};

    for (const sent of action.in) {
        coins[token(sent.coins[0].asset, config)] = sent.coins[0].amount / 100000000;

        if (sent.coins[0].asset !== 'THOR.RUNE') {
            await storeRecord(redis, key, {
                type:      'Deposit',
                buyAmount: coins[token(sent.coins[0].asset, config)],
                buyCurr:   token(sent.coins[0].asset, config),
                comment:   comment ?? null,
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

        return Number(action.metadata.addLiquidity.liquidityUnits) / 100000000;
    }

    return null;
};

let firstRecord = true;
export const storeRecord = async (redis, key, record) => {
    if (printDetails) {
        console.log('store:', record);
    }
    await redis.rPush(key + '_record', JSON.stringify(record));
    if (firstRecord) {
        firstRecord = false;
        //console.log('set record-expire');
        await redis.expire(key + '_record', process.env.TTL);
    }
};

// get a key based on the given input
export const sha256 = (input) => {
    return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
};

// convert "BNB.BUSD-BD1" into "BUSD"
export const token = (asset, config) => {
    if (config.includeUpgrades) {
        // in order to include the upgrades properly, we have to make non-native distinct
        switch (asset) {
            case 'ETH.RUNE-0X3155BA85D5F96B2D030A4966AF206230E46849CB':
                return 'RUNE-ETH';
            case 'BNB.RUNE-B1A':
                return 'RUNE-B1A';
        }
    }
    return asset.split('.')[1].split('-')[0];
};

// convert "BNB.BUSD-BD1" into "BNB.BUSD"
export const chainToken = (asset) => {
    return asset.split('-')[0];
};

