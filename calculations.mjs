'use strict';

/* things to remember:
 * this.storeRecord() should occur in logical order of operations,
 * since order called determines output order
 *
 * when pulling data out of redis, you have to decode the json back into an object
 * after creating/updating a record in redis, always set the expiration
 *
 * offsets applied to timestamp
 * -1 receiving into RUNE wallet
 *  0 core operation
 * +1 sending from RUNE wallet
 * +2 extra steps
 */

// FIXME pair down to just formatDate and chainToken... remove other dependencies
import {calculateBasis, chainToken, formatDate, logToWallet, storeRecord, token} from "./functions.mjs";

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
        if (this.action.out[0].coins[0].asset !== RUNE_ASSET) {
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
                    type: 'Withdrawal',
                    sellAmount: assetAmount(sent.coins[0].amount),
                    sellCurr: this.token(sent.coins[0].asset),
                    comment: 'Sent to Pool: ' + chainToken(this.action.pools[0]) + '/THOR.RUNE',
                    ...this.actionFee(this.token(sent.coins[0].asset)),
                    date: formatDate(this.action.date),
                });
            }

            // optionally, a "non-taxable income" for the liquidity units
            if (this.config.detailedLP) {
                await this.storeRecord({
                    type:      'Income (non taxable)',
                    buyAmount: units,
                    buyCurr:   this.token(this.action.pools[0]) + '-RUNE',
                    comment:   'Sent to Pool: ' + chainToken(this.action.pools[0]) + '/THOR.RUNE',
                    date:      formatDate(this.action.date, 1),
                });
            }
        }
    };

    this.logUpgrade = async () => {
        if (this.config.includeUpgrades) {
            await this.logToWallet();

            // no fees for upgrades (beyond external chain transaction fee)
            await this.storeRecord({
                type:       'Trade',
                buyAmount:  assetAmount(this.action.out[0].coins[0].amount),
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

    this.logWithdraw = async () => {
        // the nice name of the token asset in the pool alongside RUNE
        const asset = this.token(this.action.pools[0]);

        // calculated tokens, to determine cost-basis, currently just first-in-first-out, but should work on supporting more
        const basis = this.calculateBasis();

        // coins actually received (note we initialize to zero)
        const coins = {
            RUNE:    0,
            [asset]: 0,
        };

        // TODO from here...
    };

    /* ---------------------------------------------------------------------- */
    /* --- internal support functions --------------------------------------- */
    /* ---------------------------------------------------------------------- */

    /* make a deposit record for each non-RUNE asset (and track the cost-basis) */
    this.logToWallet = async (comment) => {
        const coins = {};

        for (const receive of this.action.in) {
            coins[this.token(receive.coins[0].asset)] = assetAmount(receive.coins[0].amount);

            // before most operations from a non-RUNE asset, we have to "receive" it to the RUNE wallet
            // no fee, since it was already handled in the other wallet
            if (receive.coins[0].asset !== RUNE_ASSET) {
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
            coins.LP = assetAmount(this.action.metadata.addLiquidity.liquidityUnits);
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

    this.storeRecord = async (record) => {}; // TODO

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
        return asset.split('.')[1].split('-')[0];
    };

    /* ---------------------------------------------------------------------- */
    /* --- internal support functions for withdrawal ------------------------ */
    /* ---------------------------------------------------------------------- */

    this.calculateBasis = async () => {
        // liquidity-units actually removed, remember, this is a negative number
        const units = Number(assetAmount(this.action.metadata.withdraw.liquidityUnits));

        // the nice name of the token asset in the pool alongside RUNE
        const asset = this.token(this.action.pools[0]);

        // calculated tokens, to determine cost-basis
        const basis = {LP: 0, RUNE: 0, [asset]: 0};

        const pop  = this.config.basisMethod === 'LIFO' ? 'rPop'  : 'lPop';
        const push = this.config.basisMethod === 'LIFO' ? 'rPush' : 'lPush';

        do {
            // calculate the (first|last)-in-first-out rune/asset sent into the liquidity pools, so we can handle the accounting correctly
            try {
                const deposit = JSON.parse(await this.redis[pop](this.key + '_pooled_' + this.action.pools[0]));

                if (Number((deposit.LP + basis.LP + units).toFixed(8)) > 0) {
                    const percent = (deposit.LP + basis.LP + units) / deposit.LP;

                    // since we need just a portion of this current deposit, add the needed amount to our basis
                    basis.LP     = Number((basis.LP     + deposit.LP            - (deposit.LP            * percent)).toFixed(8));
                    basis[asset] = Number((basis[asset] + (deposit[asset] ?? 0) - ((deposit[asset] ?? 0) * percent)).toFixed(8));
                    basis.RUNE   = Number((basis.RUNE   + (deposit.RUNE ?? 0)   - ((deposit.RUNE ?? 0)   * percent)).toFixed(8));

                    // update the deposit, with the leftover, so we can track the next withdraw correctly
                    deposit.LP     = Number((deposit.LP            * percent).toFixed(8));
                    deposit[asset] = Number(((deposit[asset] ?? 0) * percent).toFixed(8));
                    deposit.RUNE   = Number(((deposit.RUNE ?? 0)   * percent).toFixed(8));

                    // take the leftover and put it back into the pooled, and break out of the loop
                    await this.redis[push](this.key + '_pooled_' + this.action.pools[0], deposit);
                    break;
                } else {
                    basis.LP     = Number((basis.LP     + deposit.LP           ).toFixed(8));
                    basis[asset] = Number((basis[asset] + (deposit[asset] ?? 0)).toFixed(8));
                    basis.RUNE   = Number((basis.RUNE   + (deposit.RUNE ?? 0)  ).toFixed(8));
                }
            } catch (error) {
                throw 'missing cost-basis for pool: ' + chainToken(action.pools[0]);
            }
        } while (Number((basis.LP + units).toFixed(8)) < 0);

        return basis;
    };
}
