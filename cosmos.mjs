'use strict';

import {Calculation} from "./calculations.mjs";

export function Cosmos(redis, key, action, config) {
    this.redis  = redis;
    this.key    = key;
    this.action = action;
    this.config = config;
    this.calc   = new Calculation(this.redis, this.key, this.action, this.config);

    this.logTx = async () => {
        // remember, this transaction could have be performed by a grantee, and fee paid by someone else
        const fee = this.action.tx.auth_info.fee.amount; // [{"denom":"uhuahua","amount":"1000"}] // aka 0.001 HUAHUA
        console.log(JSON.stringify(fee));
        for (const [index, message] of Object.entries(this.action.tx.body.messages)) {
            // TODO some messages need to be filtered out, because they may not be related to the given wallet..
            // IE: TX is airdrop to 1000 people, only a single message is related..
            // IE: re-stake, if bot is getting their report, just sum the tx cost as business expense
            // IE: re-stake, if user is getting their report, no fee (paid by bot), and then only if they want compounding txs..
            switch (message['@type']) {
                case '/cosmos.distribution.v1beta1.MsgWithdrawValidatorCommission':
                    // TODO
                    // {"@type":"/cosmos.distribution.v1beta1.MsgWithdrawValidatorCommission","validator_address":"cerberusvaloper1krkmg6f0sjwalkx3nq39yt0upxgys7alcjytq4"}
                    break;
                case '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward':
                    // remember this is commission, and needs to be flagged special as business income
                    // TODO maybe doesn't always have an amount?
                    // {"@type":"/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward","delegator_address":"chihuahua1sv0dpae7rwmvguq7eftzlmps2ff59tkaxyvc9x","validator_address":"chihuahuavaloper1f2026phpmwleuxv5g50tetyenfhqwtt5a94vek"}
                    break;
                case '/cosmos.gov.v1beta1.MsgVote':
                    // TODO
                    // {"@type":"/cosmos.gov.v1beta1.MsgVote","proposal_id":"4","voter":"chihuahua1sv0dpae7rwmvguq7eftzlmps2ff59tkaxyvc9x","option":"VOTE_OPTION_YES"}
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
                default:
                    // TODO see if I can trigger a discord message or something..
                    console.log('uknown type: ' + message['@type']);
                    break;
            } //
            console.log("Message: " + JSON.stringify(message));
            let events = [];
            for (const log of this.action.logs) {
                if (Number(log.msg_index) === Number(index)) {
                    events = log.events;
                    break;
                }
            }
            console.log("Events: " + JSON.stringify(events));
            //await this.calc.storeRecord(message);
        }
        console.log("TxHash: " + this.action.txhash);
        console.log('------------');
        //console.log(JSON.stringify(this.action.tx.auth_info.fee.amount));
        //console.log(JSON.stringify(this.action.tx.body.messages));
        //await this.calc.storeRecord(this.action.tx.body.messages);
        // TODO
    };
}