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
<body>
    <div class="content">
        <section class="section">
            <div class="container">
                <h1 class="title">
                    Hello World
                </h1>
                <p class="subtitle">
                    My first website with <strong>Bulma</strong>!
                </p>
            </div>
        </section>
    </div>
</body>
</html>`;

