'use strict';

import { exec } from 'child_process';
import fetch from 'node-fetch';
import { createClient } from 'redis';
import crypto from 'crypto';
import { BASE_OFFSET, Calculation } from "./calculations.mjs";
import { Cosmos } from "./cosmos.mjs";
import { groupedTransactions } from "./groupedTransactions.mjs";

const THOR_TAG = 'thor'; // just thor addresses
const RUNE_TAG = 'rune'; // anything thor related (like doge)
const COSMOS_TAG = 'cosmos';

const monkiers = {};

// let printDetails = false; // for debugging

// format given date as "YYYY-MM-DD HH:MM:SS"
export const formatDate = (date, offset) => {
    if (typeof offset !== 'number') {
        offset = 0;
    }
    // date starts as unix-timestamp in nanoseconds
    // plus an offset in seconds
    date = new Date((Number(date) / 1000000) + (offset * 1000));

    return dateToString(date);
}

export const dateToString = (date) => {
    return date.getFullYear() + "-" + (date.getMonth() < 9 ? "0" : "") + (date.getMonth() + 1) + "-" +
        (date.getDate() < 10 ? "0" : "") + date.getDate() + " " + (date.getHours() < 10 ? "0" : "") + date.getHours() +
        ":" + (date.getMinutes() < 10 ? "0" : "") + date.getMinutes() + ":" + (date.getSeconds() < 10 ? "0" : "") +
        date.getSeconds();
};

// output for csv files
export const formatText = (content) => {
    return {
        statusCode: 200,
        body: content,
    };
};

// consistent output formatting for api
export const formatError = (message, statusCode) => {
    return {
        statusCode: statusCode ?? 400,
        body: JSON.stringify({
            status: 'error',
            message: message
        })
    };
};

// consistent output formatting for api
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
        port: Number(redisPort)
    }});

    client.on('error', (error) => {
        console.log('Redis Client Error:', error);
    });

    await client.connect();

    return client;
};

let discordTimeout;
let discordMessage = '';
let discordLast = new Date();

export const discord = async (message) => {
    console.log(message);
    if (discordTimeout) {
        clearTimeout(discordTimeout);
    }
    if (discordMessage.length > 0 && (new Date()).getTime() - discordLast.getTime() > 10000) {
        await discordNow();
    }
    discordMessage += (discordMessage.length > 0 ? ('\n ') : '') + message;
    discordTimeout = setTimeout(discordNow, 9000);
};

const discordNow = async () => {
    let message = discordMessage;
    discordMessage = '';
    discordLast = new Date();
    // message is wrapped in single quotes, so we have to escape any in the message
    message = String(message).replace("'", "\\'");
    exec("discord-if-distinct.sh general '" + message + "'");
};

// gets transactions for specific page for the given wallet list: (["thor1..", "bnb1.."], 3)
// pagination starts with 0 (zero)
// addAction(action) and setCount(count) are callbacks
export const midgard = async (wallets, pagination, addAction, setCount) => {
    const url = process.env.MIDGARD_URL.replace('{WALLETS}', wallets.join(',')).replace('{OFFSET}', String(pagination * process.env.MIDGARD_LIMIT));
    // console.log('url:', url);
    await fetch(url).then((response) => {
        // console.log('response: fetch successful');
        return response.json();
    }).then(async (data) => {
        await setCount(data.count);
        for (const action of data.actions) {
            await addAction(action);
        }
    }).catch((error) => {
        throw error;
    });
};

// gets sent to/from transactions
export const thornode = async (wallet, pagination, direction, addAction, setCount) => {
    const url = process.env.THORNODE_URL.replace('{DIRECTION}', direction).replace('{WALLET}', wallet).replace('{PAGE}', String(pagination + 1));
    const inOut = direction === 'recipient' ? 'in' : 'out';
    // console.log('url:', url);
    await fetch(url).then((response) => {
        // console.log('response: fetch successful');
        return response.json();
    }).then(async (data) => {
        // console.log(data);
        await setCount(Number(data.total_count));
        if (data.txs) {
            for (const tx of data.txs) {
                const action = {
                    type: 'send',
                    metadata: {
                        send: {
                            networkFees: [{
                                asset: 'THOR.RUNE',
                                amount: tx.tx.value.fee.gas,
                            }],
                        },
                    },
                    date: String((new Date(tx.timestamp)).getTime()) + '000000',
                };
                action[inOut] = [{
                    coins: [{
                        asset: 'THOR.' + tx.tx.value.msg[0].value.amount[0].denom.toUpperCase(),
                        amount: tx.tx.value.msg[0].value.amount[0].amount,
                    }],
                    txID: tx.txhash,
                }];
                addAction(action);
            }
        }
    }).catch((error) => {
        throw error;
    });
};

export const historicalThornode = async (wallet, addAction) => {
    if (groupedTransactions[wallet]) {
        for (const tx of groupedTransactions[wallet]) {
            const inOut = tx.recipient === wallet ? 'in' : 'out';
            const action = {
                type: 'send',
                metadata: {
                    send: {
                        networkFees: [{
                            asset: 'THOR.RUNE',
                            amount: 2000000,
                        }],
                    },
                },
                date: String((new Date(tx.timestamp)).getTime()) + '000000',
            };
            action[inOut] = [{
                coins: [{
                    asset: tx.asset,
                    amount: Number(tx.amount * BASE_OFFSET).toFixed(0),
                }],
                txID: tx.txhash,
            }];
            addAction(action);
        }
    }
};

// previously: (network, wallet, pagination, direction, height, addCosmosTx, setCount, setHeight)
export const cosmos = async (network, wallet, pagination, limit, direction, addCosmosTx, setCount) => {
    const baseUrl = process.env[network + '_URL'];
    // the network variable must be one of the recognized options specified in the environment with "_URL" and "_LIMIT"
    // suffixed versions defined, expectation is to use the address prefix for the given blockchain as the network
    if ( ! baseUrl || ! limit) {
        throw 'Missing required configuration for given cosmos network: "' + network + '".';
    }
    const url = baseUrl
        .replace('{DIRECTION}', direction)
        .replace('{WALLET}', wallet)
        .replace('{OFFSET}', String(pagination * limit))
        // .replace('{HEIGHT}', String(height))
    ;
    console.log('url:', url);
    await fetch(url).then((response) => {
        // console.log('response: fetch successful');
        return response.json();
    }).then(async (data) => {
        // if (Array.isArray(data)) {
        //     await setHeight(data[0].data.height);
        //     await setCount(data.length + pagination * limit);
        //     for (const tx of data) {
        //         await addCosmosTx(tx.data);
        //     }
        // } else {
            await setCount(data.pagination?.total);
            for (const tx of data.tx_responses) {
                tx.chain = network;
                await addCosmosTx(tx);
            }
        // }
    }).catch((error) => {
        throw error;
    });
};

export const loadNodes = async (network) => {
    const url = process.env[network + '_NODES'];
    if ( ! url) {
        // useful, but not required info, so just continue on
        console.log('Missing nodes configuration for cosmos network: "' + network + '".');
        return {};
    }

    monkiers[network] = {};
    await fetch(url).then((response) => {
        // console.log('response: fetch successful');
        return response.json();
    }).then(async (data) => {
        for (const validator of data.validators) {
            // build lookup table with simplified names
            monkiers[network][validator.operator_address] = validator.description.moniker.replace(/[^0-9A-Za-z ._]+/g, '-');
        }
        console.log(network + ' nodes loaded.');
    }).catch(() => {
        console.log('Warning, unsuccessful loading nodes for cosmos network: "' + network + '".');
    });
};

export const getNode = (network, node) => {
    return monkiers[network][node] ?? node.replace(/^([a-z]+1[a-z0-9]{5})[a-z0-9]+([a-z0-9]{5})$/, "$1...$2");
};

// returns valid addresses in normalized format
// takes object, returns a wallet object (collection of arrays)
export const normalizeAddresses = (addresses) => {
    // wallets.all array with every address
    // wallets.tags array with name of each group
    // wallets[tag] array with addresses for given group
    const wallets = {
        tags: [],
        all: [],
        add: function (address, ...tags) {
            for (const tag of tags) {
                if ( ! this.tags.includes(tag)) {
                    // initialize array if needed
                    this.tags.push(tag);
                    this[tag] = [];
                }
                this[tag].push(address);
            }
            this.all.push(address);
        },
    };
    const errors  = [];

    loop:
    for (let [type, address] of Object.entries(addresses)) {
        address = String(address);

        // ignore empty addresses
        if (address.length < 1) {
            continue;
        }

        switch (true) {
            case type.startsWith('eth'):
                // ether /^0x[a-f0-9]{40}$/
                address = address.toLowerCase();
                if (/^0x[a-f0-9]{40}$/.test(address)) {
                    wallets.add(address, RUNE_TAG);
                    continue loop;
                }
                break;
            case type.startsWith('btc'):
                // legacy /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/
                // segwit /^bc1[a-z0-9]{38,90}$/
                if (/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) {
                    wallets.add(address, RUNE_TAG);
                    continue loop;
                }
                address = address.toLowerCase();
                if (/^bc1[a-z0-9]{38,90}$/.test(address)) {
                    wallets.add(address, RUNE_TAG);
                    continue loop;
                }
                break;
            case type.startsWith('bch'):
                // legacy /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/
                // normal /^(bitcoincash:)?[qp][a-z0-9]{38,90}$/
                if (/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) {
                    wwallets.add(address, RUNE_TAG);
                    continue loop;
                }
                address = address.toLowerCase();
                if (/^(bitcoincash:)?[qp][a-z0-9]{38,90}$/.test(address)) {
                    wallets.add(address, RUNE_TAG);
                    continue loop;
                }
                break;
            case type.startsWith('bnb'):
                // binance /^bnb[a-z0-9]{38,90}$/
                address = address.toLowerCase();
                if (/^bnb[a-z0-9]{38,90}$/.test(address)) {
                    wallets.add(address, RUNE_TAG);
                    continue loop;
                }
                break;
            case type.startsWith('ltc'):
                // legacy /^[LM3][a-km-zA-HJ-NP-Z1-9]{25,34}$/
                // lower  /^ltc[a-z0-9]{38,90}$/
                if (/^[LM3][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) {
                    wallets.add(address, RUNE_TAG);
                    continue loop;
                }
                address = address.toLowerCase();
                if (/^ltc[a-z0-9]{38,90}$/.test(address)) {
                    wallets.add(address, RUNE_TAG);
                    continue loop;
                }
                break;
            case type.startsWith('thor'):
                // thor /^thor[a-z0-9]{38,90}$/
                address = address.toLowerCase();
                if (/^thor[a-z0-9]{38,90}$/.test(address)) {
                    wallets.add(address, RUNE_TAG, THOR_TAG);
                    continue loop;
                }
                break;
            case type.startsWith('doge'):
                // doge /^D[5-9A-HJ-NP-U][1-9A-HJ-NP-Za-km-z]{25,34}$/
                if (/^D[5-9A-HJ-NP-U][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(address)) {
                    wallets.add(address, RUNE_TAG);
                    continue loop;
                }
                break;
            case type.startsWith('chihuahua'):
                // chihuahua /^chihuahua[a-z0-9]{38,90}$/
                address = address.toLowerCase();
                if (/^chihuahua[a-z0-9]{38,90}$/.test(address)) {
                    wallets.add(address, COSMOS_TAG);
                    continue loop;
                }
                break;
            case type.startsWith('cerberus'):
                // cerberus /^cerberus[a-z0-9]{38,90}$/
                address = address.toLowerCase();
                if (/^cerberus[a-z0-9]{38,90}$/.test(address)) {
                    wallets.add(address, COSMOS_TAG);
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

    wallets.all.sort();
    return wallets;
};

export const normalizeConfig = (options) => {
    const config = {
        // REMEMBER: add *ALL* defaults here
        standardLP:      true, // log sent-to/received-from pool transactions
        detailedLP:      false, // log received-from/sent-to liquidity units
        includeUpgrades: false, // report non-native rune as separate assets
        includeAuthZ:    false, // report authz messages (such as restake bot compounding)
        basisMethod:     'FIFO', // how we pull basis out of our pooled list
        // the following are used internally, to track setting new variables in redis
        firstRecord:     true,
        pooled:          {}, // we add pool names as we run across them
    };

    for (let [type, option] of Object.entries(options)) {
        // ignore empty options
        if (option.length < 1 || !type.startsWith('opt-')) {
            continue;
        }

        switch (type) {
            case 'opt-separate':
                // remember, Boolean() returns true for anything except for "", null, or undefined
                config.includeUpgrades = Boolean(option);
                break;
            case 'opt-compound':
                // remember, Boolean() returns true for anything except for "", null, or undefined
                config.includeAuthZ = Boolean(option);
                break;
            case 'opt-verbose':
                if (option === 'min') {
                    config.standardLP = false;
                } else if (option === 'max') {
                    config.detailedLP = true;
                }
                break;
            case 'opt-method':
                if (option === 'LIFO') {
                    config.basisMethod = option;
                }
                break;
            // REMEMBER: add *ALL* defaults to config init
        }
    }

    // no need to sort config, since properties are statically defined
    return config;
};

// download the results, and calculate the report
export const runProcess = async (redis, key, wallets, config) => {
    // 1 phase for processing, 1 phase for midgard, 2 phases per thor address, and 2 phases per cosmos address
    const total = 1 + (wallets[RUNE_TAG]?.length > 0 ? 1 : 0) + (2 * (wallets[THOR_TAG]?.length ?? 0)) + (2 * (wallets[COSMOS_TAG]?.length ?? 0));
    let phase = 0;
    let firstAction = true;
    let theCount = -1;
    let thePage  = 0;
    let theLimit = -1;
    // let theHeight = 0;

    const addAction = async (action) => {
        // console.log('adding-action');
        await redis.zAdd(key + '_action', {score: action.date.slice(0, -6), value: JSON.stringify(action)});
        if (firstAction) {
            firstAction = false;
            // console.log('set data-expire');
            await redis.expire(key + '_action', process.env.TTL);
        }
    };

    const addCosmosTx = async (tx) => {
        // console.log('adding-cosmos-tx');
        tx.isCosmosTx = true;
        await redis.zAdd(key + '_action', {score: String((new Date(tx.timestamp)).getTime()), value: JSON.stringify(tx)});
        if (firstAction) {
            firstAction = false;
            // console.log('set data-expire');
            await redis.expire(key + '_action', process.env.TTL)
        }
    };

    const setCount = async (count) => {
        theCount = count;
        // console.log('setting-count');
        await redis.set(key + '_count', count);
        await redis.set(key + '_status', 'Phase ' + phase + ' of ' + total + ', Downloading ' + Math.min((thePage + 1) * theLimit, count) + ' of ' + count);
        await redis.expire(key + '_count', process.env.TTL);
        await redis.expire(key + '_status', process.env.TTL);
    };

    // const setHeight = async (height) => {
    //     // only increment the height, so we move forward
    //     if (height > theHeight) {
    //         theHeight = height;
    //         // console.log('setting-height');
    //         await redis.set(key + '_height', height);
    //         await redis.set(key + '_status', 'Phase ' + phase + ' of 4, Downloading from height: ' + height);
    //         await redis.expire(key + '_height', process.env.TTL);
    //         await redis.expire(key + '_status', process.env.TTL);
    //     }
    // };

    // console.log('starting to run the process');

    // TODO split wallets into groups based on what cosmos chain they are related to (atom, huahua, lum, rune (or related), etc.)
    // I think we might want to do this in address normalization instead, have wallets be a object, could tag

    // TODO runProcess() revised design:
    // loop over wallets by type, switch by type to kick off the corresponding function, (most could be the same with diff
    // config passed (rpc endpoint)).. rune would be the odd ball, but that's fine.
    //
    // each sub-process would be async, and we'd do a wait all at the end..
    // simple array of promises, and a Promise.all(promises).then().catch().. after the loop..
    // each element should (ideally) gracefully handle failed API calls, and try a second time (maybe alt rpc would be ideal)..
    // since rune uses two apis, it should kick off two promises, so they can run concurrently.
    //
    // would like a way foreach running promise to indicate it's progress, something simple like x of y completed..
    // could combine that with n number of active operations..

    await redis.set(key + '_status', 'Starting to Download Transactions');
    await redis.expire(key + '_status', process.env.TTL);

    // phase 1, download ThorChain transactions via Midgard
    if (wallets[RUNE_TAG]) {
        phase++;
        theLimit = process.env.MIDGARD_LIMIT;
        do {
            await midgard(wallets[RUNE_TAG], thePage, addAction, setCount);
            thePage++;
        } while (thePage * theLimit < theCount);
    }

    // phase 2, download ThorChain to ThorChain "Send" transactions, from a separate API
    if (wallets[THOR_TAG]) {
        for (const wallet of wallets[THOR_TAG]) {
            // we have to search for sent/receive transactions separately
            for (const direction of ['sender', 'recipient']) {
                phase++;
                theCount = -1;
                thePage = 0;
                theLimit = process.env.THORNODE_LIMIT;
                do {
                    await thornode(wallet, thePage, direction, addAction, setCount);
                    thePage++;
                } while (thePage * theLimit < theCount);
            }

            // throw in any pre-fork (March 2022) transactions (rune wallet to rune wallet)
            // remember: these both current and historical thornode transactions include synthetics
            await historicalThornode(wallet, addAction);
        }
    }

    // phase 3, download transactions from each cosmos chain
    if (wallets[COSMOS_TAG]) {
        for (const wallet of wallets[COSMOS_TAG]) {
            const network = wallet.split('1')[0]; // "chihuahua1sv0..." into just "chihuahua"
            theLimit   = process.env[network + '_LIMIT'];
            for (const direction of ['message.sender', 'transfer.recipient']) {
                phase++;
                theCount = -1;
                thePage = 0;
                // theHeight = 0;
                do {
                    // previously: (network, wallet, thePage, theLimit, direction, theHeight, addCosmosTx, setCount, setHeight);
                    await cosmos(network, wallet, thePage, theLimit, direction, addCosmosTx, setCount);
                    thePage++;
                } while (thePage * theLimit < theCount /* 1k limit */ && thePage < 10); // TODO resolve performance issues, and remove cap
            }
        }
    }

    theCount = await redis.zCard(key + '_action');
    await redis.set(key + '_count', theCount);
    await redis.set(key + '_status', 'Phase ' + total + ' of ' + total + ', Now Processing ' + theCount + ' Transactions');
    await redis.expire(key + '_count', process.env.TTL);
    await redis.expire(key + '_status', process.env.TTL);
    let rowNumber = 0;

    // console.log('--------------');
    // console.log(await redis.zRange(key + '_action', 0, 9999999999999));
    // console.log('--------------');
    // console.log(await redis.get(key + '_count'));
    // console.log('--------------');

    for (const row of await redis.zRange(key + '_action', 0, 9999999999999)) {
        rowNumber++;
        await redis.set(key + '_status', 'Phase ' + total + ' of ' + total + ', Processing ' + rowNumber + ' of ' + theCount);
        await redis.expire(key + '_status', process.env.TTL);

        const action = JSON.parse(row);

        if (action.isCosmosTx) {
            const cosmos = new Cosmos(redis, key, action, config, wallets[COSMOS_TAG]);
            await cosmos.logTx();
            continue;
        }

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
        // for each add-liquidity we need to have
        // a "deposit" transaction with the given TX-ID for each asset sent in (1-2)
        // going  into the "ThorChain Wallet"...
        //
        // then a "withdrawal" transaction to send each asset into the pool
        //
        // also, optionally, a "non-taxable income" for the liquidity-units
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
        // If needed, a "trade" to resolve cross currency issues (added RUNE/BTC, withdrew just RUNE via implicit trade,
        // which needs to be reported for the books to be balanced).
        //
        // furthermore, we'll need to account for gains/loss (is loss possible? yes, but uncommon)
        // for each currency (these will be "income" transactions
        //
        // and finally for any non-rune, a "withdrawal" to the other wallet
        //
        // I'd like to report what is currently pooled, once the report is ready, instead of just dropping that data.

        // console.log(action.type);

        if (action.status === 'pending') {
            // "pending" also included failed transactions
            continue;
        }

        const calc = new Calculation(redis, key, action, config);

        switch (action.type) {
            case 'send':
                await calc.logSend();
                break;
            case 'swap':
                await calc.logTrade();
                break;
            case 'addLiquidity':
                await calc.logDeposit();
                break;
            case 'withdraw':
                await calc.logWithdraw();
                break;
            case 'switch':
                await calc.logUpgrade();
                break;
        }

        // console.log('--------------');
    }

    await redis.set(key + '_status', 'Completed');
    await redis.expire(key + '_status', process.env.TTL);
    console.log('completed|' + Date.now() + '|' + key);

    await redis.quit();

    // console.log('process completed');
};

// get a key based on the given input
export const sha256 = (input) => {
    return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
};

// convert "BNB.BUSD-BD1" into "BNB.BUSD"
export const chainToken = (asset) => {
    return asset.split('-')[0];
};
