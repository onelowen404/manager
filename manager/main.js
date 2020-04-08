const electron = require("electron");
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;
const path = require('path')
const url = require('url')
let winOne;

function createWindow () {
  winOne = new BrowserWindow({width: 800, height: 600})

  winOne.loadURL(url.format({
    pathname: path.join(__dirname, 'one.html'),
    protocol: 'file:',
    slashes: true,
  }));
}

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (win === null) {
    createWindow();
  }
});
