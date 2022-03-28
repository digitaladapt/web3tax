'use strict';

/* things to remember:
 * this.storeRecord() should occur in logical order of operations,
 * since order called determines output order
 *
 * when pulling data out of redis, you have to decode the json back into an object
 * after creating/updating a record in redis, always set the expiration
 *
 * offsets applied to timestamp
 * -2 extra steps
 * -1 receiving into RUNE wallet
 *  0 core operation
 * +1 sending from RUNE wallet
 * +2 extra steps
 */

import { chainToken, formatDate } from "./functions.mjs";

/* 1 RUNE === 100000000 tor; RUNE has upto 8 digits after the decimal point */
const BASE_OFFSET   = 100000000;
const ASSET_DECIMAL = 8;
const RUNE_ASSET    = 'THOR.RUNE';

/* convert tor to RUNE, or sats to BTC, etc.
 * output is string, remember to wrap with Number() before doing math.
 * notice we round all math to exactly 8 places at every step, to ensure rounding errors aren't a problem */
export const assetAmount = (tor) => {
    return Number(tor / BASE_OFFSET).toFixed(ASSET_DECIMAL);
};

export const isSynth = (asset) => {
    return asset.includes('/');
};
export const isExternal = (asset) => {
    return ! asset.includes('/');
};

/* refactored all functions which need redis, config, etc. into a class
 * so that we can stop passing those variables everywhere. */
export function Calculation(redis, key, action, config) {
    this.redis  = redis;
    this.key    = key;
    this.action = action ?? {
        // this is the basic structure of a midgard action, just for code completion
        in: [{coins: [{asset: '', amount: 0}]}],
        out: [{coins: [{asset: '', amount: 0}]}],
        pools: [],
        metadata: {addLiquidity: {liquidityUnits: 0}, withdraw: {liquidityUnits: 0}}
    }; // */
    this.config = config;

    /* user sent/received rune , either has one "in" or one "out",  */
    this.logSend = async () => {
        if (this.action.in) {
            await this.storeRecord({
                type:       'Deposit',
                buyAmount:  assetAmount(this.action.in[0].coins[0].amount),
                buyCurr:    this.token(this.action.in[0].coins[0].asset),
                date:       formatDate(this.action.date),
                txID:       this.action.in[0].txID,
            });
        } else {
            await this.storeRecord({
                type:       'Withdrawal',
                sellAmount: assetAmount(this.action.out[0].coins[0].amount),
                sellCurr:   this.token(this.action.out[0].coins[0].asset),
                            ...this.actionFee(),
                date:       formatDate(this.action.date),
                txID:       this.action.out[0].txID,
            });
        }
    };

    /* user swapped one asset for another, exactly one "in", multiple "out"s are possible
     * (but uncommon), in and out can be the same asset (failed swap) */
    this.logTrade = async () => {
        await this.logToWallet();

        // large trades can sometime be broken up into multiple "out"s, so we sum them up
        let buyAmount = 0;
        for (const sent of this.action.out) {
            buyAmount += Number(assetAmount(sent.coins[0].amount));
        }
        await this.storeRecord({
            type:       'Trade',
            buyAmount:  buyAmount,
            buyCurr:    this.token(this.action.out[0].coins[0].asset),
            sellAmount: assetAmount(this.action.in[0].coins[0].amount),
            sellCurr:   this.token(this.action.in[0].coins[0].asset),
                        ...this.actionFee(),
            date:       formatDate(this.action.date),
        });

        // after a swap to a non-RUNE asset, we have to "send" it to other wallet
        // no fee, since it was already handled in the trade
        if (this.action.out[0].coins[0].asset !== RUNE_ASSET && isExternal(this.action.out[0].coins[0].asset)) {
            for (const sent of this.action.out) {
                await this.storeRecord({
                    type:       'Withdrawal',
                    sellAmount: assetAmount(sent.coins[0].amount),
                    sellCurr:   this.token(sent.coins[0].asset),
                    date:       formatDate(this.action.date, 1),
                    txID:       this.action.out[0].txID,
                });
            }
        }
    };

    /* user added one or two assets into a liquidity pool, if two, one is always RUNE
     * logToWallet() tracks deposits in redis(key_pooled) */
    this.logDeposit = async () => {
        const units = await this.logToWallet();

        // then a "withdrawal" transaction for each asset sent into the pool
        if (this.config.standardLP) {
            for (const sent of this.action.in) {
                await this.storeRecord({
                    type:       'Withdrawal',
                    sellAmount: assetAmount(sent.coins[0].amount),
                    sellCurr:   this.token(sent.coins[0].asset),
                    comment:    'Sent to Pool: ' + chainToken(this.action.pools[0]) + '/THOR.RUNE',
                                ...this.actionFee(this.token(sent.coins[0].asset)),
                    date:       formatDate(this.action.date),
                });
            }

            // optionally, a "non-taxable income" for the liquidity units
            if (this.config.detailedLP) {
                await this.storeRecord({
                    type:      'Income (non taxable)',
                    buyAmount: units,
                    buyCurr:   this.token(this.action.pools[0]) + '-RUNE',
                    comment:   'Units from Pool: ' + chainToken(this.action.pools[0]) + '/THOR.RUNE',
                    date:      formatDate(this.action.date, 1),
                });
            }
        }
    };

    /* user swapped non-native (BNB|ETH).RUNE for native THOR.RUNE */
    this.logUpgrade = async () => {
        if (this.config.includeUpgrades) {
            await this.logToWallet();

            // large trades can sometime be broken up into multiple "out"s, so we sum them up
            // no fees for upgrades (beyond external chain transaction fee)
            let buyAmount = 0;
            for (const sent of this.action.out) {
                buyAmount += Number(assetAmount(sent.coins[0].amount));
            }
            await this.storeRecord({
                type:       'Trade',
                buyAmount:  buyAmount,
                buyCurr:    this.token(this.action.out[0].coins[0].asset),
                sellAmount: assetAmount(this.action.in[0].coins[0].amount),
                sellCurr:   this.token(this.action.in[0].coins[0].asset),
                comment:    'Upgraded ' + chainToken(this.action.in[0].coins[0].asset),
                date:       formatDate(this.action.date),
            });
        } else {
            // even if people don't consider the upgrade a trade, it still moved to the RUNE wallet
            await this.logToWallet('Upgraded ' + chainToken(this.action.in[0].coins[0].asset));
        }
    };

    /* user withdrew one or two assets from a liquidity pool, must carefully calculate the difference
     * between the basis and what was withdrawn to report any implicit trades, along with profit/loss */
    this.logWithdraw = async () => {
        // the nice name of the token asset in the pool alongside RUNE
        const asset = this.token(this.action.pools[0]);

        // calculated tokens, to determine cost-basis, currently just first-in-first-out, but should work on supporting more
        const basis = await this.calculateBasis();

        // coins actually received (note we initialize to zero)
        const coins = {
            RUNE:    0,
            [asset]: 0,
        };

        for (const received of this.action.out) {
            coins[this.token(received.coins[0].asset)] = Number(assetAmount(received.coins[0].amount));
        }

        // first a "deposit" transaction for each asset received from the pool
        if (this.config.standardLP) {
            // if desired, a "withdrawal" of the LP Units
            if (this.config.detailedLP) {
                await this.storeRecord({
                    type:       'Expense (non taxable)',
                    sellAmount: basis.LP,
                    sellCurr:   this.token(this.action.pools[0]) + '-RUNE',
                    comment:    'Units to Pool: ' + chainToken(this.action.pools[0]) + '/THOR.RUNE',
                    date:       formatDate(this.action.date, -2),
                });
            }

            // a "deposit" for each basis we get out (1 or 2)
            // the rune withdraw request transaction fee will be included in the first "deposit"
            if (basis.RUNE > 0) {
                await this.storeRecord({
                    type:      'Deposit',
                    buyAmount: basis.RUNE,
                    buyCurr:   'RUNE',
                               ...this.actionFee('RUNE'),
                    comment:   'Received from Pool: ' + chainToken(this.action.pools[0]) + '/THOR.RUNE',
                    date:      formatDate(this.action.date, -1),
                });
            }
            if (basis[asset] > 0) {
                await this.storeRecord({
                    type:      'Deposit',
                    buyAmount: basis[asset],
                    buyCurr:   asset,
                               ...this.actionFee('RUNE', (basis.RUNE > 0)),
                    comment:   'Received from Pool: ' + chainToken(this.action.pools[0]) + '/THOR.RUNE',
                    date:      formatDate(this.action.date, -1),
                });
            }
        }

        // if needed, one or more trade/profit/loss depending on how basis (input) compares to coins (output)
        // remember: both basis and coins will have at least RUNE or asset (and either may have both)
        const assetProfit = Number((coins[asset] - basis[asset]).toFixed(8));
        const runeProfit  = Number((coins.RUNE - basis.RUNE).toFixed(8));
        if (basis.RUNE > 0) {
            if (coins.RUNE <= 0) {
                if (basis[asset] <= 0) { // && implied(coins[asset] > 0)
                    // RUNE to ASSET -------------------------------------------
                    // console.log('RUNE-to-ASSET');
                    await this.logLPTrade(coins[asset], asset, basis.RUNE, 'RUNE');
                } else { // basis[asset] > 0 && implied(coins[asset] > 0)
                    // BOTH to ASSET -------------------------------------------
                    // console.log('BOTH-to-ASSET');
                    // so we convert rune to asset, if basis[asset] < coins[asset], just take the difference, as the
                    // output of the trade however, if basis[asset] >= coins[asset], we'll report all the losses
                    if (basis[asset] < coins[asset]) {
                        // note the final extra parameter, which adds back in the basis, for the withdrawal
                        await this.logLPTrade(assetProfit, asset, basis.RUNE, 'RUNE', false, basis[asset]);
                    } else {
                        // unlikely case: started with both assets, withdraw as asset, but got less asset than was deposited, multiple losses
                        await this.logLPLoss(basis.RUNE, 'RUNE');
                        if (basis[asset] > coins[asset]) {
                            await this.logLPLoss(assetProfit, asset, true);
                        }
                    }
                }
            } else { // coins.RUNE > 0
                if (basis[asset] <= 0) {
                    if (coins[asset] > 0) {
                        // RUNE to BOTH ----------------------------------------
                        // console.log('RUNE-to-BOTH');
                        // so we convert half the basis.RUNE into coins[asset], then income/loss the difference between
                        // half the basis.RUNE and the coins.RUNE remember "half" doesn't always divide evenly,
                        // so we'll have to do basis-halfRune for the other half
                        const halfRune = Number((basis.RUNE / 2).toFixed(8));
                        await this.logLPTrade(coins[asset], asset, Number((basis.RUNE - halfRune).toFixed(8)), 'RUNE');
                        await this.logLPIncomeOrLoss(Number((coins.RUNE - halfRune).toFixed(8)), 'RUNE', true);
                    } else { // coins[asset] <= 0
                        // RUNE to RUNE ----------------------------------------
                        // console.log('RUNE-to-RUNE');
                        // simple profit/loss
                        await this.logLPIncomeOrLoss(runeProfit, 'RUNE');
                    }
                } else { // basis[asset] > 0
                    if (coins[asset] <= 0) {
                        // BOTH to RUNE ----------------------------------------
                        // console.log('BOTH-to-RUNE');
                        // so we convert asset to rune, if basis.RUNE < coins.RUNE, just take the difference,
                        // as the output of the trade however, if basis.RUNE >= coins.RUNE, we'll report all the losses
                        if (basis.RUNE < coins.RUNE) {
                            await this.logLPTrade(runeProfit, 'RUNE', basis[asset], asset);
                        } else {
                            // unlikely case: started with both assets, withdraw as RUNE, but got less RUNE than was
                            // deposited, multiple losses
                            await this.logLPLoss(basis[asset], asset);
                            if (basis.RUNE > coins.RUNE) {
                                await this.logLPLoss(runeProfit, 'RUNE', true);
                            }
                        }
                    } else { // coins[asset] > 0
                        // BOTH to BOTH ----------------------------------------
                        // console.log('BOTH-to-BOTH');
                        // simple profit/loss for RUNE
                        await this.logLPIncomeOrLoss(runeProfit, 'RUNE');
                        // simple profit/loss and withdrawal for ASSET
                        await this.logLPIncomeOrLoss(assetProfit, asset);
                        await this.logLPWithdraw(coins[asset], asset);
                    }
                }
            }
        } else { // basis.RUNE <= 0
            if (coins.RUNE > 0) { // && implied(basis[asset] > 0)
                if (coins[asset] <= 0) {
                    // ASSET to RUNE -------------------------------------------
                    // console.log('ASSET-to-RUNE');
                    await this.logLPTrade(coins.RUNE, 'RUNE', basis[asset], asset);
                } else { // coins[asset] > 0
                    // ASSET to BOTH -------------------------------------------
                    // console.log('ASSET-to-RUNE');
                    // so we convert half the basis[asset] into coins.RUNE, then income/loss the difference between
                    // half the basis[asset] and the coins[asset] remember "half" doesn't always divide evenly,
                    // so we'll have to do basis-halfAsset for the other half
                    const halfAsset = Number((basis[asset] / 2).toFixed(8));
                    await this.logLPTrade(coins.RUNE, 'RUNE', Number((basis[asset] - halfAsset).toFixed(8)), asset);
                    await this.logLPIncomeOrLoss(Number((coins[asset] - halfAsset).toFixed(8)), asset, true);
                }
            } else { // coins.RUNE <= 0 && implied(basis[asset] > 0 && coins[asset] > 0)
                // ASSET to ASSET ----------------------------------------------
                // console.log('ASSET-to-ASSET');
                // simple profit/loss and withdrawal
                await this.logLPIncomeOrLoss(assetProfit, asset);
                await this.logLPWithdraw(coins[asset], asset);
            }
        }
    };

    /* ---------------------------------------------------------------------- */
    /* --- internal support functions --------------------------------------- */
    /* ---------------------------------------------------------------------- */

    /* make a deposit record for each non-RUNE asset (and track the cost-basis) */
    this.logToWallet = async (comment) => {
        const coins = { LP: 0, RUNE: 0 }; // enforce order of fields

        for (const receive of this.action.in) {
            coins[this.token(receive.coins[0].asset)] = Number(assetAmount(receive.coins[0].amount));

            // before most operations from a non-RUNE asset, we have to "receive" it to the RUNE wallet
            // no fee, since it was already handled in the other wallet
            if (receive.coins[0].asset !== RUNE_ASSET && isExternal(receive.coins[0].asset)) {
                await this.storeRecord({
                    type:      'Deposit',
                    buyAmount: coins[this.token(receive.coins[0].asset)],
                    buyCurr:   this.token(receive.coins[0].asset),
                    comment:   comment ?? null,
                    date:      formatDate(this.action.date, -1),
                    txID:      receive.txID,
                });
            }
        }

        // when we are adding liquidity, note how much was swapped in
        if ('addLiquidity' in this.action.metadata) {
            coins.LP = Number(assetAmount(this.action.metadata.addLiquidity.liquidityUnits));
            return await this.trackCostBasis(coins);
        }
    };

    /* within each pool, we keep records of each deposit, so we know the cost-basis */
    this.trackCostBasis = async (coins) => {
        await this.redis.rPush(this.key + '_pooled_' + this.action.pools[0], JSON.stringify(coins));

        if (typeof this.config.pooled[this.action.pools[0]] !== 'boolean') {
            // whenever we create a new redis key, need to set the expiration
            this.config.pooled[this.action.pools[0]] = true;
            await this.redis.expire(this.key + '_pooled_' + this.action.pools[0], process.env.TTL);

            // we also keep a list of all pools utilized by this user
            await this.redis.rPush(this.key + '_pooled', this.action.pools[0]);
            await this.redis.expire(this.key + '_pooled', process.env.TTL);
        }

        return Number(coins.LP);
    };

    /* save this object into redis, each "record" is the data for a single line in the resulting CSV file */
    this.storeRecord = async (record) => {
        await this.redis.rPush(this.key + '_record', JSON.stringify(record));

        // whenever we store a new thing, we need to set the expiration
        if (this.config.firstRecord) {
            this.config.firstRecord = false;
            await this.redis.expire(this.key + '_record', process.env.TTL);
        }
    };

    /* calculate fee. if provided, asset ("RUNE", "BTC", etc) will limit only return fees of that type
     * setting skip true will bypass calculating the fee */
    this.actionFee = (asset, skip) => {
        if (skip) {
            return {};
        }
        if (typeof asset !== 'string') {
            asset = null;
        }

        for (const [type, entry] of Object.entries(this.action.metadata)) {
            if (entry.hasOwnProperty('networkFees')) {
                for (const fee of entry.networkFees) {
                    if (!asset || asset === this.token(fee.asset)) {
                        return {
                            fee: assetAmount(fee.amount),
                            feeCurr: this.token(fee.asset),
                        };
                    }
                }
            }
            if (
                // transaction to request withdrawal (from LP) still have a transaction cost:
                // newer transactions have no coin "in" (so we have to check the address), but previously 1tor was sent
                ((type === 'withdraw' && ((this.action.in[0].coins.length === 0 && this.action.in[0].address.startsWith('thor1'))
                    || this.action.in[0].coins[0].asset === RUNE_ASSET))
                // deposit/swaps from RUNE have also a transaction cost, that wouldn't have been accounted anywhere else
                || (type === 'swap' && this.action.in[0].coins[0].asset === RUNE_ASSET && this.action.out[0].coins[0].asset !== RUNE_ASSET)
                || (type === 'deposit')) && (asset === 'RUNE' || !asset)
            ) {
                return {
                    fee:     0.02, // REMEMBER: this fee could change in the future
                    feeCurr: 'RUNE',
                };
            }
        }
    };

    /* convert "BNB.BUSD-BD1" into "BUSD" */
    this.token = (asset) => {
        if (this.config.includeUpgrades) {
            // in order to include the upgrades properly, we have to make non-native distinct
            switch (asset) {
                case 'ETH.RUNE-0X3155BA85D5F96B2D030A4966AF206230E46849CB':
                    return 'RUNE-ETH';
                case 'BNB.RUNE-B1A':
                    return 'RUNE-B1A';
                // default: proceed as normal
            }
        }
        return asset.split(/[.\/]/)[1].split('-')[0];
    };

    /* ---------------------------------------------------------------------- */
    /* --- internal support functions for withdrawal ------------------------ */
    /* ---------------------------------------------------------------------- */

    /* review deposit history to determine assets provided for the given number of liquidity units */
    this.calculateBasis = async () => {
        // liquidity-units actually removed, remember, this is a negative number
        const units = Number(assetAmount(this.action.metadata.withdraw.liquidityUnits));

        // the nice name of the token asset in the pool alongside RUNE
        const asset = this.token(this.action.pools[0]);

        // calculated tokens, to determine cost-basis
        const basis = {LP: 0, RUNE: 0, [asset]: 0};

        const pop  = this.config.basisMethod === 'LIFO' ? 'rPop'  : 'lPop';
        const push = this.config.basisMethod === 'LIFO' ? 'rPush' : 'lPush';

        // const basisLog = [];
        do {
            // calculate the (first|last)-in-first-out rune/asset sent into the liquidity pools, so we can handle the accounting correctly
            try {
                const deposit = JSON.parse(await this.redis[pop](this.key + '_pooled_' + this.action.pools[0]));
                // basisLog.push(JSON.stringify(deposit));

                if (Number((deposit.LP + basis.LP + units).toFixed(8)) > 0) {
                    const percent = (deposit.LP + basis.LP + units) / deposit.LP;

                    // basisLog.pop();
                    // basisLog.push(JSON.stringify({
                    //     LP:    Number((deposit.LP            - (deposit.LP            * percent)).toFixed(8)),
                    //     RUNE:  Number(((deposit[asset] ?? 0) - ((deposit[asset] ?? 0) * percent)).toFixed(8)),
                    //     ASSET: Number(((deposit.RUNE ?? 0)   - ((deposit.RUNE ?? 0)   * percent)).toFixed(8)),
                    //     PARTIAL: asset,
                    // }));

                    // since we need just a portion of this current deposit, add the needed amount to our basis
                    basis.LP     = Number((basis.LP     + deposit.LP            - (deposit.LP            * percent)).toFixed(8));
                    basis[asset] = Number((basis[asset] + (deposit[asset] ?? 0) - ((deposit[asset] ?? 0) * percent)).toFixed(8));
                    basis.RUNE   = Number((basis.RUNE   + (deposit.RUNE ?? 0)   - ((deposit.RUNE ?? 0)   * percent)).toFixed(8));

                    // update the deposit, with the leftover, so we can track the next withdraw correctly
                    deposit.LP     = Number((deposit.LP            * percent).toFixed(8));
                    deposit[asset] = Number(((deposit[asset] ?? 0) * percent).toFixed(8));
                    deposit.RUNE   = Number(((deposit.RUNE ?? 0)   * percent).toFixed(8));

                    // take the leftover and put it back into the pooled, and break out of the loop
                    await this.redis[push](this.key + '_pooled_' + this.action.pools[0], JSON.stringify(deposit));
                    break;
                } else {
                    basis.LP     = Number((basis.LP     + deposit.LP           ).toFixed(8));
                    basis[asset] = Number((basis[asset] + (deposit[asset] ?? 0)).toFixed(8));
                    basis.RUNE   = Number((basis.RUNE   + (deposit.RUNE ?? 0)  ).toFixed(8));
                }
            } catch (error) {
                throw 'missing cost-basis for pool: ' + chainToken(this.action.pools[0]);
            }
        } while (Number((basis.LP + units).toFixed(8)) < 0);
        // console.log(basisLog, units, "\n\n");

        return basis;
    };

    /* log implicit trade from an LP withdrawal */
    this.logLPTrade = async (buyAmount, buyCurr, sellAmount, sellCurr, skipFee, extraWithdraw) => {
        // console.log({ type: 'Trade', buyAmount: buyAmount, buyCurr: buyCurr, sellAmount: sellAmount, sellCurr: sellCurr, extra: extraWithdraw });
        await this.storeRecord({
            type: 'Trade',
            buyAmount:  buyAmount,
            buyCurr:    buyCurr,
            sellAmount: sellAmount,
            sellCurr:   sellCurr,
                        ...this.actionFee(buyCurr, skipFee),
            comment:    'Trade from Pool: ' + chainToken(this.action.pools[0]) + '/THOR.RUNE',
            date:       formatDate(this.action.date),
        });

        if (buyCurr !== 'RUNE') {
            await this.logLPWithdraw(Number((buyAmount + (extraWithdraw ?? 0)).toFixed(8)), buyCurr);
        }
    };

    /* log an external asset going to the other wallet */
    this.logLPWithdraw = async (sellAmount, sellCurr) => {
        // console.log({ type: 'Withdrawal', sellAmount: sellAmount, sellCurr: sellCurr });
        // no fee, since it was already handled by now
        await this.storeRecord({
            type:       'Withdrawal',
            sellAmount: sellAmount,
            sellCurr:   sellCurr,
            date:       formatDate(this.action.date, 2),
            txID:       this.outMatch(sellCurr).txID,
        });
    };

    /* log realized profit as the result of withdrawing from a liquidity pool */
    this.logLPIncome = async (buyAmount, buyCurr, skipFee) => {
        // console.log({ type: 'Staking', buyAmount: buyAmount, buyCurr: buyCurr });
        await this.storeRecord({
            type: 'Staking',
            buyAmount:  buyAmount,
            buyCurr:    buyCurr,
                        ...this.actionFee(buyCurr, skipFee),
            comment:    'Profit from Pool: ' + chainToken(this.action.pools[0]) + '/THOR.RUNE',
            date:       formatDate(this.action.date, 1),
        });
    };

    /* log realized loss as the result of withdrawing from a liquidity pool */
    this.logLPLoss = async (sellAmount, sellCurr, skipFee) => {
        // console.log({ type: 'Lost', sellAmount: Math.abs(sellAmount), sellCurr: sellCurr });
        // we use the absolute value, so that we can easily log negative profit
        await this.storeRecord({
            type: 'Lost',
            sellAmount: Math.abs(sellAmount),
            sellCurr:   sellCurr,
                        ...this.actionFee(sellCurr, skipFee),
            comment:    'Loss from Pool: ' + chainToken(this.action.pools[0]) + '/THOR.RUNE',
            date:       formatDate(this.action.date, 1),
        });
    };

    /* log realized profit/loss as the result of withdrawing from a liquidity pool */
    this.logLPIncomeOrLoss = async (amount, curr, skipFee) => {
        // notice if exactly equal, no income/loss transaction will be logged
        if (amount > 0) {
            await this.logLPIncome(amount, curr, skipFee);
        } else if (amount < 0) {
            await this.logLPLoss(amount, curr, skipFee);
        }
    };

    /* find the action.out that matches the given asset, or default to the first,
     * used to determine transaction ids */
    this.outMatch = (asset) => {
        for (const sent of this.action.out) {
            if (this.token(sent.coins[0].asset) === asset) {
                return sent;
            }
        }
        return this.action.out[0];
    };
}
