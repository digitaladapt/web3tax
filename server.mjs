import http from 'http';
import url from 'url';
import { submitAddresses, getStatus, fetchReport, purgeReport } from './handler.mjs';

const hostname = 'localhost';
const port = 3000;

let indexPage = '';

const server = http.createServer((req, res) => {
    res.statusCode = 200;
    const parsed = url.parse(req.url, true);
    // {"query":{"key":"value"},"pathname":"/path"}

    //res.setHeader('Content-Type', 'application/json');
    //res.end(JSON.stringify(parsed));

    switch (parsed.pathname) {
        case '/':
        case '/index.html':
            res.setHeader('Content-Type', 'text/html');
            res.end(indexPage);
            break;
        case '/generate':
            console.log('generate|' + Date.now() + '|' + JSON.stringify(parsed.query));
            res.setHeader('Content-Type', 'application/json');
			submitAddresses({
                queryStringParameters: parsed.query,
            }).then((output) => {
                res.end(output.body);
            });
            break;
        case '/status':
            res.setHeader('Content-Type', 'application/json');
			getStatus({
                queryStringParameters: parsed.query,
            }).then((output) => {
                res.end(output.body);
            });
            break;
        case '/report':
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader("Content-Disposition", "attachment;filename=thorchain-report.csv");
			fetchReport({
                queryStringParameters: parsed.query,
            }).then((output) => {
                res.end(output.body);
            });
            break;
        case '/clear':
            res.setHeader('Content-Type', 'application/json');
			purgeReport({
                queryStringParameters: parsed.query,
            }).then((output) => {
                res.end(output.body);
            });
            break;
    }
});

server.listen(port, hostname, () => {
    console.log(`Server running at http://${hostname}:${port}/`);
});

indexPage = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>ThorChain Tax Calculator</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bulma@0.9.3/css/bulma.min.css">
</head>
<body style="background-color: #ebfffc;">
    <section class="section">
        <div class="container">
            <div class="columns is-desktop">
                <div class="column">
                    <div class="box content">
                        <h1 class="title">
                            ThorChain Tax Calculator
                        </h1>
                        <p class="subtitle">
                            Generate import-ready CSV file of your blockchain transactions, just by entering your wallet addreses.
                        </p>
                        <form class="taxForm">
                            <div class="field"><div class="control">
                                <label class="label">THOR <input type="text" name="thor" class="input" placeholder="thor1..." autocomplete="on"></label>
                            </div></div><div class="field"><div class="control">
                                <label class="label">BNB  <input type="text" name="bnb"  class="input" placeholder="bnb1..." autocomplete="on"></label>
                            </div></div><div class="field"><div class="control">
                                <label class="label">BTC  <input type="text" name="btc"  class="input" placeholder="bc1..." autocomplete="on"></label>
                            </div></div><div class="field"><div class="control">
                                <label class="label">LTC  <input type="text" name="ltc"  class="input" placeholder="ltc1..." autocomplete="on"></label>
                            </div></div><div class="field"><div class="control">
                                <label class="label">BCH  <input type="text" name="bch"  class="input" placeholder="q|p..." autocomplete="on"></label>
                            </div></div><div class="field"><div class="control">
                                <label class="label">ETH  <input type="text" name="eth"  class="input" placeholder="0x..." autocomplete="on"></label>
                            </div></div><div class="field"><div class="control">
                                <label class="label">DOGE <input type="text" name="doge" class="input" placeholder="coming soon" autocomplete="on" disabled></label>
                            </div></div><div class="field is-grouped">
                                <div class="control">
                                    <button type="submit" class="button is-info taxGo">Generate Report</button>
                                </div><div class="control">
                                    <span class="button is-static is-info is-inverted taxStatus">Status: awaiting user input.</span>
                                </div>
                            </div>
                        </form>
                        <div class="taxResults is-hidden notification is-primary is-light">
                            <form class="taxDownload" method="get" action="/report">
                                <input type="hidden" name="key" class="taxKey">
                                <div class="field"><div class="control">
                                    <label class="label">CSV Format</label>
                                    <div class="select is-success"><select name="format">
                                        <option value="koinly">Koinly</option>
                                        <option value="cointracking">CoinTracking</option>
                                    </select></div>
                                </div></div><div class="field"><div class="control">
                                    <button type="submit" class="button is-success taxGet">Download CSV</button>
                                </div></div>
                            </form>
                        </div>
                    </div>
                </div>
                <div class="column">
                    <div class="box content">
                        <h2>Donate</h2>
                        <p>I made this, because I use ThorChain, and needed a way to load hundreds of transactions into my tax software, without having to manually adding each one.</p>
                        <p>I thought others would likely benefit from it as well. If it helps save you time/money, please consider at least a small donation to help keep this project going.</p>
                        <div class="level">
                            <div class="level-item has-text-centered">
                                <figure>
                                  <figcaption>THOR</figcaption>
                                  <img src="https://www.digitaladapt.com/thor.png">
                                </figure>
                            </div><div class="level-item has-text-centered">
                                <figure>
                                  <figcaption>BNB</figcaption>
                                  <img src="https://www.digitaladapt.com/bnb.png">
                                </figure>
                            </div>
                        </div>
                        <ul>
                            <li><strong>thor1vkevvt4u0t7yra4xfk79hy7er38462w8yszx8y</strong></li>
                            <li><strong>bnb1v54rp3w9h2hlresmvl0msf4vycnvnuc7nyp6cr</strong></li>
                            <li><strong>bc1ql7a704xh4ptzcvm8lx6r8hwxcmau09dul6yh7y</strong></li>
                            <li><strong>ltc1qzw06k68yesj62ja0z9p4s527et496tdtstxvs5</strong></li>
                            <li><strong>qzcxt5hl30yk3w052n3x6wjvky9rwn0p6guz95qmje</strong> (BCH)</li>
                            <li><strong>0x165d707704716b02c050935F8Ce6E0429C9829e6</strong> (AVAX, BSC, ETH, FTM, etc.)</li>
                            <li><strong>terra1t8magaxn4q6jllgx4hregjh4gtn2k96caqmd7p</strong></li>
                            <li><strong>cosmos1wkzpd9uxftghyweh0dd4v58x727ugvqkp0khn5</strong></li>
                        </ul>
                    </div>
                    <div class="box content">
                        <h2>Give Feedback</h2>
                        <p>If you have any thoughts, questions, or would like to report a bug, you can either get ahold of <a href="https://twitter.com/digitaladapt" target="_blank">me on Twitter</a>,
                            or you can also use <a href="https://docs.google.com/forms/d/e/1FAIpQLScIeyYEYAHw1fNXakh34ZBpfRv4mZHL0Hu2aCMNMj6PRwTDHQ/viewform" target="_blank">this Google Form</a>.</p> 
                    </div>
                </div>
            </div>
            <div class="columns is-desktop">
                <div class="column">
                    <div class="box content">
                        <h3>Legal</h3>
                        <p>While every attempt has been made to ensure the calculations are correct, use the data at your own risk.</p>
                        <p>This is provided for informational purposes only. It does not constitute financial, tax or legal advice.</p>
                        <p>No warranty, and we will not be liable for any loss or damage of any nature.</p>
                    </div>
                </div><div class="column">
                    <div class="box content">
                        <h3>Privacy</h3>
                        <p>Wallet addresses, and the generated report are only cached for 2 hours, and never saved to any hard drive.</p>
                        <p>No Google Analytics or anything like that, but I do keep a log of how often the generate report API is called.</p>
                    </div>
                </div><div class="column">
                    <div class="box content">
                        <h3>About Me</h3>
                        <p>Made by <a href="https://www.digitaladapt.com/" target="_blank">DigtialAdapt</a>, find <a href="https://twitter.com/digitaladapt" target="_blank">me on Twitter</a>.</p>
                        <p>&copy; 2022 DigitalAdapt, all rights reserved.</p>
                        <p>Interface built with <a href="https://zeptojs.com/" target="_blank">Zepto.js</a> and <a href="https://bulma.io/" target="_blank">Bulma</a>.</p>
                        <p>Backend powered with <a href="https://nodejs.org/" target="_blank">Node.js</a> and <a href="https://redis.io/" target="_blank">Redis</a>.</p>
                    </div>
                </div>
            </div>
        </div>
    </section>
    <script src="https://zeptojs.com/zepto.min.js"></script>
    <script>
        Zepto(($) => {
            let key = null;

            $('.taxGo').on('click', (event) => {
                const updateStatus = () => {
                    $.getJSON('https://web3tax.info/status?key=' + key, (theStatus) => {
                        $('.taxStatus').text(theStatus.message);
                        if (theStatus.ready) {
                            // system ready, show the download form
                            $('.taxResults').removeClass('is-hidden');
                            $('.taxGo').removeClass('is-loading');
                        } else {
                            // wait half a second, and then check the status again
                            setTimeout(updateStatus, 500);
                        }
                    });
                };

                $('.taxGo').addClass('is-loading');
                $('.taxStatus').text('Submitting Request...');
                console.log($('.taxForm').serialize());
                $.getJSON('https://web3tax.info/generate?' + $('.taxForm').serialize(), (response) => {
                    $('.taxStatus').text(response.message);
                    if (response.status === 'success') {
                        // set the key
                        key = response.key;
                        $('.taxKey').val(key);

                        // handle the status
                        updateStatus();
                    } else {
                        $('.taxGo').removeClass('is-loading');
                    }
                });
                // do not allow this event to propagate
                return false;
            });
        });
    </script>
</body>
</html>`;

