/*
 * The model layer of AirSS. I handle all the data fatching and idb manipulation
 * The controller layer calls my functions, which are all async to get infos
 * I don't call other layers; If I have something to say I post a custom event
 * to the root document
 */

import {openDB, deleteDB} from 'idb';
import * as Feeds from './feeds.js';
import * as Items from './items.js';
import * as Loader from './loader.js';

// exported client side functions. all return promises or null
export {currentState, shutdown, clearData, warn,
	forwardItem, backwardItem, deleteItem, currentItem,
	subscribe, unsubscribe,
	getLoadCandidate, addFeed, deleteFeed, addItems, fetchFeed, updateFeed};

// when the cursor is this close to the end I load more
const WaterMark = localStorage.getItem("WATER_MARK") || 10;

// the minimal elapsed time before a reload, in hour
const MinReloadWait = localStorage.getItem("MIN_RELOAD_WAIT") || 12;

// kept in days
const MaxKeptPeriod = localStorage.getItem("MAX_KEPT_PERIOD") || 180;

// events I post to the document from the callback side
function emitModelAlert(type, text) {
    window.document.dispatchEvent(new CustomEvent(
	"AirSSModelAlert",
	{detail: {type, text}}
    ));
}

function emitModelWarning(text) {
    console.warn(text);
    emitModelAlert("warning", text);
}

function emitModelError(text) {
    console.error(text);
    emitModelAlert("error", text);
}

function emitModelInfo(text) {
    console.info(text);
    emitModelAlert("info", text);
}

function emitModelItemsLoaded(info) {
    console.info("Items loaded. cursor at: " + info.cursor +
		" length: " + info.length);
    window.document.dispatchEvent(new CustomEvent(
	"AirSSModelItemsLoaded",
	{detail: info}
    ));
}

function emitModelInitDone() {
    window.document.dispatchEvent(new Event("AirSSModelInitDone"));
}

function emitModelShutDown() {
    window.document.dispatchEvent(new Event("AirSSModelShutDown"));
}

/*
 * callback side state and entry points
 */

let db = null;

// the shutdown callback
async function cb_shutdown(prev) {
    await prev;
    await db.close();
    // so database is safe. future db operation will crash
    db = null;
    emitModelShutDown();
}

async function cb_warn(prev, msg) {
    await prev;
    emitModelWarning(msg);
}

async function cb_clearData(prev) {
    await prev;
    console.info("deleting database");
    await db.close();
    await deleteDB("AirSS");
    console.info("database deleted");
    db = null;
}

async function cb_subscribe(prev, url) {
    await prev;
    // we have to make sure init is done
    Loader.subscribe(url);
}

async function cb_currentItem(prev) {
    await prev;
    let item = await Items.getCurrentItem(db);
    Loader.load();
    return item;
}

async function cb_forwardItem(prev) {
    await prev;
    if (!Items.forwardCursor()) {
	emitModelWarning("Already at the end");
	return null;
    }
    let item = await Items.getCurrentItem(db);
    Loader.load();
    return item;
}

async function cb_backwardItem(prev) {
    await prev;
    if (!Items.backwardCursor()) {
	emitModelWarning("Already at the beginning");
	return null;
    }
    return Items.getCurrentItem(db);
}

async function cb_deleteItem(prev) {
    await prev;
    return Items.deleteCurrentItem(db);
}

async function cb_loadMore(prev) {
    await prev;
    if (shouldLoadMore()) {
	await loadMore();
    }
}

async function cb_markRead(prev) {
    let item = await prev;
    // we know for sure that item is the current item
    if (item)
	await Items.markRead(db, item);
}

async function cb_unsubscribe(prev, id) {
    await prev;
    try {
	await Feeds.removeFeed(db, id);
	emitModelInfo("Feed unsubscribed");
    } catch (e) {
	if (e instanceof DOMException) {
	    emitModelError("Feed not found");
	} else {
	    throw e;
	}
    }
}

async function cb_addFeed(prev, feed) {
    await prev;
    if (feed.error) {
	emitModelError("The feed '" + feed.feedUrl +
		       "' is not valid");
	console.error("The feed '" + feed.feedUrl +
		      "' is not valid: " + feed.error);
	return;
    }
    try {
	// if the feed come in with an id then it is from airtable
	let newFeed = (feed.id === undefined);
	let id = await Feeds.addFeed(db, feed);
	console.info("added feed " + feed.feedUrl + " with id: " + id);
	if (newFeed) {
	    emitModelInfo("The feed '" + feed.feedUrl + "' is now subscribed");
	}
    } catch (e) {
	if (e instanceof DOMException) {
	    emitModelError("The feed '" + feed.feedUrl +
			   "' is already subscribed");
	} else {
	    throw e;
	}
    }
}

async function cb_deleteFeed(prev, id) {
    await prev;
    return Feeds.deleteFeed(db, id);
}

async function cb_fetchFeed(prev, id) {
    await prev;
    return Feeds.get(db, id);
}

async function cb_addItems(prev, items) {
    await prev;
    let cnt = 0;
    for (let item of items.values()) {
	try {
	    await Items.addItem(db, item);
	    cnt ++;
	} catch (e) {
	    if (e instanceof DOMException) {
		// it is common that an item cannot be add
	    } else {
		throw e;
	    }
	}
    }
    if (cnt > 0)
	emitModelItemsLoaded({
	    length: Items.length(),
	    cursor: Items.readingCursor()
    });
}

function oopsItem(feed) {
    let item = new Object();
    item.datePublished = new Date();
    item.contentHtml = "If you see this, this feed '" + feed.feedUrl +
	"' failed loading:" +
	"Check the console for the detail error.";
    // just fake something to satisfy constrains
    item.url = Math.random().toString(36).substring(2, 15);
    item.title = "Oops...";
    item.tags = ["_error"];
    item.feedTitle = feed.title;
    item.feedId = feed.id;
    return item;
}

function dummyItem(feed) {
    let item = new Object();
    item.datePublished = new Date();
    item.contentHtml = "If you see this, this feed '" + feed.feedUrl +
	"' hasn't been updated for " + MaxKeptPeriod +
	" days. There is nothing wrong, just too quiet.";
    // just fake something to satisfy constrains
    item.url = Math.random().toString(36).substring(2, 15);
    item.title = "Errrr...";
    item.tags = ["_error"];
    item.feedTitle = feed.title;
    item.feedId = feed.id;
    return item;
}

async function cb_updateFeed(prev, feed, items) {
    await prev;
    let oldCount = Items.length();
    let now = new Date();
    // push items in reverse order
    for(let i = items.length - 1; i>= 0; i--) {
	try {
	    await Items.pushItem(db, items[i]);
	} catch(e) {
	    if (e instanceof DOMException) {
		// it is common that an item cannot be add
	    } else {
		throw e;
	    }
	}
    }
    let num = Items.length() - oldCount;
    console.info("loaded feed '" + feed.feedUrl + "' with " + num + " of " + items.length + " items");

    if (feed.error) {
	emitModelError("The feed '" + feed.feedUrl +
		       "' faild to load");
	console.error("The feed '" + feed.feedUrl +
		       "' faild to load: " + feed.error);
	await Items.pushItem(db, oopsItem(feed));
	delete feed.error;
	num ++;
    } else if (num == 0 &&
	       feed.lastLoadTime < now - MaxKeptPeriod*24*3600*1000) {
	await Items.pushItem(db, dummyItem(feed));
	num ++;
    }
    feed.lastLoadTime = now;
    if (num > 0) {
	await Feeds.updateFeed(db, feed);
	emitModelItemsLoaded({
	    length: Items.length(),
	    cursor: Items.readingCursor()
	});
    } else {
	await Feeds.touchFeed(db, feed);
    }
    Loader.load();
}

async function cb_getLoadCandidate(prev) {
    await prev;
    if (Items.unreadCount() >= WaterMark)
	return null;
    let feedId = Feeds.first();
    if (!feedId)
	return null;
    let now = new Date();
    let feed = await Feeds.get(db, feedId);
    if (feed.lastLoadTime > now - MinReloadWait * 3600 * 1000)
	return null;
    Feeds.rotate();
    return feed;
}

/*
 * internal functions of the callback side
 */
async function init() {
    db = await openDB("AirSS", 1, {
	upgrade(db) {
 	    Feeds.upgrade(db);
	    Items.upgrade(db);
	},
    });
    let feedIds = await Feeds.load(db);
    let itemIds = await Items.load(db);
    emitModelItemsLoaded({
	length: Items.length(),
	cursor: Items.readingCursor()
    });
    // this is going to take a while and will use the model so we cannot await
    // also this need to be called before the controller has any chance to load anything
    Loader.loadAirtable(feedIds, itemIds);
    emitModelInitDone();
}

/*
 * Client side state which is a promise
 * any client side function will await and replace the state
 */
let state = init();

// return the current state so client and await me
function currentState() {
    return state;
}

// clear all local data. return a promise that resolve to null
// when everything initialized.
function clearData() {
    state = cb_clearData(state);
    return state;
}

// print a warning
function warn(msg) {
    state = cb_warn(state, msg);
    return state;
}

// forward the item cursor. return a promise that resolve to a item
// to display, or null if nothing changed
function forwardItem() {
    let value = state = cb_forwardItem(state);
    // to piggy back marking and loading here
    state = cb_markRead(state);
    return value;
}

// backward the item cursor. return a promise that resolve to a item
// to display or null if nothing changed
function backwardItem() {
    state = cb_backwardItem(state);
    return state;
}

// delete the item under cursor. 
// return a promise that resolve to true/false
function deleteItem() {
    state = cb_deleteItem(state);
    return state;
}

// just load the current item, if any
function currentItem() {
    let value = state = cb_currentItem(state);
    return value;
}

// subscribe to a feed url
function subscribe(url) {
    state = cb_subscribe(state, url);
    return state;
}

// unsubscribe a feed by id
function unsubscribe(id) {
    state = cb_unsubscribe(state, id);
}

// add a feed. this is for the callback from subscribe
function addFeed(feed) {
    state = cb_addFeed(state, feed);
}

// delete a feed by id. do not touch airtable
function deleteFeed(id) {
    state = cb_deleteFeed(state, id);
}

// add a item. this is for the callback from loading the airtable
function addItems(items) {
    state = cb_addItems(state, items);
}

// update a feed with new data. this is for the callback from load
function updateFeed(feed, items) {
    state = cb_updateFeed(state, feed, items);
}

// return a feed to load, or null if no such candidate is found
function getLoadCandidate() {
    state = cb_getLoadCandidate(state);
    return state;
}

// return a single feed fetched from the db
function fetchFeed(id) {
    state = cb_fetchFeed(state, id);
    return state;
}

function shutdown() {
    state = cb_shutdown(state);
    return state;
}
