'use strict';

import { Calculation } from "./calculations.mjs";
import { dateToString, discord, getNode } from "./functions.mjs";

/* 1 ATOM/HUAHUA/etc === 1000000 uatom/uhuahua/etc; Cosmos has upto 6 digits after the decimal point */
const BASE_OFFSET   = 1000000;
const ASSET_DECIMAL = 6;

/* when no key is specified, will return an object with all attributes of the desired event (could be empty object),
 * otherwise will return the value of the specific attribute key of the desired event (or null when it doesn't exist) */
export const getEvent = (events, type, key) => {
    for (const event of events) {
        if (event.type === type) {
            if (typeof key === 'string') {
                for (const attribute of event.attributes) {
                    if (attribute.key === key) {
                        return attribute.value;
                    }
                }
            } else {
                const output = {};
                for (const attribute of event.attributes) {
                    output[attribute.key] = attribute.value;
                }
                return output;
            }
        }
    }
    if (typeof key === 'string') {
        return null;
    } else {
        return {};
    }
};

/* inputs allowed:
 * object {denom: "uatom", amount: "1654321"}
 * string "1654321uatom"
 * number 1654321
 * all the above examples mean "1.654321 ATOM" and would result in string output like "1.654321"
 * divisor allows us to easily determine a portion of the whole fee */
export const assetAmount = (tor, divisor) => {
    if (typeof divisor !== 'number') {
        divisor = 1.0;
    }
    if (typeof tor === 'object') {
        tor = Number(tor.amount);
    } else if (typeof tor === 'string') {
        tor = Number(tor.replace(/[^0-9.]+/g, ''));
    }
    return Number((tor / divisor) / BASE_OFFSET).toFixed(ASSET_DECIMAL);
};

/* simple wrapper to ensure correct number of decimal places on an already converted asset amount */
export const assetFormat = (amount) => {
    return Number(amount).toFixed(ASSET_DECIMAL);
};

export const formatDate = (date, offset) => {
    // date starts as string like "2022-03-07T17:36:49Z"
    // plus an offset in seconds
    date = new Date(Date.parse(date));
    if (typeof offset === 'number' && offset !== 0) {
        date = new Date(date.getTime() + (offset * 1000));
    }

    return dateToString(date);
};

export const formatVote = (option) => {
    switch (option) {
        case 'VOTE_OPTION_YES':
            return 'Yes';
        case 'VOTE_OPTION_NO':
            return 'No';
        case 'VOTE_OPTION_NO_WITH_VETO':
            return 'No with veto';
        case 'VOTE_OPTION_ABSTAIN':
            return 'Abstain';
        default:
            return option;
    }
};

/* inputs allowed:
 * object {denom: "uatom", amount: "1654321"}
 * string "1654321uatom" or "transfer/channel-1/uatom" or "uatom" or "ATOM"
 * all the above examples mean "1.654321 ATOM" and would result in string output like "ATOM" */
export const token = (denom) => {
    if (typeof denom === 'object') {
        denom = denom.denom;
    }
    // take everything after the last "/", convert to upper-case, and remove all digits or dots.
    denom = denom.split('/').pop().toUpperCase().replace(/[0-9.]+/g, '');
    if (denom.startsWith('U') && denom !== 'UMEE') {
        // TODO if anymore known denominations start with "U", we should probably list them here,
        // TODO to prevent possible issues that could occur if we ever did any double processing.
        return denom.substring(1);
    }
    return denom;
};

export function Cosmos(redis, key, action, config, wallets) {
    this.redis   = redis;
    this.key     = key;
    this.action  = action ?? {
        // this is the basic structure of a cosmos action, just for code completion
        logs: [{msg_index: 0}],
        tx: {auth_info: {fee: {amount: [{denom: '', amount: ''}]}}, body: {messages: [{
            '@type': '', validator_src_address: '', validator_dst_address: '',
            option: '', proposal_id: 0, validator_address: '', from_address: '', to_address: '',
            packet: {data: {denom: ''}},
        }]},},
        txhash: '',
    };
    this.config  = config;
    this.wallets = wallets.reduce((a, b) => { a[b] = true; return a; }, {}); // this.wallets = {"chihuahua1..": true}
    this.calc    = new Calculation(this.redis, this.key, this.action, this.config);
    this.fee     = this.action.tx.auth_info.fee.amount[0]; // {"denom":"uhuahua","amount":"1000"}
    this.messageCount = this.action.tx.body.messages.length;

    this.logTx = async () => {
        // amount is ATOM/HUAHUA/etc (not uatom/uhuahua/etc)
        // notice: we assume only one asset type of rewards claiming per tx.
        // we know this to not be true for Terra/Luna, should we want to support that, this will need a revisit
        const delegatorReward = { count: 0, denom: null, amount: 0 };

        // remember, this transaction could have be performed by a grantee, and fee paid by someone else
        // TODO review who paid for the tx, and who the tx is related to.
        console.log(JSON.stringify(this.fee));
        for (const [index, message] of Object.entries(this.action.tx.body.messages)) {
            // for this message of this transaction, find the related events, a
            let events = [];
            for (const log of this.action.logs) {
                if (Number(log.msg_index) === Number(index)) {
                    events = log.events;
                    break;
                }
            }

            // TODO some messages need to be filtered out, because they may not be related to the given wallet..
            // IE: TX is airdrop to 1000 people, only a single message is related..
            // IE: re-stake, if bot is getting their report, just sum the tx cost as business expense
            // IE: re-stake, if user is getting their report, no fee (paid by bot), and then only if they want compounding txs..
            switch (message['@type']) {
                case '/cosmos.distribution.v1beta1.MsgWithdrawValidatorCommission':
                    let commission = getEvent(events, 'withdraw_commission', 'amount');
                    await this.calc.storeRecord({
                        type:      'Other Income',
                        buyAmount: assetAmount(commission),
                        buyCurr:   token(commission),
                        comment:   'Commission Collected',
                        fee:       assetAmount(this.fee, this.messageCount),
                        feeCurr:   token(this.fee),
                        date:      formatDate(this.action.timestamp),
                        txID:      this.action.txhash,
                        exchange:  this.action.chain,
                    });
                    break;
                case '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward':
                    let rewards = getEvent(events, 'withdraw_rewards', 'amount');
                    delegatorReward.count++;
                    delegatorReward.amount += Number(assetAmount(rewards));
                    delegatorReward.denom = token(rewards);
                    console.log(JSON.stringify(delegatorReward));
                    break;
                case '/cosmos.staking.v1beta1.MsgBeginRedelegate':
                    await this.logOtherFee(
                        'Redelegated ' + assetAmount(message.amount) + ' ' + token(message.amount) + ' from "'
                        + getNode(this.action.chain, message.validator_src_address) + '" to "'
                        + getNode(this.action.chain, message.validator_dst_address) + '"'
                    );
                    break;
                case '/cosmos.gov.v1beta1.MsgVote':
                    await this.logOtherFee('Voted "' + formatVote(message.option) + '" on Prop #' + message.proposal_id);
                    break;
                case '/cosmos.staking.v1beta1.MsgDelegate':
                    await this.logOtherFee(
                        'Delegated ' + assetAmount(message.amount) + ' ' + token(message.amount) + ' to "'
                        + getNode(this.action.chain, message.validator_address) + '"'
                    );
                    break;
                case '/cosmos.bank.v1beta1.MsgSend':
                    // determine if this is either send and/or receive
                    if (this.wallets[message.from_address]) {
                        await this.calc.storeRecord({
                            type:       'Withdrawal',
                            sellAmount: assetAmount(message.amount[0]),
                            sellCurr:   token(message.amount[0]),
                            fee:        assetAmount(this.fee, this.messageCount),
                            feeCurr:    token(this.fee),
                            date:       formatDate(this.action.timestamp),
                            txID:       this.action.txhash,
                            exchange:   this.action.chain,
                        });
                    }
                    // notice: since we support multiple wallets, we could be BOTH sender and receiver
                    if (this.wallets[message.to_address]) {
                        await this.calc.storeRecord({
                            type:      'Deposit',
                            buyAmount: assetAmount(message.amount[0]),
                            buyCurr:   token(message.amount[0]),
                            date:      formatDate(this.action.timestamp),
                            txID:      this.action.txhash,
                            exchange:  this.action.chain,
                        });
                    }
                    break;
                case '/ibc.applications.transfer.v1.MsgTransfer':
                    // IBC "Send" Message
                    if (this.wallets[message.sender]) {
                        await this.calc.storeRecord({
                            type:       'Withdrawal',
                            sellAmount: assetAmount(message.token),
                            sellCurr:   token(message.token),
                            comment:    'Sent to ' + message.receiver.split('1')[0].toUpperCase(),
                            fee:        assetAmount(this.fee, this.messageCount),
                            feeCurr:    token(this.fee),
                            date:       formatDate(this.action.timestamp),
                            txID:       this.action.txhash,
                            exchange:   this.action.chain,
                        });
                    }
                    // notice: since we support multiple wallets, we could be BOTH sender and receiver
                    if (this.wallets[message.receiver]) {
                        await this.calc.storeRecord({
                            type:      'Deposit',
                            buyAmount: assetAmount(message.token),
                            buyCurr:   token(message.token),
                            comment:   'Received from ' + message.sender.split('1')[0].toUpperCase(),
                            date:      formatDate(this.action.timestamp),
                            txID:      this.action.txhash,
                            exchange:  this.action.chain,
                        });
                    }
                    break;
                case '/cosmos.staking.v1beta1.MsgCreateValidator':
                    await this.logOtherFee('Created Validator');
                    break;
                case '/cosmos.staking.v1beta1.MsgEditValidator':
                    await this.logOtherFee('Edited Validator');
                    break;
                case '/ibc.core.channel.v1.MsgRecvPacket':
                    // IBC "Receive" Message, has packet.data (in base64) containing: amount, denom, sender, and receiver
                    const buff = new Buffer(message.packet.data, 'base64');
                    const json = buff.toString('ascii');
                    const data = JSON.parse(json);

                    if (this.wallets[data.sender]) {
                        // fee handled by relayer
                        await this.calc.storeRecord({
                            type:       'Withdrawal',
                            sellAmount: assetAmount(data.amount),
                            sellCurr:   token(data.denom),
                            comment:    'Sent to ' + data.receiver.split('1')[0].toUpperCase(),
                            date:       formatDate(this.action.timestamp),
                            txID:       this.action.txhash,
                            exchange:   this.action.chain,
                        });
                    }
                    // notice: since we support multiple wallets, we could be BOTH sender and receiver
                    if (this.wallets[data.receiver]) {
                        await this.calc.storeRecord({
                            type:      'Deposit',
                            buyAmount: assetAmount(data.amount),
                            buyCurr:   token(data.denom),
                            comment:   'Received from ' + data.sender.split('1')[0].toUpperCase(),
                            date:      formatDate(this.action.timestamp),
                            txID:      this.action.txhash,
                            exchange:  this.action.chain,
                        });
                    }
                    break
                case '/ibc.core.client.v1.MsgUpdateClient':
                    console.log('Skipping over MsgUpdateClient');
                    break;
                case '/cosmos.authz.v1beta1.MsgGrant':
                    await this.logOtherFee('AuthZ Grant');
                    break;
                case '/cosmos.authz.v1beta1.MsgRevoke':
                    await this.logOtherFee('AuthZ Revoke');
                    break;
                case '/cosmos.authz.v1beta1.MsgExec':
                    // TODO make it recursive, msgs could be passed into this function again for looping over, events would
                    // need to be passed as well, see events.message array..
                    //
                    // Message: {"@type":"/cosmos.authz.v1beta1.MsgExec",
                    // "grantee":"cerberus13yfd74cezsrjcmhvmh6wkfwfuj7fds5eenhn64",
                    // "msgs":[
                    //
                    // {"@type":"/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward",
                    // "delegator_address":"cerberus1sv0dpae7rwmvguq7eftzlmps2ff59tkaekpl30",
                    // "validator_address":"cerberusvaloper10ypajp3q5zu5yxfud3ayd95th0k7467k3s5vh7"},
                    //
                    // {"@type":"/cosmos.staking.v1beta1.MsgDelegate",
                    // "delegator_address":"cerberus1sv0dpae7rwmvguq7eftzlmps2ff59tkaekpl30",
                    // "validator_address":"cerberusvaloper10ypajp3q5zu5yxfud3ayd95th0k7467k3s5vh7",
                    // "amount":{"denom":"ucrbrus","amount":"154347842"}}
                    //
                    // ]}
                    //
                    // Events: [{"type":"coin_received","attributes":[{"key":"receiver","value":"cerberus1sv0dpae7rwmvguq7eftzlmps2ff59tkaekpl30"},{"key":"amount","value":"154627316ucrbrus"},{"key":"receiver","value":"cerberus1fl48vsnmsdzcv85q5d2q4z5ajdha8yu3fufxvu"},{"key":"amount","value":"154347842ucrbrus"}]},{"type":"coin_spent","attributes":[{"key":"spender","value":"cerberus1jv65s3grqf6v6jl3dp4t6c9t9rk99cd8mcy4u5"},{"key":"amount","value":"154627316ucrbrus"},{"key":"spender","value":"cerberus1sv0dpae7rwmvguq7eftzlmps2ff59tkaekpl30"},{"key":"amount","value":"154347842ucrbrus"}]},{"type":"delegate","attributes":[{"key":"validator","value":"cerberusvaloper10ypajp3q5zu5yxfud3ayd95th0k7467k3s5vh7"},{"key":"amount","value":"154347842ucrbrus"},{"key":"new_shares","value":"154347842.000000000000000000"}]},
                    // {"type":"message","attributes":[
                    //  {"key":"action","value":"/cosmos.authz.v1beta1.MsgExec"},
                    //  {"key":"sender","value":"cerberus1jv65s3grqf6v6jl3dp4t6c9t9rk99cd8mcy4u5"},
                    //  {"key":"module","value":"distribution"},
                    //  {"key":"sender","value":"cerberus1sv0dpae7rwmvguq7eftzlmps2ff59tkaekpl30"},
                    //  {"key":"module","value":"staking"},
                    //  {"key":"sender","value":"cerberus1sv0dpae7rwmvguq7eftzlmps2ff59tkaekpl30"}
                    // ]},
                    // {"type":"transfer","attributes":[{"key":"recipient","value":"cerberus1sv0dpae7rwmvguq7eftzlmps2ff59tkaekpl30"},{"key":"sender","value":"cerberus1jv65s3grqf6v6jl3dp4t6c9t9rk99cd8mcy4u5"},{"key":"amount","value":"154627316ucrbrus"}]},{"type":"withdraw_rewards","attributes":[{"key":"amount","value":"154627316ucrbrus"},{"key":"validator","value":"cerberusvaloper10ypajp3q5zu5yxfud3ayd95th0k7467k3s5vh7"}]}]
                    break;
                default:
                    await discord("key: " + this.key + ", had an unknown transaction type: " + message['@type'] +
                        ", txhash: " + this.action.txhash + ", message: " + JSON.stringify(message) + ", events: " + JSON.stringify(events));
                    break;
            } //
            console.log("Message: " + JSON.stringify(message));
            console.log("Events: " + JSON.stringify(events));
            //await this.calc.storeRecord(message);
        }
        console.log("TxHash: " + this.action.txhash);
        console.log('------------');
        //console.log(JSON.stringify(this.action.tx.auth_info.fee.amount));
        //console.log(JSON.stringify(this.action.tx.body.messages));
        //await this.calc.storeRecord(this.action.tx.body.messages);
        // TODO

        // because it's common to collect multiple rewards in a single transaction, we group it all together
        if (delegatorReward.count > 0) {
            await this.calc.storeRecord({
                type:      'Staking',
                buyAmount: assetFormat(delegatorReward.amount), // already in asset number
                buyCurr:   delegatorReward.denom, // already in token format
                fee:       assetAmount(this.fee, this.messageCount / delegatorReward.count),
                feeCurr:   token(this.fee),
                date:      formatDate(this.action.timestamp),
                txID:      this.action.txhash,
                exchange:  this.action.chain,
            });
        }
    };

    this.logOtherFee = async (comment) => {
        await this.calc.storeRecord({
            type:       'Other Fee',
            sellAmount: assetAmount(this.fee, this.messageCount),
            sellCurr:   token(this.fee),
            comment:    comment,
            date:       formatDate(this.action.timestamp),
            txID:       this.action.txhash,
            exchange:   this.action.chain,
        });
    };
}