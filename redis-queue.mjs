'use strict';

import {getRedis} from "./functions.mjs";

// wait the given time in milliseconds
export const sleep = async (millis) => {
    return new Promise((resolve) => {
        setTimeout(resolve, millis)
    })
}

// TODO remember to prefix this key with process.env.REDIS_PREFIX...
export const create_queue = (redis, key, delay) => {
    redis = getRedis(); // TODO remove this, just for auto-complete...

    let lastID = 0;
    const list = {};

    // constantly await for things to get queued up
    (async () => {
        while (true) {
            let item = redis.blPop(key, 60);
            if (item && list.hasOwnProperty(item)) {
                (list[item])();
                delete list[item];
                await sleep(delay);
            }
            if (list.hasOwnProperty('stop') && list.stop) {
                break;
            }
        }
    })();

    // second optional parameter, halt, if set true will instruct the queue to close
    return async (callback, halt) => {
        let item = 'a' + (++lastID);
        list[item] = callback;
        redis.rPush(key, item);
        if (typeof halt === "boolean" && halt) {
            list.stop = true;
        }

        // try to get a lock for processing, if you can't, it's because a processor is already running
        // if you get the lock, the process loop is.
        // while list not empty, pop item, run callback (in list, then remove it from the list), sleep for given delay, then repeat
        // if list is empty, release lock and stop.
    };
    /* this should return a function, which accepts a callback
     * whenever the function is called, it will add the given callback to the queue
     * if the queue is empty (and it's been *delay* time since previous), run it right away..
     *
     * I think when we go to queue up the given callback, we should also queue up a no-op delay/sleep function
     * that way the processing loop is very simple..
     *
     * I think a way to handle multiple processes, distributed computing, or actual serverless..
     * would be a lock, this queue processor grabs a lock (once there is content), runs till empty,
     * then unlocks..
     *
     * BLMove blocking list move.. take an item from "queued" list, and move it to the "processing" list,
     * once operation is successful, remove from processing, and move on
     * */
};