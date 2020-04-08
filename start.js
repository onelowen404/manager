const SteamBrowser = require('./libs/SteamBrowser')
client = new SteamBrowser()
client.openAccount(process.argv[2])