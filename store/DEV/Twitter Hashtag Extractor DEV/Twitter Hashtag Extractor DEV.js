// Phantombuster configuration {
"phantombuster command: nodejs"
"phantombuster package: 5"
"phantombuster dependencies: lib-StoreUtilities.js, lib-Twitter.js"
"phantombuster flags: save-folder"

const Buster = require("phantombuster")
const buster = new Buster()

const Nick = require("nickjs")
const nick = new Nick({
	loadImages: true,
	printPageErrors: false,
	printResourceErrors: false,
	printNavigation: false,
	printAborts: false,
	debug: false,
})

const { URL } = require("url")

const StoreUtilities = require("./lib-StoreUtilities")
const utils = new StoreUtilities(nick, buster)

const Twitter = require("./lib-Twitter")
const twitter = new Twitter(nick, buster, utils)

const DB_NAME = "result"
const DEFAULT_POSTS_COUNT = 25
const SEARCH_URL = "https://twitter.com/search?f=tweets&q="
// }

/**
 * @param {String} hashtag
 * @return {String|null}
 */
const getSearchUrl = hashtag => {
	try {
		let url = new URL(SEARCH_URL)
		url.searchParams.set("q", hashtag)
		return url.toString()
	} catch (err) {
		return null
	}
}

const isUrl = url => {
	try {
		return (new URL(url)).hostname !== null
	} catch (err) {
		return false
	}
}

/**
 * @async
 * @param {Object} tab
 * @param {String} url
 * @return {Promise<Boolean>}
 */
const loadPage = async (tab, url) => {
	const [ httpCode ] = await tab.open(url)
	const selectors = [ "div#timeline.content-main", "div.SearchEmptyTimeline" ]
	let canScrape = false

	if (httpCode === 404 || !httpCode) {
		utils.log(`Can't open ${url}`, "warning")
		return canScrape
	}
	try {
		const res = await tab.waitUntilVisible(selectors, 15000, "or")
		if (res === selectors[0]) {
			canScrape = true
		}
	} catch (err) {
		return canScrape
	}
	return canScrape
}

const getLoadedTweetsCount = (arg, cb) => cb(null, document.querySelectorAll("div.tweet.js-actionable-tweet").length)

/**
 * @param {{ prevCount: number }} arg
 * @param {Function} cb
 * @return {Promise<String|null>} "DONE" string is returned when the bot has reached the end of the timeline
 */
const waitWhileLoading = (arg, cb) => {
	const startTimestamp = Date.now()
	const idle = () => {
		const loadedTweets = document.querySelectorAll("div.tweet.js-actionable-tweet").length
		if (!document.querySelector(".timeline-end").classList.contains("has-more-items")) {
			cb(null, "DONE")
		} else if (loadedTweets <= arg.prevCount) {
			if (Date.now() - startTimestamp >= 30000) {
				return cb("No tweets loaded after 30s")
			}
			setTimeout(idle, 200)
		} else {
			return cb(null)
		}

	}
	idle()
}

const scrapeTweets = (arg, cb) => {
	const scraper = (el) => {
		const res = {}
		res.tweetUrl = `https://www.twitter.com${el.dataset.permalinkPath}`
		res.twitterProfile = (el.querySelector("a.js-user-profile-link")) ? el.querySelector(".js-user-profile-link").href : null
		res.timestamp = (new Date()).toISOString()
		return res
	}
	cb(null, [ ...document.querySelectorAll("div.tweet.js-actionable-tweet")].map(el => scraper(el)))
}

/**
 * @async
 * @param {Object} tab
 * @param {Number} [maxCount]
 * @return {Promise<Array<Object>>}
 */
const extractTweets = async (tab, maxCount = DEFAULT_POSTS_COUNT) => {
	let res = []
	let tweetsCount = 0

	tweetsCount = await tab.evaluate(getLoadedTweetsCount)
	while (tweetsCount < maxCount) {
		utils.log(`${tweetsCount} tweets loaded`, "loading")
		await tab.scrollToBottom()
		try {
			const state = await tab.evaluate(waitWhileLoading, { prevCount: tweetsCount })
			if (state === "DONE") {
				break
			}
		} catch (err) {
			utils.log(`Error while loading tweets: ${err.message || err}`, "warning")
			break
		}
		tweetsCount = await tab.evaluate(getLoadedTweetsCount)
	}
	res.push(...await tab.evaluate(scrapeTweets))
	res = res.slice(0, maxCount)
	return res
}

;(async () => {
	const tab = await nick.newTab()
	const res = []
	let { spreadsheetUrl, columnName, numberOfPostsPerLaunch, csvName, queries, noDatabase } = utils.validateArguments()

	if (!csvName) {
		csvName = DB_NAME
	}

	if (typeof numberOfPostsPerLaunch !== "number") {
		numberOfPostsPerLaunch = DEFAULT_POSTS_COUNT
	}

	if (spreadsheetUrl) {
		queries = isUrl(spreadsheetUrl) ? await utils.getDataFromCsv(spreadsheetUrl, columnName) : [ spreadsheetUrl ]
	}

	if (typeof queries === "string") {
		queries = [ queries ]
	}
	const db = noDatabase ? [] : await utils.getDb(csvName + ".csv")
	// TODO: LPL behaviour or TAL behaviour ?
	/*queries = queries.filter(el => db.findIndex(line => el === line.query) < 0)

	if (queries.length < 1) {
		utils.log("Input is empty OR every queries provided", "warning")
		nick.exit()
	}*/

	utils.log(`Hashtags to scrape: ${JSON.stringify(queries, null, 2)}`, "done")
	for (const query of queries) {
		const timeLeft = await utils.checkTimeLeft()
		if (!timeLeft.timeLeft) {
			utils.log(timeLeft.message, "warning")
			break
		}
		utils.log(`Scraping ${query}`, "info")
		const searchUrl = getSearchUrl(query)
		if (!searchUrl) {
			utils.log(`Can't create a twitter search URL, skipping ${query}`, "warning")
			continue
		}
		const isOpen = await loadPage(tab, searchUrl)
		if (!isOpen) {
			res.push({ query, error: `Can't search ${query}` })
			await tab.screenshot(`err-${Date.now()}.jpg`)
			continue
		}
		res.push(...await extractTweets(tab, numberOfPostsPerLaunch))
	}
	db.push(...utils.filterRightOuter(db, res))
	await utils.saveResults(res, db, csvName, null)
	nick.exit()
})()
.catch(err => {
	utils.log(`API execution error: ${err.message || err}`, "error")
	console.log(err.stack || err)
	nick.exit(1)
})