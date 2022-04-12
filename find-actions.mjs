// concept, view transactions of a given blockchain to find all known types (actions) of transactions (messages)
// print out the action, and a sample message and events, continuing until we've found everything.
// starting at the specified height, it works backwards to get a full 24 hours of blocks.

import fetch from "node-fetch";

// chihuahua
// const baseUrl = 'https://api.mintscan.io/v1/chihuahua/block/chihuahua-1/{HEIGHT}';
// const startHeight = 1516207;
// cerberus
// const baseUrl = 'https://api.mintscan.io/v1/cerberus/block/cerberus-chain-1/{HEIGHT}';
// const startHeight = 241327;
// juno
const baseUrl = 'https://api.mintscan.io/v1/juno/block/juno-1/{HEIGHT}';
const startHeight = 2578097; // 2611462;
let height = startHeight;
let url;
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

    // juno CW
    //'/cosmwasm.wasm.v1.MsgExecuteContract': true, // commented so we can find contract calls
    '/cosmwasm.wasm.v1.MsgInstantiateContract': true,

    // juno unknown
    '/ibc.core.channel.v1.MsgTimeout': true,

    // '/': true,
};
const contracts = {};
let doPrint = false;
let theData;
let tx;
let log;
let event;
let attribute;
try {
    do {
        url = baseUrl.replace('{HEIGHT}', String(height));
        await fetch(url, {headers: {"user-agent": "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:98.0) Gecko/20100101 Firefox/98.0"}}).then((response) => {
            // console.log('response: fetch successful');
            return response.json();
        }).then(async (data) => {
            theData = data;
            for (tx of data[0].txs ?? []) {
                for (log of tx.data.logs ?? []) {
                    for (event of log.events ?? []) {
                        if (event.type === 'message') {
                            for (attribute of event.attributes ?? []) {
                                if (attribute.key === 'action') {
                                    if (!known[attribute.value]) {
                                        if (attribute.value === '/cosmwasm.wasm.v1.MsgExecuteContract') {

                                            innerLoop:
                                            for (const anEvent of log.events ?? []) {
                                                if (anEvent.type === 'execute') {
                                                    for (const anAttr of anEvent.attributes ?? []) {
                                                        if (anAttr.key === '_contract_address') {
                                                            if (!contracts[anAttr.value]) {
                                                                contracts[anAttr.value] = true;
                                                                doPrint = true;
                                                                break innerLoop;
                                                            }
                                                        }
                                                    }
                                                }
                                            }

                                        } else {
                                            known[attribute.value] = true;
                                            doPrint = true;
                                        }

                                        if (doPrint) {
                                            console.log("--------");
                                            console.log("Action : " + attribute.value);
                                            console.log("Message: " + JSON.stringify(tx.data.tx.body.messages[log.msg_index]));
                                            console.log("Events : " + JSON.stringify(log.events));
                                            console.log("--------");
                                            doPrint = false;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            height--;
        }).catch((error) => {
            throw error;
        });
        // periodic dot for monitoring the script, to make sure it's still looping successfully
        if ((height % 10) === 0) {
            process.stdout.write('.');
        }
    } while (height > 1 && startHeight - height < 14400);
} catch (error) {
    console.trace(error);
    console.log({height: height, attribute: attribute ?? null, event: event ?? null, log: log ?? null, data: theData});
}
