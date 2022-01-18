import * as handler from './handler.mjs';

const answer = await handler.submitAddresses({ queryStringParameters: {
    eth:  '0x0c85b035f138bBDe4f6D200C1c90dA7136427D4B',
    bch:  'qqpwmnx6kflq6klscg53nnspshwtcd5vyq4j6gmrdh',
    bnb:  'bnb1wdvpszxj2j0m6g8lpp0q89qcp6anzrhp6pgaz9',
    btc:  'bc1ql8sxnllxkhvxnke2lq5nrjqvng77r9cjpceckx',
    ltc:  'ltc1qpx4mem52nvmc57ghpkjulzstx8gnn2uf45mns9',
    thor: 'thor1m402rfftzrufugu383sn7mwpdp2qmeq4vx8l27',
}});

console.log(answer);

const key = JSON.parse(answer.body).key;

const report = await handler.fetchReport({ queryStringParameters: {
    key: key,
}});

const output = JSON.parse(report.body);

console.log(output.transactions.pop());
