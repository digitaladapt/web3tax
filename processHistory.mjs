// this super simple script was used to convert historicalTransactions into groupedTransactions.
// grouping by address, so we can easily get the handful of transactions that are useful to the current request.
import { historicalTransactions } from "./historicalTransactions.mjs";

// {"height":4776075,"timestamp":"2022-03-21 08:10:47.308","sender":"thor1ul3wj2raq5hykwhn57l9rd7ds68am2nmhhh6af","recipient":"thor1vj76dc600lt0k4ff5zdehe52t2et6jr4n7sfjs","asset":"THOR.RUNE","amount":435.99416555},
const output = {};
for (const transaction of historicalTransactions) {
    if ( ! output[transaction.sender]) {
        output[transaction.sender] = [];
    }
    output[transaction.sender].push(transaction);
    if ( ! output[transaction.recipient]) {
        output[transaction.recipient] = [];
    }
    output[transaction.recipient].push(transaction);
}
console.log('export const groupedTransactions = ' + JSON.stringify(output).replace(/}],/g, '}],\n') + ';');

// I did a complex but straightforward regular-expression find-replace to convert the csv file into mjs
// then we use this script to group the transactions by wallet, so that don't have to search the whole list