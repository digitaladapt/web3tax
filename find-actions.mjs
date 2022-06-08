// concept, view transactions of a given blockchain to find all known types (actions) of transactions (messages)
// print out the action, and a sample message and events, continuing until we've found everything.
// starting at the specified height, it works backwards to get a full 24 hours of blocks.

import fetch from "node-fetch";

// // chihuahua
// const baseUrl = 'https://api.mintscan.io/v1/chihuahua/block/chihuahua-1/{HEIGHT}';
// const startHeight = 1516207;
// // cerberus
// const baseUrl = 'https://api.mintscan.io/v1/cerberus/block/cerberus-chain-1/{HEIGHT}';
// const startHeight = 241327;
// // lum
const baseUrl = 'https://api-lum.cosmostation.io/v1/txs?limit=50&offset={OFFSET}';
let offset = 0;
let url;
let empty = 0;
let found = 0;
let inaction = 0;
let untyped = 0;
const known = {
    // moving assets on chain
    '/cosmos.bank.v1beta1.MsgSend': true,
    '/cosmos.bank.v1beta1.MsgMultiSend': true,

    // moving assets across chains
    '/ibc.applications.transfer.v1.MsgTransfer': true,
    '/ibc.core.channel.v1.MsgRecvPacket': true,
    '/ibc.core.client.v1.MsgUpdateClient': true, // ignore
    '/ibc.core.channel.v1.MsgAcknowledgement': true, // ignore

    // staking specific
    '/cosmos.staking.v1beta1.MsgDelegate': true,
    '/cosmos.staking.v1beta1.MsgUndelegate': true, // need MsgDelegate
    '/cosmos.gov.v1beta1.MsgVote': true, // need MsgDelegate
    '/cosmos.staking.v1beta1.MsgBeginRedelegate': true, // need MsgDelegate
    '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward': true, // need MsgDelegate

    // validator specific
    '/cosmos.staking.v1beta1.MsgCreateValidator': true,
    '/cosmos.staking.v1beta1.MsgEditValidator': true, // need MsgCreateValidator
    '/cosmos.distribution.v1beta1.MsgWithdrawValidatorCommission': true, // need MsgCreateValidator

    // authz
    '/cosmos.authz.v1beta1.MsgGrant': true,
    '/cosmos.authz.v1beta1.MsgRevoke': true, // need MsgGrant
    '/cosmos.authz.v1beta1.MsgExec': true, // need MsgGrant AND config.includeAuthz

    // lum specific
    'OpenBeam': true,

    // '/': true,
};
do {
    url = baseUrl.replace('{OFFSET}', String(offset)); //.replace('{HEIGHT}', String(height));
    await fetch(url, {headers: {"user-agent": "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:98.0) Gecko/20100101 Firefox/98.0"}}).then((response) => {
        // console.log('response: fetch successful');
        return response.json();
    }).then(async (data) => {
        if (true) { //data.length > 0 && data[0] && data[0].hasOwnProperty('txs')) {
            for (const tx of data) { //for (const tx of data[0].txs) {
                for (const log of tx.data.logs) {
                    for (const event of log.events) {
                        if (event.type === 'message') {
                            for (const attribute of event.attributes) {
                                if (attribute.key === 'action') {
                                    if (!known[attribute.value]) {
                                        known[attribute.value] = true;
                                        console.log("--------");
                                        console.log("Action : " + attribute.value);
                                        console.log("Message: " + JSON.stringify(tx.data.tx.body.messages[log.msg_index]));
                                        console.log("Events : " + JSON.stringify(log.events));
                                        console.log("--------");
                                    } else {
                                        found++;
                                    }
                                } else {
                                    inaction++;
                                }
                            }
                        } else {
                            untyped++;
                        }
                    }
                }
            }
        } else {
            empty++;
        }
        offset += 50; //height--;
    }).catch((error) => {
        throw error;
    });
    // periodic dot for monitoring the script, to make sure it's still looping successfully
    if (true) { //(height % 10) === 0) {
        process.stdout.write(/* 'e' + empty + */ 'f' + found + 'i' + inaction + 'u' + untyped + '.');
        empty = 0;
        found = 0;
        inaction = 0;
        untyped = 0;
    }
} while (offset < 10000); //} while (height > 1 && startHeight - height < 14400);
