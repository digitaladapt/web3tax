'use strict';

import { exec } from 'child_process';
import fetch from 'node-fetch';
import { createClient } from 'redis';
import AsyncLock from 'async-lock';
import crypto from 'crypto';
import { BASE_OFFSET, Calculation } from "./calculations.mjs";
import { Cosmos } from "./cosmos.mjs";
import { groupedTransactions } from "./groupedTransactions.mjs";

const THOR_TAG = 'thor'; // just thor addresses
const RUNE_TAG = 'rune'; // anything thor related (like doge)
const COSMOS_TAG = 'cosmos'; // chihuahua, cerberus, etc
const PAGE_CAP = 100; // max pages to traverse on a single subject

const monkiers = {};

// let printDetails = false; // for debugging

// wait the given time in milliseconds
export const sleep = async (millis) => {
    return new Promise((resolve) => {
        setTimeout(resolve, millis)
    })
}

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
export const formatError = (message, statusCode, content) => {
    if (typeof content !== 'object') {
        content = {};
    }
    return {
        statusCode: statusCode ?? 400,
        body: JSON.stringify({
            status: 'error',
            message: message,
            ...content
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
export const midgard = async (wallets, pagination, addAction, setTotal, repeated) => {
    // alternate based on odd/even, so we effectively load balance between the two sources
    // when repeating, use the other source instead of whatever would be normal
    const url = (pagination + (typeof repeated === "boolean" && repeated ? 1 : 0)) % 2
        ? process.env.MIDGARD_URL_A.replace('{WALLETS}', wallets.join(',')).replace('{OFFSET}', String(pagination * process.env.MIDGARD_LIMIT))
        : process.env.MIDGARD_URL_B.replace('{WALLETS}', wallets.join(',')).replace('{OFFSET}', String(pagination * process.env.MIDGARD_LIMIT));
    // console.log('url: ' + url);
    return await fetch(url).then((response) => {
        // console.log('response: fetch successful');
        return response.json();
    }).then(async (data) => {
        await setTotal('midgard', data.count);
        for (const action of data.actions) {
            await addAction(action);
        }
        return data.count;
    }).catch((error) => {
        if (typeof repeated === "boolean" && repeated) {
            console.log('url alt error, stopping: ' + url);
            throw error;
        } else {
            console.log('url main error, trying alt: ' + url);
            return midgard(wallets, pagination, addAction, setTotal, true);
        }
    });
};

// gets sent to/from transactions
export const thornode = async (wallet, pagination, direction, addAction, setTotal) => {
    const url = process.env.THORNODE_URL.replace('{DIRECTION}', direction).replace('{WALLET}', wallet).replace('{PAGE}', String(pagination + 1));
    const inOut = direction === 'recipient' ? 'in' : 'out';
    // console.log('url: ' + url);
    return await fetch(url).then((response) => {
        // console.log('response: fetch successful');
        return response.json();
    }).then(async (data) => {
        // console.log(data);
        await setTotal(wallet + '-' + direction, Number(data.total_count));
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
                await addAction(action);
            }
        }
        return Number(data.total_count);
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
            await addAction(action);
        }
    }
};

export const cosmos = async (network, wallet, pagination, limit, action, direction, addCosmosTx, setTotal) => {
    const baseUrl = process.env[network + '_URL'];
    // the network variable must be one of the recognized options specified in the environment with "_URL" and "_LIMIT"
    // suffixed versions defined, expectation is to use the address prefix for the given blockchain as the network
    if ( ! baseUrl || ! limit) {
        throw 'Missing required configuration for given cosmos network: "' + network + '".';
    }
    const url = baseUrl
        .replace('{DIRECTION}', direction)
        .replace('{ACTION}', action)
        .replace('{WALLET}', wallet)
        .replace('{OFFSET}', String(pagination * limit))
    ;
    // console.log('url: ' + url);
    return await fetch(url).then((response) => {
        // console.log('response: fetch successful');
        return response.json();
    }).then(async (data) => {
        await setTotal(wallet + '-' + direction + '-' + action, Number(data.pagination.total));
        for (const tx of data.tx_responses) {
            tx.chain = network;
            tx.raw_log = null; // not needed
            tx.events = null; // not needed
            await addCosmosTx(tx);
        }
        return Number(data.pagination.total);
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

    for (let [type, fields] of Object.entries(addresses)) {
        for (let address of fields.split(/[,\s\r\n]+/)) {
            address = String(address);

            // ignore empty addresses and non-address options
            if (address.length < 1 || type.startsWith('opt-')) {
                continue;
            }

            // btc: legacy /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/
            if (/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) {
                wallets.add(address, RUNE_TAG);
                continue;
            }
            // bch: legacy /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/
            if (/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) {
                wallets.add(address, RUNE_TAG);
                continue;
            }
            // ltc: legacy /^[LM3][a-km-zA-HJ-NP-Z1-9]{25,34}$/
            if (/^[LM3][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) {
                wallets.add(address, RUNE_TAG);
                continue;
            }
            // doge /^D[5-9A-HJ-NP-U][1-9A-HJ-NP-Za-km-z]{25,34}$/
            if (/^D[5-9A-HJ-NP-U][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(address)) {
                wallets.add(address, RUNE_TAG);
                continue;
            }

            address = address.toLowerCase();

            // eth: ether /^0x[a-f0-9]{40}$/
            if (/^0x[a-f0-9]{40}$/.test(address)) {
                wallets.add(address, RUNE_TAG);
                continue;
            }
            // btc: segwit /^bc1[a-z0-9]{38,90}$/
            if (/^bc1[a-z0-9]{38,90}$/.test(address)) {
                wallets.add(address, RUNE_TAG);
                continue;
            }
            // bch: normal /^(bitcoincash:)?[qp][a-z0-9]{38,90}$/
            if (/^(bitcoincash:)?[qp][a-z0-9]{38,90}$/.test(address)) {
                wallets.add(address, RUNE_TAG);
                continue;
            }
            // bnb: binance /^bnb[a-z0-9]{38,90}$/
            if (/^bnb[a-z0-9]{38,90}$/.test(address)) {
                wallets.add(address, RUNE_TAG);
                continue;
            }
            // ltc: lower  /^ltc[a-z0-9]{38,90}$/
            if (/^ltc[a-z0-9]{38,90}$/.test(address)) {
                wallets.add(address, RUNE_TAG);
                continue;
            }
            // thor /^thor[a-z0-9]{38,90}$/
            if (/^thor[a-z0-9]{38,90}$/.test(address)) {
                wallets.add(address, RUNE_TAG, THOR_TAG);
                continue;
            }
            // terra /^terra[a-z0-9]{38,90}$/
            if (/^terra[a-z0-9]{38,90}$/.test(address)) {
                wallets.add(address, RUNE_TAG); // TODO eventually we may add the COSMOS_TAG, if we process general transactions..
                // TODO would come with the added complexity of cross-referencing midgard and cosmos data, so we don't double report stuff..
                continue;
            }
            // chihuahua /^chihuahua[a-z0-9]{38,90}$/
            if (/^chihuahua[a-z0-9]{38,90}$/.test(address)) {
                wallets.add(address, COSMOS_TAG);
                continue;
            }
            // cerberus /^cerberus[a-z0-9]{38,90}$/
            if (/^cerberus[a-z0-9]{38,90}$/.test(address)) {
                wallets.add(address, COSMOS_TAG);
                continue;
            }
            // lum /^lum[a-z0-9]{38,90}$/
            if (/^lum[a-z0-9]{38,90}$/.test(address)) {
                wallets.add(address, COSMOS_TAG);
                continue;
            }

            errors.push(address);
        }
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
    await runDownload(redis, key, wallets, config);
    await runCalculate(redis, key, wallets, config);
}

export const runDownload = async (redis, key, wallets, config) => {
    const promises = [];
    const lock = new AsyncLock({ timeout: 5000 });
    let downloaded =  0;
    let total = {};
    let grand = 1;
    let firstAction = true;

    // notice: nested actions are only checked if the first action has at least one result
    // IE: if a wallet has no "MsgDelegate", we don't bother checking for "MsgUndelegate"
    const cosmosGroups = [
        // on-chain sending
        ['/cosmos.bank.v1beta1.MsgSend'],
        ['/cosmos.bank.v1beta1.MsgMultiSend'],

        // cross-chain sending
        ['/ibc.applications.transfer.v1.MsgTransfer'],
        ['/ibc.core.channel.v1.MsgRecvPacket'],

        // delegation related
        ['/cosmos.staking.v1beta1.MsgDelegate', [
            '/cosmos.staking.v1beta1.MsgUndelegate',
            '/cosmos.gov.v1beta1.MsgVote',
            '/cosmos.staking.v1beta1.MsgBeginRedelegate',
            '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward',
        ]],

        // validator related, genesis validators do not appear to have a create transaction
        ['/cosmos.staking.v1beta1.MsgCreateValidator'],
        ['/cosmos.staking.v1beta1.MsgEditValidator'],
        ['/cosmos.distribution.v1beta1.MsgWithdrawValidatorCommission'],

        // authz related, only include MsgExec if desired
        // TODO this should only apply to cosmos chains with authz.. need a way to specify which extras apply to which chains..
        ['/cosmos.authz.v1beta1.MsgGrant', [
            '/cosmos.authz.v1beta1.MsgRevoke',
            ...(config.includeAuthZ ? ['/cosmos.authz.v1beta1.MsgExec'] : []),
        ]],

        // TODO need find out what else Juno needs, and how to process them..
        // I would expect a CW Smart Contract call..
    ];

    // kick off each process as async job, then wait until all have completed, then return
    const addAction = async (action) => {
        // console.log('adding-action');
        downloaded++;
        await redis.set(key + '_status', 'Downloading ' + downloaded+ ' of ' + grand);
        await redis.expire(key + '_status', process.env.TTL);

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
        downloaded++;
        await redis.set(key + '_status', 'Downloading ' + downloaded+ ' of ' + grand);
        await redis.expire(key + '_status', process.env.TTL);

        await redis.zAdd(key + '_action', {score: String((new Date(tx.timestamp)).getTime()), value: JSON.stringify(tx)});
        if (firstAction) {
            firstAction = false;
            // console.log('set data-expire');
            await redis.expire(key + '_action', process.env.TTL)
        }
    };

    const setTotal = (id, count) => {
        // calculate updated grand total
        let prev = total[id] ?? 0;
        total[id] = count;
        grand += count - prev;
    };

    await redis.set(key + '_status', 'Starting to Download Transactions');
    await redis.expire(key + '_status', process.env.TTL);

    // download ThorChain transactions via Midgard
    if (wallets[RUNE_TAG]) {
        const midgardLoop = async () => {
            let page = 0;
            let count = -1;
            do {
                await lock.acquire('midgard', async () => {
                    await sleep(1000);
                    count = await midgard(wallets[RUNE_TAG], page, addAction, setTotal);
                    page++;
                }).catch((error) => {
                    throw error;
                });
            } while (page * process.env.MIDGARD_LIMIT < count && page < PAGE_CAP);
        };
        promises.push(midgardLoop());
    }

    // download ThorChain to ThorChain "Send" transactions, from a separate API
    if (wallets[THOR_TAG]) {
        const thornodeLoop = async (wallet, direction) => {
            let page = 0;
            let count = -1;
            do {
                count = await thornode(wallet, page, direction, addAction, setTotal);
                page++;
            } while (page * process.env.THORNODE_LIMIT < count && page < PAGE_CAP);
        };

        for (const wallet of wallets[THOR_TAG]) {
            // we have to search for sent/receive transactions separately
            for (const direction of ['sender', 'recipient']) {
                promises.push(thornodeLoop(wallet, direction));
            }

            // throw in any pre-fork (March 2022) transactions (rune wallet to rune wallet)
            // remember: these both current and historical thornode transactions include synthetics
            promises.push(historicalThornode(wallet, addAction));
        }
    }

    // download transactions from each cosmos chain
    if (wallets[COSMOS_TAG]) {
        const cosmosLoop = async (wallet, first, additional) => {
            const network = wallet.split('1')[0]; // "chihuahua1sv0..." into just "chihuahua"
            const limit = Number(process.env[network + '_LIMIT']);
            let runAdditional = false;
            // TODO FUTURE: optimize, some values of "first", will *never* have results for direction "transfer.recipient"
            for (const direction of ['message.sender', 'transfer.recipient']) {
                let page = 0;
                let count = -1;
                do {
                    count = await cosmos(network, wallet, page, limit, first, direction, addCosmosTx, setTotal);
                    page++;
                } while (page * limit < count && page < PAGE_CAP);
                if (count > 0) {
                    runAdditional = true;
                }
            }

            if (runAdditional && additional && additional.length > 0) {
                for (const next of additional) {
                    promises.push(cosmosLoop(wallet, next));
                }
            }
        };

        for (const wallet of wallets[COSMOS_TAG]) {
            for (const [first, additional] of cosmosGroups) {
                promises.push(cosmosLoop(wallet, first, additional));
            }
            // FUTURE TODO: long term, a more elegant solution for chain specific additions
            if (wallet.startsWith('lum1')) {
                promises.push(cosmosLoop(wallet, 'OpenBeam', [])); // @type: "/lum.network.beam.MsgOpenBeam"
            }
        }
    }

    await Promise.all(promises);
    await Promise.all(promises); // extra goto 10 line
    // actually important because the list of promises will have changed while waiting
}

export const runCalculate = async (redis, key, wallets, config) => {
    const theCount = await redis.zCard(key + '_action');
    await redis.set(key + '_count', theCount);
    await redis.set(key + '_status', 'Final Phase, Now Processing ' + theCount + ' Transactions');
    await redis.expire(key + '_count', process.env.TTL);
    await redis.expire(key + '_status', process.env.TTL);
    let rowNumber = 0;

    // console.log('--------------');
    // console.log(await redis.zRange(key + '_action', 0, -1));
    // console.log('--------------');
    // console.log(await redis.get(key + '_count'));
    // console.log('--------------');

    for (const row of await redis.zRange(key + '_action', 0, -1)) {
        // process.stdout.write('^');
        rowNumber++;
        await redis.set(key + '_status', 'Final Phase, Processing ' + rowNumber + ' of ' + theCount);
        await redis.expire(key + '_status', process.env.TTL);

        const action = JSON.parse(row);

        if (action.isCosmosTx) {
            // process.stdout.write('{');
            const cosmos = new Cosmos(redis, key, action, config, wallets[COSMOS_TAG]);
            await cosmos.logTx();
            // process.stdout.write('}');
            continue;
        }
        // process.stdout.write('<');

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
            default:
                // TODO actually handle "refund" and "donate".
                console.log('Skipping over thor.' + action.type);
                break;
        }

        // console.log('--------------');
        // process.stdout.write('>');
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
