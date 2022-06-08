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
        tor = Number(tor?.amount ?? 0);
    } else if (typeof tor === 'string') {
        tor = Number(tor.replace(/[^0-9.]+/g, ''));
    }
    if (tor === 0.0 || typeof tor !== 'number') {
        return ''; // don't put zeros in the output
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
        denom = (denom?.denom ?? '');
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
            packet: {data: ''}, delegator_address: '', msgs: [], grantee: '',
        }]},},
        txhash: '',
    };
    this.config  = config;
    this.wallets = wallets.reduce((a, b) => { a[b] = true; return a; }, {}); // this.wallets = {"chihuahua1..": true}
    this.calc    = new Calculation(this.redis, this.key, this.action, this.config);
    this.fee     = this.action.tx.auth_info.fee.amount[0] ?? '0u'; // {"denom":"uhuahua","amount":"1000"} or fallback to 0
    this.messageCount = this.action.tx.body.messages.length;

    /* arguments are only used internally for a single level of recursion, for authz messages (if relevant and enabled) */
    this.logTx = async (messages, theEvents, fee) => {
        let originalFee = null;
        if (typeof messages === 'undefined') {
            // standard case, we use the messages from the tx.
            messages = this.action.tx.body.messages;
        }
        if (typeof fee !== 'undefined') {
            originalFee = this.fee;
            this.fee = fee;
        }
        // amount is ATOM/HUAHUA/etc (not uatom/uhuahua/etc)
        // notice: we assume only one asset type of rewards claiming per tx.
        // we know this to not be true for Terra/Luna, should we want to support that, this will need a revisit
        const delegatorReward = { count: 0, denom: null, amount: 0 };

        // console.log(JSON.stringify(this.fee));
        for (const [index, message] of Object.entries(messages)) {
            // for this message of this transaction, find the related events, a
            let events = [];
            if (typeof theEvents === 'undefined') {
                // standard case, we use the events from the logs
                for (const log of this.action.logs) {
                    if (Number(log.msg_index) === Number(index)) {
                        events = log.events;
                        break;
                    }
                }
            } else {
                // recursive case, use the override
                events = theEvents;
            }

            // remember most messages need to be compared against our list of wallets, to filter out unrelated stuff
            // IE: TX is airdrop to 1000 people, only a single message is related..
            // IE: re-stake, if bot is getting their report, just sum the tx cost as business expense
            // IE: re-stake, if user is getting their report, no fee (paid by bot), and then only if they want compounding txs..
            switch (message['@type']) {
                case '/cosmos.distribution.v1beta1.MsgWithdrawValidatorCommission':
                    // process.stdout.write('c');
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
                    // process.stdout.write('r');
                    if (this.wallets[message.delegator_address]) {
                        let rewards = getEvent(events, 'withdraw_rewards', 'amount');
                        delegatorReward.count++;
                        delegatorReward.amount += Number(assetAmount(rewards));
                        delegatorReward.denom = token(rewards);
                        // console.log(JSON.stringify(delegatorReward));
                    }
                    break;
                case '/cosmos.staking.v1beta1.MsgBeginRedelegate':
                    // process.stdout.write('m');
                    await this.logOtherFee(
                        'Redelegated ' + assetAmount(message.amount) + ' ' + token(message.amount) + ' from "'
                        + getNode(this.action.chain, message.validator_src_address) + '" to "'
                        + getNode(this.action.chain, message.validator_dst_address) + '"'
                    );
                    break;
                case '/cosmos.gov.v1beta1.MsgVote':
                    // process.stdout.write('v');
                    await this.logOtherFee('Voted "' + formatVote(message.option) + '" on Prop #' + message.proposal_id);
                    break;
                case '/cosmos.staking.v1beta1.MsgUndelegate':
                    // process.stdout.write('u');
                    if (this.wallets[message.delegator_address]) {
                        await this.logOtherFee(
                            'Undelegated ' + assetAmount(message.amount) + ' ' + token(message.amount) + ' from "'
                            + getNode(this.action.chain, message.validator_address) + '"'
                        );
                    }
                    break;
                case '/cosmos.staking.v1beta1.MsgDelegate':
                    // process.stdout.write('d');
                    if (this.wallets[message.delegator_address]) {
                        await this.logOtherFee(
                            'Delegated ' + assetAmount(message.amount) + ' ' + token(message.amount) + ' to "'
                            + getNode(this.action.chain, message.validator_address) + '"'
                        );
                    }
                    break;
                case '/cosmos.bank.v1beta1.MsgSend':
                    // process.stdout.write('s');
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
                case '/cosmos.bank.v1beta1.MsgMultiSend':
                    // process.stdout.write('S');
                    const sender = {};
                    const recipient = {};
                    for (const input of message.inputs) {
                        if (this.wallets[input.address]) {
                            if (typeof sender[token(input.coins[0])] !== 'number') {
                                sender[token(input.coins[0])] = 0.0;
                            }
                            sender[token(input.coins[0])] += Number(assetAmount(input.coins[0]));
                        }
                    }
                    for (const output of message.outputs) {
                        if (this.wallets[output.address]) {
                            if (typeof recipient[token(output.coins[0])] !== 'number') {
                                recipient[token(output.coins[0])] = 0.0;
                            }
                            recipient[token(output.coins[0])] += Number(assetAmount(output.coins[0]));
                        }
                    }
                    for (const [denom, amount] of Object.entries(sender)) {
                        await this.calc.storeRecord({
                            type:       'Withdrawal',
                            sellAmount: assetFormat(amount),
                            sellCurr:   denom,
                            comment:    'Sender of MultiSend',
                            fee:        assetAmount(this.fee, this.messageCount),
                            feeCurr:    token(this.fee),
                            date:       formatDate(this.action.timestamp),
                            txID:       this.action.txhash,
                            exchange:   this.action.chain,
                        });
                    }
                    for (const [denom, amount] of Object.entries(recipient)) {
                        await this.calc.storeRecord({
                            type:      'Deposit',
                            buyAmount: assetFormat(amount),
                            buyCurr:   denom,
                            comment:   'Recipient from MultiSend',
                            date:      formatDate(this.action.timestamp),
                            txID:      this.action.txhash,
                            exchange:  this.action.chain,
                        });
                    }
                    break;
                case '/ibc.applications.transfer.v1.MsgTransfer':
                    // process.stdout.write('t');
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
                    // process.stdout.write('n');
                    await this.logOtherFee('Created Validator', 'Other Expense');
                    break;
                case '/cosmos.staking.v1beta1.MsgEditValidator':
                    // process.stdout.write('e');
                    await this.logOtherFee('Edited Validator', 'Other Expense');
                    break;
                case '/ibc.core.channel.v1.MsgRecvPacket':
                    // process.stdout.write('p');
                    // IBC "Receive" Message, has packet.data (in base64) containing: amount, denom, sender, and receiver
                    const buff = Buffer.from(message.packet.data, 'base64');
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
                    console.log('Skipping over IBC.MsgUpdateClient');
                    break;
                case '/ibc.core.channel.v1.MsgAcknowledgement':
                    console.log('Skipping over IBC.MsgAcknowledgement');
                    break;
                case '/cosmos.authz.v1beta1.MsgGrant':
                    // process.stdout.write('g');
                    await this.logOtherFee('AuthZ Grant');
                    break;
                case '/cosmos.authz.v1beta1.MsgRevoke':
                    // process.stdout.write('k');
                    await this.logOtherFee('AuthZ Revoke');
                    break;
                case '/cosmos.authz.v1beta1.MsgExec':
                    // process.stdout.write('x');
                    if (this.wallets[message.grantee]) {
                        // grantee is the authorized bot, since that's our wallet, we just want to report the expense
                        await this.logOtherFee('AuthZ Bot Fee', 'Other Expense');
                    } else if (this.config.includeAuthZ) {
                        // not-grantee, so message content must be our connection to this transaction, so process it
                        // but only if user opted-in
                        await this.logTx(message.msgs, events, '0u'); // touch of recursion
                    }
                    break;
                case '/lum.network.beam.MsgOpenBeam':
                    // process.stdout.write('b');
                    await this.logOtherFee('OpenBeam "' + message['schema'] + '" Transaction');
                    break;
                default:
                    discord("key: " + this.key + ", had an unknown transaction type: " + message['@type'] +
                        ", txhash: " + this.action.txhash + ", message: " + JSON.stringify(message) +
                        ", events: " + JSON.stringify(events)
                    ).catch(() => {
                        console.log('failed to send discord message');
                    });
                    break;
            }
            // console.log('Message: ' + JSON.stringify(message));
            // console.log('Events : ' + JSON.stringify(events));
            // console.log('--------');
        }

        // because it's common to collect multiple rewards in a single transaction, we group it all together
        if (delegatorReward.count > 0) {
            await this.calc.storeRecord({
                type:      'Staking',
                buyAmount: assetFormat(delegatorReward.amount), // already in asset number
                buyCurr:   delegatorReward.denom, // already in token format
                comment:   'Collected rewards from ' + delegatorReward.count + ' validator' + (delegatorReward.count > 1 ? 's' : ''),
                fee:       assetAmount(this.fee, this.messageCount / delegatorReward.count),
                feeCurr:   token(this.fee),
                date:      formatDate(this.action.timestamp),
                txID:      this.action.txhash,
                exchange:  this.action.chain,
            });
        }
        if (originalFee) {
            // restore the original fee
            this.fee = originalFee;
        }
    };

    this.logOtherFee = async (comment, type) => {
        const hasFee = Number(assetAmount(this.fee)) > 0.0;
        if (hasFee || this.config.includeAuthZ) {
            await this.calc.storeRecord({
                type:       type ?? (hasFee ? 'Other Fee' : 'Logging'),
                sellAmount: assetAmount(this.fee, this.messageCount),
                sellCurr:   token(this.fee),
                comment:    comment,
                date:       formatDate(this.action.timestamp),
                txID:       this.action.txhash,
                exchange:   this.action.chain,
            });
        } else {
            console.log('No fee found for transaction: "' + comment + '".');
        }
    };
}
