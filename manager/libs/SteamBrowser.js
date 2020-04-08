const puppeteer = require('puppeteer')
const fs = require('fs')
const util = require('util')
const readFile = util.promisify(fs.readFile)
const writeFile = util.promisify(fs.writeFile)

class SteamBrowser{
    constructor() {
        this.browser = null
        this.page = null
        this.user = null
        this.headless = false
        this.windows = {
            width: 800,
            height: 640
        }
        this.links = {
            login: 'https://steamcommunity.com/login/',
            steam: 'https://steamcommunity.com/',
            response: 'https://steamcommunity.com/login/dologin/',
        }
    }

    async openBrowser() {
        try {
            this.browser = await puppeteer.launch({
                headless: this.headless,
                defaultViewport: {
                    width: this.windows.width,
                    height: this.windows.height,
                },
                args: ['--no-sandbox']
            });
            this.page = await this.browser.newPage();
            this.response()
        } catch (e) {
            console.error(e);
        }
    }

    async openAccount(login) {
        this.headless = false
        await this.openBrowser()
        var cookiesFile = await readFile(`/var/bot/cookies/${login}.json`, 'utf8')
        var cookie = await JSON.parse(cookiesFile)
        await this.page.setCookie(...cookie)
        await this.page.goto(this.links.steam)
    }

    async login(options) {
        this.user = {
            login: options.login,
            password: options.password
        }
        await this.openBrowser()
        try{
            await this.page.goto(this.links.login)
        } catch (e) {
            console.log('Ошибка открытия страницы. Невалидные прокси либо ошибка сети.')
        }
        await this.page.waitForSelector('#steamAccountName')
        await this.page.type('#steamAccountName', this.user.login)
        await this.page.type('#steamPassword', this.user.password)
        await this.page.click('#SteamLogin')
    }

    async tfaCode(code) {
        try {
        await this.page.waitForSelector('#twofactorcode_entry')
        await this.page.type('#twofactorcode_entry', code)
        } catch (e) {
                
        }
        try {
            await this.page.click('#login_twofactorauth_buttonset_entercode [data-modalstate="submit"]')
        } catch (e) {
            await this.page.click('#login_twofactorauth_buttonset_incorrectcode [data-modalstate="submit"]')
        }
    }

    async guardCode(code) {
        try{
            await this.page.waitForSelector('#authcode')
            await this.page.type('#authcode', code)
        } catch (e) {

        }
        
        try {
            await this.page.click('#auth_buttonset_entercode [data-modalstate="submit"]')
        } catch (e) {
            await this.page.click('#auth_buttonset_incorrectcode [data-modalstate="submit"]')
        }
    }

    async response() {
        await this.page.on('response', resp => {
            if (resp.url() == this.links.response) {
                (async () => {
                    var respJSON = await resp.json()
                    if(respJSON.message != ''){
                        if(respJSON.message == 'За последнее время в вашей сети произошло слишком много безуспешных попыток входа. Пожалуйста, подождите и повторите попытку позже.'){
                            await this.close()
                        }
                        console.log(respJSON.message)
                    }
                    if(respJSON.captcha_needed){
                        await this.close()
                        console.log('Captcha')
                    }
                    
                    if (respJSON.success) {
                        this.cookies = await this.page.cookies()
                        await this.saveCookies()
                        await this.close()
                    } else {
                        if (respJSON.emailauth_needed) {
                            console.log('guard')
                        } else if(respJSON.requires_twofactor) {
                            console.log('2fa')
                        }
                    }
                })()
            } 
        })
    }

    async saveCookies() {
        var cookieFile = `./cookies/${this.user.login}.json`
        fs.writeFile(cookieFile, JSON.stringify(this.cookies), function(err) {
            if(err) {
                return console.log(err);
            }
            this.cookiesFile = cookieFile
        }); 
    }

    async close() {
        try {
            await this.page.close();
            await this.browser.close();
        } catch (e) {
            console.error('browser already closed');
        }
    }

}

module.exports = SteamBrowser