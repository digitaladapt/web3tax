import * as handler from './handler.mjs';

const sleep = async (millis) => {
    return new Promise((resolve) => {
        setTimeout(resolve, millis)
    })
}

const purged = await handler.purgeReport({ queryStringParameters: {
    key: 'da871c1f67623e442631a90b9f6614de0cd01e13e236a1c2153b26dc2d70da5e',
}});

console.log(purged);
console.log('---------------------------------------------------------------');

const answer = await handler.submitAddresses({ queryStringParameters: {
    // zinc
    eth:  '0x0c85b035f138bBDe4f6D200C1c90dA7136427D4B',
    btc:  'bc1ql8sxnllxkhvxnke2lq5nrjqvng77r9cjpceckx',
    bnb:  'bnb1wdvpszxj2j0m6g8lpp0q89qcp6anzrhp6pgaz9',
    ltc:  'ltc1qpx4mem52nvmc57ghpkjulzstx8gnn2uf45mns9',
    bch:  'qqpwmnx6kflq6klscg53nnspshwtcd5vyq4j6gmrdh',
    thor: 'thor1m402rfftzrufugu383sn7mwpdp2qmeq4vx8l27',
    // iron
    ethB:  '0xa7cb11bfcc066f7ac00d66b8efd00585678a0ded',
    ltcB:  'ltc1q42uvu6d0xse5usxldmqczw66qze8kzsyqm484p',
    bchB:  'qzq4e3nt9dxv4lx04ds66u8urhgc8nvh4cwakgrz9y',
    thorB: 'thor1n8zradsyr3hv9nw6w4zm7cgdzl3klw8y5l7ta4',
    // arb
    bnbC:  'bnb1jq758am8vmmr3s4cnrgnch2twwatjjwhldhta0',
    thorC: 'thor18clw7atkd3mcczg7afuxxyanhvswxwjlr4hk6l',
    // lt
    ethD:  '0x502E463351DC027023812E9D58dF3aCc10D9F5F0',
    btcD:  'bc1qeranqanlpzvawwc2u3f2xatd94wa3vfzzj8563',
    bnbD:  'bnb1g6fqddyem7juxa4pjmqmghln7ws48ccyjcw748',
    ltcD:  'ltc1qelw95yrud59n3pyft44vnhl4r7w56v6y3uwths',
    bchD:  'qr4a2zp2p30sjkzad2zpdmnq33e86g3k3uhu2yaa0e',
    thorD: 'thor1wj59g6f5t9dpduhfx7su5ye6zucq44tujy3e4n',
    // star
    ethE:  '0x165d707704716b02c050935F8Ce6E0429C9829e6',
    btcE:  'bc1ql7a704xh4ptzcvm8lx6r8hwxcmau09dul6yh7y',
    bnbE:  'bnb1v54rp3w9h2hlresmvl0msf4vycnvnuc7nyp6cr',
    ltcE:  'ltc1qzw06k68yesj62ja0z9p4s527et496tdtstxvs5',
    bchE:  'qzcxt5hl30yk3w052n3x6wjvky9rwn0p6guz95qmje',
    thorE: 'thor1vkevvt4u0t7yra4xfk79hy7er38462w8yszx8y',
}});

const key = JSON.parse(answer.body).key;

console.log(answer);
console.log('---------------------------------------------------------------');

let theStatus = null;
do {
    await sleep(100);

    theStatus = await handler.getStatus({ queryStringParameters: {
        key: key,
    }});

    console.log(theStatus);
    console.log('---------------------------------------------------------------');
} while (! JSON.parse(theStatus.body).ready);

const report = await handler.fetchReport({ queryStringParameters: {
    key: key,
    format: 'cointracking',
}});

const output = report.body;

console.log(output);
console.log('---------------------------------------------------------------');

