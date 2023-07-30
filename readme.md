# WARNING: I've stopped working on this project. #
Feel free to fork the code and do whatever. At last check some of APIs I was calling have changed their output, and some updates to the code will be needed to get this processing again.

If you get it working again, I'll redirect people to your version.

## Web3Tax.Info (ThorChain Tax Calculator) ##
### Summary ###
Generate import-ready CSV file of your (ThorChain) blockchain transactions.
### High Level Technical Details ###
ThorChain Midgard API parser written in NodeJS, with long-term plans of becoming much more.
### Milestones ###
* 24th, Jan, 2022: ThorChain Swaps, and Liquidity Pools, operations fully supported.
  Uses First-In-First-Out cost-basis for LP to calculate profit/loss.
  Supports CSV formats for CoinTracker, CoinTracking, and Koinly.
* 27th, Jan, 2022: Added support for $DOGE, and $RUNE Upgrade transactions.
* 7th, Feb, 2022: Added support for CryptoTaxCalculator CSV format.
* 16th, Feb, 2022: Open sourced the project.
* 17th, Feb, 2022: "Check LP Status" button added.
* 18th, Feb, 2022: "Check LP Status" now supports partial withdrawals.
* 1st, Mar, 2022: Added support for LIFO cost basis method.
* 4th, Mar, 2022: ThorChain to ThorChain send transactions now supported via new data source API.
* 28th, Mar, 2022: Chihuahua and Cerberus chains are now tentatively supported.
* 9th, Apr, 2022: Reported previously missed ThorChain transaction hashes.
* 9th, Apr, 2022: UI/UX updates, auto-complete related addresses.
* 19th, Apr, 2022: Added support for TaxBit CSV format.
* 6th, Jun, 2022: Stability improvements, midgard rate-limiting.
* 31st, May, 2022: Style updates as part of larger branding efforts.
* 13th, Jun, 2022: Lum Network chain is now supported.
* 17th, Jun, 2022: Added support for CoinLedger CSV format.
* 8th, Jul, 2022: Lum Network now using validator names instead of addresses.
### Roadmap ###
ThorChain related improvements (in no particular order)
* fix rare edge-case bug: very large swaps with multiple output transactions, second output currently gets ignored.
* Auto-switch between Midgard servers based on availability.
* handle failed swaps better (just report cost, instead of in-trade-out)
* Add support for $RUNE to $RUNE transactions (not provided by Midgard API).
* Add support for stage-net (separate Midgard, Stage-RUNE asset, separate LPs, sthor addresses, etc).
* Add support for more cost-basis, such as LIFO, etc. (if there is any community interest).
* Other operations within ThorChain such as bonding, donating, etc. (if there is any community interest).
* report how much the user currently has in each of the LP pools along with their cost-basis (IE: the user's unrealized gain/loss).

Cosmos related expansion
* Expand into the Cosmos Universe, start with the simplest: Chihuahua Chain.
  * Send, Receive, Stake, Claim-Rewards, Un-stake, IBC Send, and IBC Receive.
  * Track re-delegation, voting, and such as misc. expenses.
* would like to track any slashing that occurs.
* Also, for validators, tracking commission earned.
* When expanding to multiple Cosmos chains, automatically infer addresses by
  [bech32 conversion](https://jasbanza.github.io/convert-bech32-address/).
  (applies to most chains, known exceptions: bnb, thor, and terra)
* Chains of interest:
  * Cosmos Hub $ATOM
  * Osmosis $OSMO
  * Chihuahua $HUAHUA
  * Juno $JUNO (and JunoSwap $RAW)
  * Stargaze $STARS
  * Comdex $CMDX
  * Desmos $DSM
  * Kava $KAVA
  * Sommelier $SOMM
  * Ki $XKI
  * Terra $LUNA/$UST (maybe)
  * and others depending on community interest. The goal would be the codebase supports all the basic operations on all
    chains, and we just have to build out extra parts for whatever is unique to that chain.

Donation-ware improvements
* estimate how much time the user saved by not having to manually enter their transactions (with a polite donation suggestion).
* automatically categorize any funds sent to donation addresses accordingly in the CSV report.

### Running Locally ###

You'll need NodeJS, Redis.

After cloning the repo, within the project install the dependencies with NPM:
```
npm install
```

If your redis is running on the same machine, the default config is good, otherwise adjust the settings in either
`run-test.sh` before calling it.
```
./run-test.sh
# Ctrl-C to stop
```

Once running, visit http://localhost:3001/ to test it.

### Supporting ###
Lots of ways to help, tell me what features you want/need.<br/>
Trying it out and let me know if you run into any bugs.<br/>
If you are technically inclined, submitting code pull-requests.<br/>
If you'd like to financially support, donation addresses are below:

| THOR                                                                                  | BNB                                                                                 |
|---------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------|
| ![thor1vkevvt4u0t7yra4xfk79hy7er38462w8yszx8y](https://www.digitaladapt.com/thor.png) | ![bnb1v54rp3w9h2hlresmvl0msf4vycnvnuc7nyp6cr](https://www.digitaladapt.com/bnb.png) |

* thor1vkevvt4u0t7yra4xfk79hy7er38462w8yszx8y
* bnb1v54rp3w9h2hlresmvl0msf4vycnvnuc7nyp6cr
* bc1ql7a704xh4ptzcvm8lx6r8hwxcmau09dul6yh7y
* ltc1qzw06k68yesj62ja0z9p4s527et496tdtstxvs5
* qzcxt5hl30yk3w052n3x6wjvky9rwn0p6guz95qmje (BCH)
* 0x165d707704716b02c050935F8Ce6E0429C9829e6 (AVAX, BSC, ETH, FTM, etc.)
* terra1t8magaxn4q6jllgx4hregjh4gtn2k96caqmd7p
* cosmos1wkzpd9uxftghyweh0dd4v58x727ugvqkp0khn5

I'm building this in my spare time, started it because I needed a way of handling hundreds of ThorChain transactions,
and realized I can't be the only one having this issue. This is my way of helping support the ThorChain and Cosmos
communities, in hope that this will help our communities grow and reach mass adoption.
