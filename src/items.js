/*
 * The items schema, based on jsonfeed
 */
// import {unescape} from 'html-escaper';

const SampleItem = {
    id: 0,
    read: false,
    feedTitle: "",
    feedId: 0,
    datePublished: null,
    contentHtml: "",
    url: "",
    imageUrl: "",
    title: "",
    tags: []
};

export const Store = "items";

// items is an array of item ids in ascending order
let items = [];
let reading = -1;
let known = -1;

// public apis
export {upgrade, load, length,
	readingCursor, knownCursor, forwardCursor, backwardCursor, unreadCount,
	markRead, getCurrentItem, deleteCurrentItem, pushItem,
	parseJSONItem, parseRSS2Item, parseATOMItem, oopsItem};

function oopsItem() {
    let item = new Object();
    item.datePublished = new Date();
    item.contentHtml = "If you see this, this feed failed loading";
    // just fake something to satisfy constrains
    item.url = Math.random().toString(36).substring(2, 15);
    item.title = "Oops...";
    item.tags = [];
    return item;
}

function parseJSONItem(json) {
    let item = new Object();
    item.datePublished = new Date(json.date_published);
    if (json.content_html !== undefined)
	item.contentHtml = json.content_html;
    else if (json.content_text !== undefined)
	item.contentHtml = '<p>' + json.content_text + '</p>';
    else
	return null;
    if (json.url)
	item.url = json.url;
    else
	return null;
    item.imageUrl = json.image;
    item.title = json.title;
    if (json.tags)
	item.tags = json.tags;
    else
	item.tags = [];
    return item;
}

function getXMLTextContent(elem, selector) {
    const sub = elem.querySelector(selector);
    if (sub)
	return sub.textContent.trim();
    else
	return null;
}

function getXMLTextAttribute(elem, selector, attr) {
    const sub = elem.querySelector(selector);
    if (sub)
	return sub.getAttribute(attr);
    else
	return null;
}

function parseRSS2Item(elem) {
    let item = new Object();
    const pubDate = getXMLTextContent(elem, "pubDate");
    const description = getXMLTextContent(elem, "description");
    // there is no way to select XML namespace.
    // Hopefully there is no other encoded than content:encoded
    const content = getXMLTextContent(elem, "*|encoded");
    const link = getXMLTextContent(elem, "link");
    const title = getXMLTextContent(elem, "title");
    const enclosure = getXMLTextAttribute(elem, "enclosure", "url");
    const enclosure_type = getXMLTextAttribute(elem, "enclosure", "type");
    const categories = elem.querySelectorAll("category");
    let tags = [];
    for (let category of categories.values()) {
	tags = [...tags, category.textContent];
    }
    if (pubDate)
	item.datePublished = new Date(pubDate);
    if (content)
	item.contentHtml = content;
    else if (description)
	item.contentHtml = description;
    else
	return null;
    if (enclosure_type) {
	const tokens = enclosure_type.split('/');
	if (tokens[0] == 'image')
	    item.imageUrl = enclosure;
    }
    if (link)
	item.url = link;
    else
	return null;
    if (title)
	item.title = title;
    item.tags = tags;
    return item;
}

function parseATOMItem(elem) {
    let item = new Object();
    const published = getXMLTextContent(elem, "published");
    const updated = getXMLTextContent(elem, "updated");
    const content = getXMLTextContent(elem, "content");
    const summary = getXMLTextContent(elem, "summary");
    const link = getXMLTextAttribute(elem, "link", "href");
    const alternate = getXMLTextAttribute(elem, "link[rel=alternate]", "href");
    const enclosure = getXMLTextAttribute(elem, "link[rel=enclosure]", "href");
    const enclosure_type = getXMLTextAttribute(elem, "link[rel=enclosure]", "type");
    const title = getXMLTextContent(elem, "title");
    const categories = elem.querySelectorAll("category");
    let tags = [];
    for (let category of categories.values()) {
	tags = [...tags, category.textContent];
    }
    if (published)
	item.datePublished = new Date(published);
    else if (updated)
	item.datePublished = new Date(updated);
    if (content)
	item.contentHtml = content;
    else if (summary)
	item.contentHtml = '<p>' + summary + '</p>';
    else
	throw null;
    if (enclosure_type) {
	const tokens = enclosure_type.split('/');
	if (tokens[0] == 'image')
	    item.imageUrl = enclosure;
    }
    if (alternate)
	item.url = alternate;
    else if (link)
	item.url = link;
    else
	return null;
    if (title)
	item.title = title;
    item.tags = tags;
    return item;
}

function readingCursor() {
    return reading;
}

function knownCursor() {
    return known;
}

function unreadCount() {
    return items.length - known - 1;
}

function forwardCursor() {
    if (reading >= items.length - 1)
	return false;
    reading ++;
    if (known < reading)
	known = reading;
    return true;
}

function backwardCursor() {
    if (reading <= 0)
	return false;
    reading --;
    return true;
}

function length() {
    return items.length;
}

async function markRead(db, item) {
    if (item.read)
	return;
    item.read = true;
    await db.put(Store, item);
}

function getCurrentItem(db) {
    if (reading >= 0)
	return db.get(Store, items[reading]);
    else
	return null;
}

async function deleteCurrentItem(db) {
    if (reading < 0)
	return false;
    await db.delete(Store, items[reading]);
    items = items.slice(0, reading).concat(items.slice(reading + 1));
    reading--;
    known--;
    return true;
}

async function pushItem(db, item) {
    // it may throw, which will be catch outside
    let id = await db.add(Store, item);
    items.push(id);
}

function upgrade(db) {
    // the store holds all the feeds
    let store = db.createObjectStore(
	Store, {keyPath: "id", autoIncrement: true});
    store.createIndex("url", "url", {unique: true});
}

async function load(db) {
    let store = await db.transaction(Store).store;
    let cursor = await store.openCursor();

    items = [];
    known = -1;
    while (cursor) {
	// items from the beginning up to a point are read
	if (cursor.value.read)
	    known ++;
	items.push(cursor.key);
	cursor = await cursor.continue();
    }
    // point both cursor at the last read item
    reading = known;
}
