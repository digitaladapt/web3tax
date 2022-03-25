'use strict';

import { Calculation } from "./calculations.mjs";
import {dateToString, getNode} from "./functions.mjs";

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
    this.action  = action;
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
                            sellCurr:   token(data.demon),
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

                    // message.packet.data base64 decoded:
                    // {"amount":"15000000000",
                    // "denom":"transfer/channel-113/uhuahua",
                    // "receiver":"chihuahua1sv0dpae7rwmvguq7eftzlmps2ff59tkaxyvc9x",
                    // "sender":"osmo1sv0dpae7rwmvguq7eftzlmps2ff59tkad2jxjk"}
                    //
                    // Message: {"@type":"/ibc.core.channel.v1.MsgRecvPacket",
                    // "packet":{
                    //      "sequence":"24264",
                    //      "source_port":"transfer",
                    //      "source_channel":"channel-113",
                    //      "destination_port":"transfer",
                    //      "destination_channel":"channel-7",
                    //      "data":"eyJhbW91bnQiOiIxNTAwMDAwMDAwMCIsImRlbm9tIjoidHJhbnNmZXIvY2hhbm5lbC0xMTMvdWh1YWh1YSIsInJlY2VpdmVyIjoiY2hpaHVhaHVhMXN2MGRwYWU3cndtdmd1cTdlZnR6bG1wczJmZjU5dGtheHl2Yzl4Iiwic2VuZGVyIjoib3NtbzFzdjBkcGFlN3J3bXZndXE3ZWZ0emxtcHMyZmY1OXRrYWQyanhqayJ9",
                    //      "timeout_height":{"revision_number":"1","revision_height":"575364"},
                    //      "timeout_timestamp":"0"},
                    // "proof_commitment":"CrcICrQICj9jb21taXRtZW50cy9wb3J0cy90cmFuc2Zlci9jaGFubmVscy9jaGFubmVsLTExMy9zZXF1ZW5jZXMvMjQyNjQSIBjEor+zB0D6o6gMCMHz8c2QrAzrjftQraLwEV4jLxGkGg4IARgBIAEqBgACioniAiIsCAESKAIEioniAiBuoVYxj8UZ7ScVMHpeIStK88tlxpgAGoPbZ+RvmsiE5CAiLAgBEigEBoqJ4gIgTJrzQTm2jamNOHhK/cwOXs23HlP4g6UDgNOg3GDMYzYgIiwIARIoBgqKieICII8WIOSxyhSorHyenIRrVmmymXAc2ghTX6nbS5IVxXwuICIsCAESKAgaioniAiCJGs4mgQ/aW292sW0x/izm1EA4lbtK1JPmfkduDxo75iAiLAgBEigKOoqJ4gIgs1C54wVNCCOjmW+4c4bJk92KhCEwUEYGLKsnAkSOOUcgIi0IARIpDpABioniAiDOwQwPxVfuat5UjdRxgFRta11wIilFNVIj2kae1xDwiiAiLQgBEikQuAKKieICIAK7EZyDSWJ1FFIybD8haPtcj6ihivKaSEOEYAF1HnSLICIvCAESCBSIBYqJ4gIgGiEg5Lz3sRpY1gCxxI9KZCCyOSmymfw/79VEcAjRavxVOVwiLQgBEikW2giKieICID8t9b+q3tj+vjraJbn2XoSvYS1CVmvsyfrpYcTYy0ZtICItCAESKRrIH4qJ4gIgzFu7x61bHMWcRjxmeT5MGa+mp6GT62QZzFPrgU4rcxMgIi0IARIpHORlioniAiB1GVcdbB4eLT2YDJAMc+p9LBFG6rRPmHEFc9/nJnDwYSAiMAgBEgkgwP8BioniAiAaISChOEOmQ5cNw10LSzSG1maF1Q3Ob5Ng1tCBla+wJ4RdTCIwCAESCSLA8QKKieICIBohICsaET6CWnGUcDGVpP9RHOJKwcczpy7tPsApKh5hNW9ZIjAIARIJJKTOBIqJ4gIgGiEgLdalQgS6V/+WoA3uoc93kWcY5KXvZT+Mz3rWoCjqwUYiLggBEiomnN0SioniAiBsMnNrc/aQrI1fDJseGc9+zEgKr8bR/unaZlTH5sTQaCAiMAgBEgko1N0eioniAiAaISAX4yBWDS4vHE2SOjauBaFosrh0z7ug+TkzvtQJldmfbCIwCAESCSqK1zCKieICIBohICY6dtdsXXmWkOSX6xjW6O0NAH3TJ2lqQkf7kGXl3Ps/Ii8IARIrLNTgmAGKieICINDFIbeQweJXWvgy507Gjd67ANcy14wQu9sXjtk6vXbiICIxCAESCi6O99cBioniAiAaISB+Dm3Omewg7Zj/tPXnDNC9igIhSa22ZzwC9pqv+PRmDSIvCAESKzCm3fICioniAiBVj79GWw16BSR9V9Bbl10HV+uAabWt+onBtsLFSLWmriAK/AEK+QEKA2liYxIgRL3AeAu9Wl806wnH+spDvqsU2VjcQQh7gIN+gBc2nSIaCQgBGAEgASoBACIlCAESIQGbZTR0qNFk2XjLtNARSQJw8we4YVz89HkkpNieJUa3nSIlCAESIQFW2Du7vFqfVFw7xCPCzJPVwS48mWnk8fbmuVnchewWTiInCAESAQEaIPAQa3Fb1+xJQaytjhBT5xlkN9aKqsRJc+UaF12uWp1gIiUIARIhAWHHLyjksl7KC+FQdUPktAHe0YCHr1ofnyq5IVNWqhSPIicIARIBARogiXRm87lc0eRAE4pd1aAAkDcu+0nQQJ6xz6Hn24hv7OU=",
                    // "proof_height":{"revision_number":"1","revision_height":"2900550"},
                    // "signer":"chihuahua15md2qvgma8lnvqv67w0umu2paqkqkheg6l5zfa"}
                    //
                    // Events: [{"type":"coin_received","attributes":[{"key":"receiver","value":"chihuahua1sv0dpae7rwmvguq7eftzlmps2ff59tkaxyvc9x"},{"key":"amount","value":"15000000000uhuahua"}]},{"type":"coin_spent","attributes":[{"key":"spender","value":"chihuahua1r726yra3euctv92qqfxh45xztewgp2qjh3k5k8"},{"key":"amount","value":"15000000000uhuahua"}]},{"type":"fungible_token_packet","attributes":[{"key":"module","value":"transfer"},{"key":"receiver","value":"chihuahua1sv0dpae7rwmvguq7eftzlmps2ff59tkaxyvc9x"},{"key":"denom","value":"transfer/channel-113/uhuahua"},{"key":"amount","value":"15000000000"},{"key":"success","value":"true"}]},{"type":"message","attributes":[{"key":"action","value":"/ibc.core.channel.v1.MsgRecvPacket"},{"key":"module","value":"ibc_channel"},{"key":"sender","value":"chihuahua1r726yra3euctv92qqfxh45xztewgp2qjh3k5k8"},{"key":"module","value":"ibc_channel"}]},{"type":"recv_packet","attributes":[{"key":"packet_data","value":"{\"amount\":\"15000000000\",\"denom\":\"transfer/channel-113/uhuahua\",\"receiver\":\"chihuahua1sv0dpae7rwmvguq7eftzlmps2ff59tkaxyvc9x\",\"sender\":\"osmo1sv0dpae7rwmvguq7eftzlmps2ff59tkad2jxjk\"}"},{"key":"packet_data_hex","value":"7b22616d6f756e74223a223135303030303030303030222c2264656e6f6d223a227472616e736665722f6368616e6e656c2d3131332f75687561687561222c227265636569766572223a2263686968756168756131737630647061653772776d76677571376566747a6c6d70733266663539746b61787976633978222c2273656e646572223a226f736d6f31737630647061653772776d76677571376566747a6c6d70733266663539746b6164326a786a6b227d"},{"key":"packet_timeout_height","value":"1-575364"},{"key":"packet_timeout_timestamp","value":"0"},{"key":"packet_sequence","value":"24264"},{"key":"packet_src_port","value":"transfer"},{"key":"packet_src_channel","value":"channel-113"},{"key":"packet_dst_port","value":"transfer"},{"key":"packet_dst_channel","value":"channel-7"},{"key":"packet_channel_ordering","value":"ORDER_UNORDERED"},{"key":"packet_connection","value":"connection-25"}]},{"type":"transfer","attributes":[{"key":"recipient","value":"chihuahua1sv0dpae7rwmvguq7eftzlmps2ff59tkaxyvc9x"},{"key":"sender","value":"chihuahua1r726yra3euctv92qqfxh45xztewgp2qjh3k5k8"},{"key":"amount","value":"15000000000uhuahua"}]},{"type":"write_acknowledgement","attributes":[{"key":"packet_data","value":"{\"amount\":\"15000000000\",\"denom\":\"transfer/channel-113/uhuahua\",\"receiver\":\"chihuahua1sv0dpae7rwmvguq7eftzlmps2ff59tkaxyvc9x\",\"sender\":\"osmo1sv0dpae7rwmvguq7eftzlmps2ff59tkad2jxjk\"}"},{"key":"packet_data_hex","value":"7b22616d6f756e74223a223135303030303030303030222c2264656e6f6d223a227472616e736665722f6368616e6e656c2d3131332f75687561687561222c227265636569766572223a2263686968756168756131737630647061653772776d76677571376566747a6c6d70733266663539746b61787976633978222c2273656e646572223a226f736d6f31737630647061653772776d76677571376566747a6c6d70733266663539746b6164326a786a6b227d"},{"key":"packet_timeout_height","value":"1-575364"},{"key":"packet_timeout_timestamp","value":"0"},{"key":"packet_sequence","value":"24264"},{"key":"packet_src_port","value":"transfer"},{"key":"packet_src_channel","value":"channel-113"},{"key":"packet_dst_port","value":"transfer"},{"key":"packet_dst_channel","value":"channel-7"},{"key":"packet_ack","value":"{\"result\":\"AQ==\"}"},{"key":"packet_ack_hex","value":"7b22726573756c74223a2241513d3d227d"},{"key":"packet_connection","value":"connection-25"}]}]
                    break
                case '/ibc.core.client.v1.MsgUpdateClient':
                    console.log('Skipping over MsgUpdateClient');
                    // Message: {"@type":"/ibc.core.client.v1.MsgUpdateClient",
                    // "client_id":"07-tendermint-45",
                    // "header":{"@type":"/ibc.lightclients.tendermint.v1.Header",
                    //      "signed_header":{"header":{"version":{"block":"11","app":"1"},
                    //      "chain_id":"osmosis-1","height":"3089541","time":"2022-02-05T12:58:12.342966118Z","last_block_id":{"hash":"LJsfVp60/IfiHWo5RupUoXRPdBPJIOfjaaHv1dQB/zA=","part_set_header":{"total":5,"hash":"fMb+8UGV1Q+G3GY8dHvviUp4clsNvLg3KB1igZJpoe0="}},
                    //      "last_commit_hash":"jdYdVITbc7uPLogypU2wqvwG+s5VhPmhgpcLNtltqvM=","data_hash":"Mn30oKI3gZIv8inyL273r4e/ho1zNoxFxclqZxhtB2g=","validators_hash":"oswUygmqxr4oE+98Y+lW6M5qeiNi0dEKQelh5XoXEmw=","next_validators_hash":"oswUygmqxr4oE+98Y+lW6M5qeiNi0dEKQelh5XoXEmw=","consensus_hash":"qWfVX6y7oZq5YUkEjyR2xGV+wD0lt4qBr1uPCgj2Hf8=","app_hash":"PEEFa+t/176Ucs71y60RpvmrndVw5hajvm2zWJby7hs=","last_results_hash":"HNPC+0RP3V13upCylcy/R4kKmw4/6D4RmYW3K0TfxYQ=","evidence_hash":"47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=","proposer_address":"A8AWq37DLZ+Nd6/bGR+/U+oI2Rc="},
                    //      "commit":{"height":"3089541","round":0,"block_id":{"hash":"QkPeWm/03+qqmO/swJPwzsk0G8KbBO5G60fxi5KdLUM=","part_set_header":{"total":5,"hash":"IEzwgxHUlhyXCGt9V1HMUg7+D+5/TjIM7tBBneI2tzg="}},
                    //      "signatures":[{"block_id_flag":"BLOCK_ID_FLAG_ABSENT","validator_address":null,"timestamp":"0001-01-01T00:00:00Z","signature":null} ... ],
                    //      "proposer":{"address":"ZraWZuv3dufry+GXq6RmpxLicHY=","pub_key":{"ed25519":"wB25StLxbzmD0uTiFiH6xySZd0H13kyanNUvvlUpa34="},
                    //      "voting_power":"4981930","proposer_priority":"0"},
                    //      "total_voting_power":"87627844"}},
                    //      "signer":"chihuahua1ylchv523h7qnpwvul0a7w93mvn5z7zvpys3v6j"}
                    //
                    // Events: [{"type":"message","attributes":[{"key":"action","value":"/ibc.core.client.v1.MsgUpdateClient"},{"key":"module","value":"ibc_client"}]},
                    // {"type":"update_client","attributes":[{"key":"client_id","value":"07-tendermint-45"},{"key":"client_type","value":"07-tendermint"},
                    // {"key":"consensus_height","value":"1-3089541"},
                    // ...
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