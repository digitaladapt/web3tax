'use strict';

import fs from 'fs';
import http from 'http';
import {submitAddresses, getStatus, fetchReport, purgeReport, findRelated, donations} from './handler.mjs';
import { loadNodes } from "./functions.mjs";

const hostname = 'localhost';
const port = Number(process.env.PORT);

let indexPage = '';
let convertScript = '';

const server = http.createServer((req, res) => {
    res.statusCode = 200;
    const parsed = new URL(req.url, req.protocol + '://' + req.headers.host + '/');
    // make parsed "searchParams" a simple query object, like ""url.parse(<url>, true)"" used to do
    const query = {};
    parsed.searchParams.forEach((value, key) => {
        query[key] = value;
    });
    // parsed: {"pathname": "/path"}; query: {"key": "value"};

    // res.setHeader('Content-Type', 'application/json');
    // res.end(JSON.stringify(parsed));

    switch (parsed.pathname) {
        case '/':
        case '/index.html':
            res.setHeader('Content-Type', 'text/html');
            res.end(indexPage);
            break;
        case '/convert-address.js':
            res.setHeader('Content-Type', 'application/javascript');
            res.end(convertScript);
            break;
        case '/generate':
            console.log('generate|' + Date.now() + '|' + JSON.stringify(query));
            res.setHeader('Content-Type', 'application/json');
			submitAddresses({
                queryStringParameters: query,
            }, null, (error, output) => {
                res.end(output.body);
            });
            break;
        case '/guess':
            res.setHeader('Content-Type', 'application/json');
            findRelated({
                queryStringParameters: query,
            }).then((output) => {
                res.end(output.body);
            });
            break;
        case '/donations':
            donations({
                queryStringParameters: query,
            }).then((output) => {
                res.end(output.body);
            });
            break;
        case '/status':
            res.setHeader('Content-Type', 'application/json');
			getStatus({
                queryStringParameters: query,
            }).then((output) => {
                res.end(output.body);
            });
            break;
        case '/report':
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader("Content-Disposition", "attachment;filename=web3tax-info.csv");
			fetchReport({
                queryStringParameters: query,
            }).then((output) => {
                res.end(output.body);
            });
            break;
        case '/clear':
            res.setHeader('Content-Type', 'application/json');
			purgeReport({
                queryStringParameters: query,
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

fs.readFile('./convert-address.js', (error, buffer) => {
    if (error) {
        throw error;
    }
    convertScript = buffer.toString();
    console.log('successfully loaded convert-address.js');
});

await loadNodes('chihuahua');
await loadNodes('cerberus');