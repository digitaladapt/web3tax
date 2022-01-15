'use strict';

import { formatError, formatSuccess, getRedis, midgard, normalizeAddresses, runProcess, sha256 } from './functions.mjs';

// endpoint: kickoff process, start downloading actions from midgard into redis
export const submitAddresses = async (event) => {
    let wallets;
    try {
        wallets = normalizeAddresses(event.pathParameters);
        //console.log(wallets);
    } catch (errors) {
        return formatError('Invalid Wallet Address(es) provided: ' + errors.join(', '));
    }

    const key = sha256(wallets);

    const redis = await getRedis();

    if (await redis.exists(key + '_status')) {
        return formatSuccess({key: key, message: 'Already Running'});
    }

    // notice we started an async process without waiting, that is important
    runProcess(redis, key, wallets);

    return formatSuccess({key: key, message: 'Processing Started'});
};

export const fetchReport = async (event) => {
    const key = event.pathParameters.key ?? null;
    // also get any options like format

    const redis = await getRedis();

    if (await redis.exists(key + '_status')) {
        // TODO for each row into needed format...
        return formatSuccess({message: 'Exists'});
    }

    return formatError('Unknown Key');
};

// endpoint: just an example, for testing only
//export const hello = async (event) => {
//    let res = {}
//
//    let wallets = [
//        '0x0c85b035f138bBDe4f6D200C1c90dA7136427D4B', // ETH
//        'qqpwmnx6kflq6klscg53nnspshwtcd5vyq4j6gmrdh', // BCH
//        'bnb1wdvpszxj2j0m6g8lpp0q89qcp6anzrhp6pgaz9', // BNB
//        'bc1ql8sxnllxkhvxnke2lq5nrjqvng77r9cjpceckx', // BTC
//        'ltc1qpx4mem52nvmc57ghpkjulzstx8gnn2uf45mns9',// LTC
//        'thor1m402rfftzrufugu383sn7mwpdp2qmeq4vx8l27',// RUNE
//    ];
//    const redis = await getRedis();
//
//    let key = '__' + sha256(wallets);
//
//    console.log(key);
//    redis.expire(key, 10); // TODO longer
//    redis.expire(key + '_count', 10); // TODO longer
//
//    // if the key is missing, go get the underlying data from midgard
//    if ( ! await redis.exists(key)) {
//        await midgard(wallets, 0, (row) => {
//            console.log('adding-row');
//            redis.zAdd(key, {score: row.date.slice(0, -6), value: JSON.stringify(row)});
//        }, (count) => {
//            console.log('setting-count');
//            redis.set(key + '_count', count);
//        });
//    }
//
//    console.log('reading-for-output');
//    res = {
//        // data is an array of JSON strings, not objects..
//        data: await redis.zRange(key, 0, 9999999999999),
//        count: await redis.get(key + '_count'),
//    };
//
//    //if (await redis.exists(key)) {
//    //    // exists
//    //    res = {
//    //        range: await redis.zRange(key, 0, '99999999999'),
//    //        score: await redis.zScore(key, 'bnb to rune swap...'),
//    //    };
//    //} else {
//    //    // does NOT exist
//    //    // TODO need to divide the timestamp by 1,000,000 to get timestamp in milliseconds or something, nano-seconds are too large of a number
//    //    //                                   1641860912
//    //    res = await redis.zAdd(key, {score: '1623872728', value: 'bnb to rune swap...'});
//    //}
//
//    await redis.quit();
//
//    return {
//        statusCode: 200,
//        body: JSON.stringify(
//            {
//                message: 'Go Serverless v1.0! Your function executed successfully!',
//                res: res,
//                input: event,
//            },
//            null,
//            2
//        ),
//    };
//};
