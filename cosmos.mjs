'use strict';

import { Calculation } from "./calculations.mjs";
import { dateToString } from "./functions.mjs";

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
        tor = Number(tor.replace(/[^0-9.]+/, ''));
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
 * string "1654321uatom" or "uatom" or "ATOM"
 * all the above examples mean "1.654321 ATOM" and would result in string output like "ATOM" */
export const token = (denom) => {
    if (typeof denom === 'object') {
        denom = denom.denom;
    }
    denom = denom.toUpperCase().replace(/[0-9.]+/, '');
    if (denom.startsWith('U') && denom !== 'UMEE') {
        // TODO if anymore known denominations start with "U", we should probably list them here,
        // TODO to prevent issues caused by double processing.
        return denom.substring(1);
    }
    return denom;
};

export function Cosmos(redis, key, action, config) {
    this.redis  = redis;
    this.key    = key;
    this.action = action;
    this.config = config;
    this.calc   = new Calculation(this.redis, this.key, this.action, this.config);

    this.logTx = async () => {
        // amount is ATOM/HUAHUA/etc (not uatom/uhuahua/etc), assumes only one asset type of rewards claiming per tx.
        const delegatorReward = { count: 0, denom: null, amount: 0 };
        const messageCount = this.action.tx.body.messages.length;

        // remember, this transaction could have be performed by a grantee, and fee paid by someone else
        // TODO review who paid for the tx, and who the tx is related to.
        const fee = this.action.tx.auth_info.fee.amount[0]; // {"denom":"uhuahua","amount":"1000"} // aka 0.001 HUAHUA
        console.log(JSON.stringify(fee));
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
                        fee:       assetAmount(fee, messageCount),
                        feeCurr:   token(fee),
                        date:      formatDate(this.action.timestamp),
                        txID:      this.action.txhash,
                        exchange:   this.action.chain,
                    });
                    break;
                case '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward':
                    let rewards = getEvent(events, 'withdraw_rewards', 'amount');
                    delegatorReward.count++;
                    delegatorReward.amount += Number(assetAmount(rewards));
                    delegatorReward.denom = token(rewards);
                    console.log(JSON.stringify(delegatorReward));
                    break;
                case '/cosmos.gov.v1beta1.MsgVote':
                    await this.calc.storeRecord({
                        type:      'Other Fee',
                        sellAmount: assetAmount(fee, messageCount),
                        sellCurr:   token(fee),
                        comment:    'Voted "' + formatVote(message.option) + '" on Prop #' + message.proposal_id,
                        date:       formatDate(this.action.timestamp),
                        txID:       this.action.txhash,
                        exchange:   this.action.chain,
                    });
                    break;
                case '/cosmos.staking.v1beta1.MsgBeginRedelegate':
                    // TODO
                    // {"@type":"/cosmos.staking.v1beta1.MsgBeginRedelegate","delegator_address":"chihuahua1sv0dpae7rwmvguq7eftzlmps2ff59tkaxyvc9x","validator_src_address":"chihuahuavaloper1krkmg6f0sjwalkx3nq39yt0upxgys7alpxrka7","validator_dst_address":"chihuahuavaloper19vwcee000fhazmpt4ultvnnkhfh23ppwxll8zz","amount":{"denom":"uhuahua","amount":"100000000000"}}
                    break;
                case '/cosmos.staking.v1beta1.MsgDelegate':
                    // TODO
                    // {"@type":"/cosmos.staking.v1beta1.MsgDelegate","delegator_address":"chihuahua1sv0dpae7rwmvguq7eftzlmps2ff59tkaxyvc9x","validator_address":"chihuahuavaloper1krkmg6f0sjwalkx3nq39yt0upxgys7alpxrka7","amount":{"denom":"uhuahua","amount":"3000000000"}}
                    break;
                case '/cosmos.bank.v1beta1.MsgSend':
                    // TODO
                    // {"@type":"/cosmos.bank.v1beta1.MsgSend","from_address":"chihuahua1sv0dpae7rwmvguq7eftzlmps2ff59tkaxyvc9x","to_address":"chihuahua1krkmg6f0sjwalkx3nq39yt0upxgys7alj3rtwz","amount":[{"denom":"uhuahua","amount":"94465000000"}]}
                    break;
                case '/ibc.applications.transfer.v1.MsgTransfer':
                    // TODO
                    // {"@type":"/ibc.applications.transfer.v1.MsgTransfer","source_port":"transfer","source_channel":"channel-7","token":{"denom":"uhuahua","amount":"976829656"},"sender":"chihuahua1sv0dpae7rwmvguq7eftzlmps2ff59tkaxyvc9x","receiver":"osmo1sv0dpae7rwmvguq7eftzlmps2ff59tkad2jxjk","timeout_height":{"revision_number":"1","revision_height":"3241724"},"timeout_timestamp":"0"}
                    break;
                case '/cosmos.staking.v1beta1.MsgCreateValidator':
                    break;
                case '/cosmos.staking.v1beta1.MsgEditValidator':
                    break;
                default:
                    // TODO see if I can trigger a discord message or something..
                    console.log('unknown type: ' + message['@type']);
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
                fee:       assetAmount(fee, messageCount / delegatorReward.count),
                feeCurr:   token(fee),
                date:      formatDate(this.action.timestamp),
                txID:      this.action.txhash,
                exchange:   this.action.chain,
            });
        }
    };
}