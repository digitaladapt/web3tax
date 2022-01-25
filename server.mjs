import fs from 'fs';
import http from 'http';
import url from 'url';
import { submitAddresses, getStatus, fetchReport, purgeReport } from './handler.mjs';

const hostname = 'localhost';
const port = process.env.PORT;

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
    console.log(`server running at http://${hostname}:${port}/`);
});

fs.readFile('./index.html', (error, buffer) => {
    if (error) {
        throw error;
    }
    indexPage = buffer.toString();
    console.log('successfully loaded index.html');
});

